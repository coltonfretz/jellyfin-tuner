using Jellyfin.Plugin.Tuner.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Tuner.Api;

/// <summary>
/// The Books page (books.js). Every call needs a signed-in Jellyfin user; anyone signed in
/// may add books ("Get it"), up to the daily allowance in the settings. The Hardcover token
/// and the Bookshelf key never leave the server.
/// </summary>
[ApiController]
[Route("Tuner/books")]
[Authorize]
public class BooksController : ControllerBase
{
    private readonly BooksService _books;
    private readonly ILogger<BooksController> _logger;

    public BooksController(BooksService books, ILogger<BooksController> logger)
    {
        _books = books;
        _logger = logger;
    }

    private string UserName => User.Identity?.Name ?? User.FindFirst("Jellyfin-UserId")?.Value ?? "unknown";

    /// <summary>The front of the page: your library's newest books and two shelves from Hardcover.</summary>
    [HttpGet("home")]
    public Task<ActionResult> Home(CancellationToken ct) => Guarded(async () =>
    {
        // Each shelf on its own: one failing (Hardcover slow, Bookshelf restarting) still shows the rest.
        var shelves = new List<Shelf>();
        try
        {
            var recent = await _books.RecentAsync(30, ct).ConfigureAwait(false);
            var cards = await _books.CardsAsync(recent, ct).ConfigureAwait(false);
            if (cards.Count > 0)
            {
                shelves.Add(new Shelf("library", "In the library", cards));
            }
        }
        catch (Exception ex) when (IsSourceProblem(ex))
        {
            _logger.LogWarning("Books: library shelf failed: {Message}", ex.Message);
        }

        foreach (var (key, title) in new[] { ("new", "Popular new books"), ("loved", "Most read") })
        {
            try
            {
                shelves.Add(new Shelf(key, title, await _books.ShelfAsync(key, ct).ConfigureAwait(false)));
            }
            catch (Exception ex) when (IsSourceProblem(ex))
            {
                _logger.LogWarning("Books: {Shelf} shelf failed: {Message}", key, ex.Message);
            }
        }

        var ids = shelves.SelectMany(s => s.Books).Select(b => b.Id);
        return Ok(new { enabled = true, read = BooksService.ReadBase != null, shelves, states = await SafeStates(ids, ct).ConfigureAwait(false) });
    });

    [HttpGet("search")]
    public Task<ActionResult> Search([FromQuery] string? q, CancellationToken ct) => Guarded(async () =>
    {
        if (string.IsNullOrWhiteSpace(q))
        {
            return Ok(new { books = Array.Empty<BookCard>(), states = new Dictionary<int, BookState>() });
        }

        var books = await _books.SearchAsync(q, ct).ConfigureAwait(false);
        return Ok(new { books, states = await SafeStates(books.Select(b => b.Id), ct).ConfigureAwait(false) });
    });

    [HttpGet("{id:int}")]
    public Task<ActionResult> Book(int id, CancellationToken ct) => Guarded(async () =>
    {
        var book = await _books.DetailAsync(id, ct).ConfigureAwait(false);
        if (book == null)
        {
            return NotFound(new { message = "That book isn't in the catalog." });
        }

        var states = await SafeStates(new[] { id }, ct).ConfigureAwait(false);
        return Ok(new { book, state = states.GetValueOrDefault(id), read = ReadLink(book) });
    });

    /// <summary>States for the books on screen, polled while something is on its way.</summary>
    [HttpGet("states")]
    public Task<ActionResult> States([FromQuery] string? ids, CancellationToken ct) => Guarded(async () =>
    {
        var list = (ids ?? string.Empty).Split(',', StringSplitOptions.RemoveEmptyEntries)
            .Select(s => int.TryParse(s, out var i) ? i : 0).Where(i => i > 0).Take(200);
        return Ok(await _books.StatesAsync(list, ct).ConfigureAwait(false));
    });

    [HttpPost("{id:int}/get")]
    public Task<ActionResult> Get(int id, CancellationToken ct) => Guarded(async () =>
    {
        var (ok, message) = await _books.GetAsync(id, UserName, ct).ConfigureAwait(false);
        if (!ok)
        {
            return StatusCode(409, new { message });
        }

        var states = await SafeStates(new[] { id }, ct).ConfigureAwait(false);
        return Ok(new { message, state = states.GetValueOrDefault(id) ?? new BookState { State = "searching" } });
    });

    [HttpPost("{id:int}/retry")]
    public Task<ActionResult> Retry(int id, CancellationToken ct) => Guarded(async () =>
    {
        var (ok, message) = await _books.RetryAsync(id, UserName, ct).ConfigureAwait(false);
        return ok ? Ok(new { message }) : StatusCode(409, new { message });
    });

    // The Read button opens the reading site's search for the title. WHY a search and not the
    // book's own page: the reader (Calibre-Web) numbers books itself and only gets the file
    // minutes after the download, so there's no id to link to yet.
    private static string? ReadLink(BookDetail book)
    {
        var read = BooksService.ReadBase;
        return read == null ? null : $"{read}/search?query={Uri.EscapeDataString(book.Title)}";
    }

    // States come from Bookshelf; if it's down, the catalog still works without them.
    private async Task<Dictionary<int, BookState>> SafeStates(IEnumerable<int> ids, CancellationToken ct)
    {
        try
        {
            return await _books.StatesAsync(ids, ct).ConfigureAwait(false);
        }
        catch (Exception ex) when (IsSourceProblem(ex))
        {
            _logger.LogWarning("Books: couldn't read Bookshelf: {Message}", ex.Message);
            return new Dictionary<int, BookState>();
        }
    }

    private async Task<ActionResult> Guarded(Func<Task<ActionResult>> action)
    {
        if (!BooksService.Enabled)
        {
            return Ok(new { enabled = false });
        }

        try
        {
            return await action().ConfigureAwait(false);
        }
        catch (Exception ex) when (IsSourceProblem(ex))
        {
            _logger.LogWarning("Books: {Message}", ex.Message);
            return StatusCode(502, new { message = "The book catalog isn't answering right now. Try again in a minute." });
        }
    }

    public sealed record Shelf(string Key, string Title, List<BookCard> Books);

    private static bool IsSourceProblem(Exception ex) =>
        ex is BooksException or HttpRequestException or TaskCanceledException or System.Text.Json.JsonException or InvalidOperationException;
}
