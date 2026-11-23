using Jellyfin.Data;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.Tuner.Services;
using MediaBrowser.Controller.Library;
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
    private readonly IUserManager _users;
    private readonly ILogger<BooksController> _logger;

    public BooksController(BooksService books, IUserManager users, ILogger<BooksController> logger)
    {
        _books = books;
        _users = users;
        _logger = logger;
    }

    // Jellyfin's own JSON settings write C# names as they are (Title, Books), while the page
    // reads camelCase like the rest of the plugin's endpoints. Found live 2026-11-23: every
    // shelf was "empty" and book pages had no title. So Books always answers in web style.
    private static readonly System.Text.Json.JsonSerializerOptions WebJson = new(System.Text.Json.JsonSerializerDefaults.Web);

    private static JsonResult Json(object value) => new(value, WebJson);

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
        return Json(new { enabled = true, read = BooksService.ReadBase != null, shelves, states = await SafeStates(ids, ct).ConfigureAwait(false) });
    });

    [HttpGet("search")]
    public Task<ActionResult> Search([FromQuery] string? q, CancellationToken ct) => Guarded(async () =>
    {
        if (string.IsNullOrWhiteSpace(q))
        {
            return Json(new { books = Array.Empty<BookCard>(), states = new Dictionary<int, BookState>() });
        }

        var all = await _books.SearchAsync(q, ct).ConfigureAwait(false);
        var states = await SafeStates(all.Select(b => b.Id), ct).ConfigureAwait(false);
        var books = BooksService.OnePerBook(all, states.Keys);
        return Json(new { books, states });
    });

    /// <summary>One author's books, most read first (the "by ..." link on a book page).</summary>
    [HttpGet("author/{id:int}")]
    public Task<ActionResult> Author(int id, CancellationToken ct) => Guarded(async () =>
    {
        var (name, all) = await _books.AuthorAsync(id, ct).ConfigureAwait(false);
        var states = await SafeStates(all.Select(b => b.Id), ct).ConfigureAwait(false);
        return Json(new { name, books = BooksService.OnePerBook(all, states.Keys), states });
    });

    [HttpGet("{id:int}")]
    public Task<ActionResult> Book(int id, CancellationToken ct) => Guarded(async () =>
    {
        var book = await _books.DetailAsync(id, ct).ConfigureAwait(false);
        if (book == null)
        {
            return new JsonResult(new { message = "That book isn't in the catalog." }, WebJson) { StatusCode = 404 };
        }

        var states = await SafeStates(new[] { id }, ct).ConfigureAwait(false);
        return Json(new { book, state = states.GetValueOrDefault(id), read = ReadLink(book) });
    });

    /// <summary>States for the books on screen, polled while something is on its way.</summary>
    [HttpGet("states")]
    public Task<ActionResult> States([FromQuery] string? ids, CancellationToken ct) => Guarded(async () =>
    {
        var list = (ids ?? string.Empty).Split(',', StringSplitOptions.RemoveEmptyEntries)
            .Select(s => int.TryParse(s, out var i) ? i : 0).Where(i => i > 0).Take(200);
        return Json(await _books.StatesAsync(list, ct).ConfigureAwait(false));
    });

    [HttpPost("{id:int}/get")]
    public Task<ActionResult> Get(int id, CancellationToken ct) => Guarded(async () =>
    {
        var (ok, message) = await _books.GetAsync(id, UserName, ct).ConfigureAwait(false);
        if (!ok)
        {
            return new JsonResult(new { message }, WebJson) { StatusCode = 409 };
        }

        var states = await SafeStates(new[] { id }, ct).ConfigureAwait(false);
        return Json(new { message, state = states.GetValueOrDefault(id) ?? new BookState { State = "searching" } });
    });

    [HttpPost("{id:int}/replace")]
    public Task<ActionResult> Replace(int id, CancellationToken ct) => Guarded(async () =>
    {
        var (ok, message) = await _books.ReplaceAsync(id, UserName, ct).ConfigureAwait(false);
        if (!ok)
        {
            return new JsonResult(new { message }, WebJson) { StatusCode = 409 };
        }

        return Json(new { message, state = new BookState { State = "searching" } });
    });

    [HttpPost("{id:int}/retry")]
    public Task<ActionResult> Retry(int id, CancellationToken ct) => Guarded(async () =>
    {
        var (ok, message) = await _books.RetryAsync(id, UserName, ct).ConfigureAwait(false);
        return new JsonResult(new { message }, WebJson) { StatusCode = ok ? 200 : 409 };
    });

    /// <summary>
    /// The Read button's address with a one-time ticket that signs you in to the reading site as
    /// your Jellyfin name (see BooksService.MintTicket). next is the reader page to land on.
    /// </summary>
    [HttpPost("read")]
    public ActionResult Read([FromQuery] string? next)
    {
        var read = BooksService.ReadBase;
        if (!BooksService.Enabled || read == null)
        {
            return Json(new { enabled = false });
        }

        // Only a path on the reading site: never a way to send someone elsewhere.
        if (string.IsNullOrEmpty(next) || next[0] != '/' || next.StartsWith("//", StringComparison.Ordinal) || next.Contains('\\'))
        {
            next = "/";
        }

        // The name from the account itself, not the request: it becomes a login on the reader.
        var id = Guid.TryParse(User.FindFirst("Jellyfin-UserId")?.Value, out var g) ? g : Guid.Empty;
        var name = id == Guid.Empty ? null : _users.GetUserById(id)?.Username;
        if (string.IsNullOrWhiteSpace(name))
        {
            return new JsonResult(new { message = "Couldn't tell who you are. Sign in again." }, WebJson) { StatusCode = 401 };
        }

        var ticket = BooksService.MintTicket(name, id);
        return Json(new { url = $"{read}/_fretzflix/sso?t={ticket}&next={Uri.EscapeDataString(next)}" });
    }

    /// <summary>
    /// For the reading site's gatekeeper, server to server: who a ticket belongs to. Anonymous
    /// because the gatekeeper has no Jellyfin login; a ticket is 256 random bits, works once and
    /// for 60 seconds, so there is nothing to guess.
    /// </summary>
    [HttpGet("redeem")]
    [AllowAnonymous]
    public ActionResult Redeem([FromQuery] string? t)
    {
        // Only for the gate, which calls Jellyfin's in-cluster address directly. Anything that
        // came through a proxy (every request from the internet, and the home name) carries
        // forwarding headers, and anything else must come from a private address. WHY: nobody
        // but the gate should trade a ticket, so a ticket that leaks in a screenshot or a
        // pasted link can't be used by whoever holds it (review, 2026-11-23).
        if (!FromInside())
        {
            _logger.LogInformation("Books: refused a ticket redeem from outside the cluster");
            return new JsonResult(new { message = "Unknown or used ticket." }, WebJson) { StatusCode = 404 };
        }

        if (BooksService.RedeemTicket(t) is not { } who)
        {
            return new JsonResult(new { message = "Unknown or used ticket." }, WebJson) { StatusCode = 404 };
        }

        _logger.LogInformation("Books: {User} opened the reading site", who.User);
        return Json(new { user = who.User, id = who.Id.ToString("N") });
    }

    /// <summary>
    /// For the reading site's gatekeeper, server to server, about once an hour per person: is
    /// this account still here and allowed in, and under what name? WHY: its sign-in cookie
    /// would otherwise keep working after an account is deleted or disabled (review,
    /// 2026-11-23). Inside-only like Redeem; answers nothing but yes/no and the name.
    /// </summary>
    [HttpGet("who")]
    [AllowAnonymous]
    public ActionResult Who([FromQuery] string? id)
    {
        if (!FromInside())
        {
            return new JsonResult(new { message = "Not here." }, WebJson) { StatusCode = 404 };
        }

        var user = Guid.TryParse(id, out var g) ? _users.GetUserById(g) : null;
        var ok = user != null && !user.HasPermission(PermissionKind.IsDisabled);
        return Json(new { ok, user = ok ? user!.Username : null });
    }

    // The Read button opens the reading site's search for the title. WHY a search and not the
    // book's own page: the reader (Calibre-Web) numbers books itself and only gets the file
    // minutes after the download, so there's no id to link to yet.
    private static string? ReadLink(BookDetail book)
    {
        var read = BooksService.ReadBase;
        if (read == null)
        {
            return null;
        }

        // fz_author: the reader's own search ignores it; the gate uses it to tell two books with
        // the same title apart (two "It"s) when it opens the book for you.
        var author = (book.Authors ?? string.Empty).Split(", ")[0].Split(" and ")[0].Trim();
        return $"{read}/search?query={Uri.EscapeDataString(book.Title)}"
            + (author.Length > 0 ? $"&fz_author={Uri.EscapeDataString(author)}" : string.Empty);
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
            return Json(new { enabled = false });
        }

        try
        {
            return await action().ConfigureAwait(false);
        }
        catch (Exception ex) when (IsSourceProblem(ex))
        {
            _logger.LogWarning("Books: {Message}", ex.Message);
            return new JsonResult(new { message = "The book catalog isn't answering right now. Try again in a minute." }, WebJson) { StatusCode = 502 };
        }
    }

    private bool FromInside()
    {
        var h = Request.Headers;
        if (h.ContainsKey("X-Forwarded-For") || h.ContainsKey("X-Original-For") || h.ContainsKey("X-Real-IP") || h.ContainsKey("Forwarded"))
        {
            return false;
        }

        var ip = HttpContext.Connection.RemoteIpAddress;
        if (ip == null)
        {
            return false;
        }

        if (ip.IsIPv4MappedToIPv6)
        {
            ip = ip.MapToIPv4();
        }

        if (System.Net.IPAddress.IsLoopback(ip))
        {
            return true;
        }

        var b = ip.GetAddressBytes();
        return ip.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork
            ? b[0] == 10 || (b[0] == 172 && b[1] >= 16 && b[1] <= 31) || (b[0] == 192 && b[1] == 168)
            : (b[0] & 0xFE) == 0xFC;
    }

    public sealed record Shelf(string Key, string Title, List<BookCard> Books);

    private static bool IsSourceProblem(Exception ex) =>
        ex is BooksException or HttpRequestException or TaskCanceledException or System.Text.Json.JsonException or InvalidOperationException;
}
