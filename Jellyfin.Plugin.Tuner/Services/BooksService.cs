using System.Collections.Concurrent;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.Tuner.Configuration;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Tuner.Services;

/// <summary>
/// The Books page's server side (2026-11-23). Two sources:
///
/// - Hardcover (hardcover.app), a book catalog with a GraphQL API: search, book pages and the
///   shelves. WHY not Bookshelf's own search: Bookshelf fetches the details of every result
///   before it answers, 30-65 s a search; Hardcover's search takes 0.3 s with covers,
///   ratings and series included.
/// - Bookshelf (a revival of Readarr, Hardcover ids as its book ids): "Get it" adds the book
///   there, and Bookshelf finds a copy through the server's indexers and downloads it, the way
///   Radarr does for movies. Its library, queue and running searches give each book's state.
///
/// Both keys stay on the server. Hardcover allows about 60 calls a minute per token, so
/// searches, book pages and shelves are cached and shared by everyone.
/// </summary>
public class BooksService
{
    private const string HardcoverApi = "https://api.hardcover.app/v1/graphql";

    // What a cover card needs, asked for the same way everywhere.
    private const string CardFields = "id title release_year rating ratings_count users_count image{ url } "
        + "contributions(limit: 3){ contribution author{ id name } } book_series(limit: 1){ position series{ name } }";

    private static readonly TimeSpan SearchFresh = TimeSpan.FromMinutes(30);
    private static readonly TimeSpan DetailFresh = TimeSpan.FromHours(6);
    private static readonly TimeSpan ShelfFresh = TimeSpan.FromHours(6);
    private static readonly TimeSpan LibraryFresh = TimeSpan.FromSeconds(10);

    private readonly IHttpClientFactory _http;
    private readonly ILogger<BooksService> _logger;
    private readonly ConcurrentDictionary<string, (DateTime At, object Value)> _cache = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, Queue<DateTime>> _gets = new(StringComparer.Ordinal);
    private (DateTime At, Dictionary<int, LibraryBook> Books)? _library;

    public BooksService(IHttpClientFactory http, ILogger<BooksService> logger)
    {
        _http = http;
        _logger = logger;
    }

    private static PluginConfiguration? Config => Plugin.Instance?.Configuration;

    /// <summary>On, and everything it needs is set.</summary>
    public static bool Enabled
    {
        get
        {
            var c = Config;
            return c is { BooksPage: true }
                && !string.IsNullOrWhiteSpace(c.HardcoverToken)
                && BookshelfBase(c) != null
                && !string.IsNullOrWhiteSpace(c.BookshelfApiKey);
        }
    }

    // Read-as-yourself tickets (2026-11-23). WHY: the reading site keeps its own accounts, and
    // people shouldn't need a second login. "Read" gets a ticket here; a gatekeeper in front of
    // the reader trades it (server to server, see RedeemTicket) for the Jellyfin username and
    // signs the person in as that name. Random, single use, 60 seconds: a ticket rides in a URL,
    // so one that leaks into a history list is already spent. Memory only: a Jellyfin restart
    // just means clicking Read again.
    private static readonly TimeSpan TicketLife = TimeSpan.FromSeconds(60);
    private static readonly ConcurrentDictionary<string, (string User, Guid Id, DateTime Until)> Tickets = new(StringComparer.Ordinal);

    // The account id rides along so the reader can later ask whether the account still exists
    // and is enabled (BooksController.Who), not just trust the name.
    public static string MintTicket(string user, Guid id)
    {
        var now = DateTime.UtcNow;
        foreach (var old in Tickets.Where(kv => kv.Value.Until < now).Select(kv => kv.Key).ToList())
        {
            Tickets.TryRemove(old, out _);
        }

        var ticket = Convert.ToBase64String(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32))
            .TrimEnd('=').Replace('+', '-').Replace('/', '_');
        Tickets[ticket] = (user, id, now + TicketLife);
        return ticket;
    }

    /// <summary>The username and account id a ticket was made for, once; null when unknown, used or expired.</summary>
    public static (string User, Guid Id)? RedeemTicket(string? ticket)
    {
        if (string.IsNullOrEmpty(ticket) || !Tickets.TryRemove(ticket, out var t))
        {
            return null;
        }

        return t.Until >= DateTime.UtcNow ? (t.User, t.Id) : null;
    }

    /// <summary>The Read button's site, only when it's an http(s) address (it becomes a link).</summary>
    public static string? ReadBase
    {
        get
        {
            var raw = Config?.BooksReadUrl?.Trim() ?? string.Empty;
            return Uri.TryCreate(raw, UriKind.Absolute, out var u) && (u.Scheme == Uri.UriSchemeHttps || u.Scheme == Uri.UriSchemeHttp)
                ? u.AbsoluteUri.TrimEnd('/')
                : null;
        }
    }

    private static string? BookshelfBase(PluginConfiguration c)
    {
        var raw = c.BookshelfUrl?.Trim() ?? string.Empty;
        return Uri.TryCreate(raw, UriKind.Absolute, out var u) && (u.Scheme == Uri.UriSchemeHttps || u.Scheme == Uri.UriSchemeHttp)
            ? u.AbsoluteUri.TrimEnd('/')
            : null;
    }

    // =====================================================================
    // Catalog (Hardcover)
    // =====================================================================

    public async Task<List<BookCard>> SearchAsync(string query, CancellationToken ct)
    {
        query = query.Trim();
        if (query.Length > 120)
        {
            query = query[..120];
        }

        return await Cached("search:" + query.ToLowerInvariant(), SearchFresh, async () =>
        {
            var data = await Hardcover(
                "query($q:String!){ search(query:$q, query_type:\"Book\", per_page:40, page:1){ results } }",
                new JsonObject { ["q"] = query },
                ct).ConfigureAwait(false);
            var hits = data?["search"]?["results"]?["hits"] as JsonArray ?? new JsonArray();
            var cards = new List<BookCard>();
            var lesser = new HashSet<int>();
            var today = DateTime.UtcNow.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);
            foreach (var hit in hits)
            {
                var d = hit?["document"];
                if (d == null || !int.TryParse(d["id"]?.ToString(), out var id))
                {
                    continue;
                }

                var series = d["featured_series"];
                var title = d["title"]?.ToString() ?? string.Empty;
                var released = d["release_date"]?.ToString();
                if (d["compilation"]?.GetValueKind() == JsonValueKind.True
                    || NotTheBook.IsMatch(title)
                    || (!string.IsNullOrEmpty(released) && string.CompareOrdinal(released, today) > 0))
                {
                    lesser.Add(id);
                }

                cards.Add(new BookCard
                {
                    Id = id,
                    Title = d["title"]?.ToString() ?? string.Empty,
                    Authors = AuthorsOf(d["contributions"] as JsonArray, d["author_names"] as JsonArray),
                    Year = Int(d["release_year"]),
                    Rating = RoundRating(d["rating"]),
                    Ratings = Int(d["ratings_count"]) ?? 0,
                    Readers = Int(d["users_count"]) ?? 0,
                    Cover = d["image"]?["url"]?.ToString(),
                    Series = series?["series"]?["name"]?.ToString(),
                    SeriesPosition = series?["position"] is JsonNode p ? FormatPosition(p) : null,
                });
            }

            // Keep Hardcover's order (it ranks by match), but in three bands: real books people
            // read, then real books nobody on Hardcover has shelved, then what isn't the book
            // itself (box sets, summaries, companions, placeholders for unwritten sequels, books
            // not out yet). "SUMMARY AND ANALYSIS OF PROJECT HAIL MARY" came second for that
            // search, and "stormlight archive" showed box sets and "Untitled #6" before any
            // novel (new-user test, 2026-11-23).
            return cards.Where(c => !lesser.Contains(c.Id) && c.Readers > 0)
                .Concat(cards.Where(c => !lesser.Contains(c.Id) && c.Readers == 0))
                .Concat(cards.Where(c => lesser.Contains(c.Id)))
                .ToList();
        }).ConfigureAwait(false);
    }

    // Titles that aren't the book itself, for SearchAsync's last band.
    private static readonly System.Text.RegularExpressions.Regex NotTheBook = new(
        @"\b(summary|summaries|analysis of|study guide|sparknotes|cliffs ?notes|workbook|companion|box(ed)? ?set|collection|omnibus|sidekick|compendium|world guide|untitled|series order|epilogue for|trivia|quiz|coloring book|sampler|excerpt|books \d+ ?[-–] ?\d+)\b",
        System.Text.RegularExpressions.RegexOptions.IgnoreCase | System.Text.RegularExpressions.RegexOptions.Compiled);

    /// <summary>
    /// One card per book: Hardcover lists editions separately, so "frankenstein" showed six
    /// identical "Frankenstein, Mary Shelley" cards (2026-11-23). Cards with the same title and
    /// first author become one, shown where the first of them ranked. The one kept is one
    /// Bookshelf already knows (so "In the library" or a download in progress isn't hidden
    /// behind another edition), else the most read.
    /// </summary>
    public static List<BookCard> OnePerBook(List<BookCard> cards, ICollection<int> known)
    {
        var groups = cards.GroupBy(c => (Norm(c.Title), Norm(FirstAuthor(c.Authors)))).ToList();
        var keep = groups.ToDictionary(
            g => g.Key,
            g => g.OrderByDescending(c => known.Contains(c.Id)).ThenByDescending(c => c.Readers).First());
        return groups.Select(g => keep[g.Key]).ToList();
    }

    private static string FirstAuthor(string authors)
    {
        var first = authors.Split(", ")[0];
        var and = first.IndexOf(" and ", StringComparison.Ordinal);
        return and > 0 ? first[..and] : first;
    }

    // Lowercase letters and digits only, single spaces: "Pride & Prejudice" = "pride and prejudice".
    private static string Norm(string s)
    {
        var t = s.ToLowerInvariant().Replace("&", " and ", StringComparison.Ordinal);
        return string.Join(' ', new string(t.Select(c => char.IsLetterOrDigit(c) ? c : ' ').ToArray())
            .Split(' ', StringSplitOptions.RemoveEmptyEntries));
    }

    /// <summary>A shelf for the front of the page: "new" (popular, out this year or last) or "loved" (most read ever).</summary>
    public async Task<List<BookCard>> ShelfAsync(string name, CancellationToken ct)
    {
        return await Cached("shelf:" + name, ShelfFresh, async () =>
        {
            JsonNode? data;
            if (name == "new")
            {
                data = await Hardcover(
                    // Out already: popular upcoming books (The Doors of Stone) had people asking
                    // why they couldn't get them (new-user test, 2026-11-23).
                    "query($y:Int!, $d:date!){ books(where:{release_year:{_gte:$y}, release_date:{_lte:$d}, users_count:{_gte:300}}, order_by:{users_count:desc}, limit:30){ " + CardFields + " } }",
                    new JsonObject { ["y"] = DateTime.UtcNow.Year - 1, ["d"] = DateTime.UtcNow.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture) },
                    ct).ConfigureAwait(false);
            }
            else
            {
                data = await Hardcover(
                    "query{ books(order_by:{users_count:desc}, limit:30){ " + CardFields + " } }",
                    new JsonObject(),
                    ct).ConfigureAwait(false);
            }

            return CardsOf(data?["books"] as JsonArray);
        }).ConfigureAwait(false);
    }

    /// <summary>
    /// One author's books, most read first: the "by ..." link on a book page. WHY not a text
    /// search for the name: "Frank Herbert" as words found God Emperor, graphic novels and
    /// books about him before Dune (new-user test, 2026-11-23). Box sets left out; books not
    /// out yet go last.
    /// </summary>
    public async Task<(string Name, List<BookCard> Books)> AuthorAsync(int authorId, CancellationToken ct)
    {
        return await Cached("author:" + authorId, ShelfFresh, async () =>
        {
            var data = await Hardcover(
                "query($a:Int!){ authors_by_pk(id:$a){ name } books(where:{contributions:{author_id:{_eq:$a}, _or:[{contribution:{_is_null:true}}, {contribution:{_eq:\"Author\"}}]}, compilation:{_eq:false}}, order_by:{users_count:desc}, limit:40){ release_date " + CardFields + " } }",
                new JsonObject { ["a"] = authorId },
                ct).ConfigureAwait(false);
            var arr = data?["books"] as JsonArray;
            var today = DateTime.UtcNow.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);
            var later = new HashSet<int>();
            foreach (var b in arr ?? new JsonArray())
            {
                var released = b?["release_date"]?.ToString();
                if (!string.IsNullOrEmpty(released) && string.CompareOrdinal(released, today) > 0 && Int(b?["id"]) is int lid)
                {
                    later.Add(lid);
                }
            }

            var cards = CardsOf(arr);
            return (data?["authors_by_pk"]?["name"]?.ToString() ?? string.Empty,
                cards.Where(c => !later.Contains(c.Id)).Concat(cards.Where(c => later.Contains(c.Id))).ToList());
        }).ConfigureAwait(false);
    }

    /// <summary>Cards for books by Hardcover id (the library shelf), in the order given.</summary>
    public async Task<List<BookCard>> CardsAsync(IReadOnlyList<int> ids, CancellationToken ct)
    {
        if (ids.Count == 0)
        {
            return new List<BookCard>();
        }

        var key = "cards:" + string.Join(',', ids);
        return await Cached(key, TimeSpan.FromMinutes(5), async () =>
        {
            var arr = new JsonArray();
            foreach (var id in ids)
            {
                arr.Add(id);
            }

            var data = await Hardcover(
                "query($ids:[Int!]){ books(where:{id:{_in:$ids}}){ " + CardFields + " } }",
                new JsonObject { ["ids"] = arr },
                ct).ConfigureAwait(false);
            var byId = CardsOf(data?["books"] as JsonArray).ToDictionary(c => c.Id);
            return ids.Where(byId.ContainsKey).Select(i => byId[i]).ToList();
        }).ConfigureAwait(false);
    }

    public async Task<BookDetail?> DetailAsync(int id, CancellationToken ct)
    {
        return await Cached("detail:" + id, DetailFresh, async () =>
        {
            var data = await Hardcover(
                "query($id:Int!){ books_by_pk(id:$id){ id title subtitle description pages release_year rating ratings_count users_count "
                + "image{ url } cached_tags contributions{ contribution author{ id name } } book_series{ position series{ name } } } }",
                new JsonObject { ["id"] = id },
                ct).ConfigureAwait(false);
            var b = data?["books_by_pk"];
            if (b == null)
            {
                return (BookDetail?)null;
            }

            var contributions = b["contributions"] as JsonArray;
            var series = (b["book_series"] as JsonArray)?.FirstOrDefault();
            var genres = new List<string>();
            if (b["cached_tags"]?["Genre"] is JsonArray g)
            {
                foreach (var t in g.Take(6))
                {
                    var name = t?["tag"]?.ToString();
                    // Hardcover's genre tags are user-added and mix cases ("dragons", "Fantasy").
                    if (!string.IsNullOrWhiteSpace(name) && !genres.Contains(name, StringComparer.OrdinalIgnoreCase))
                    {
                        genres.Add(char.ToUpperInvariant(name[0]) + name[1..]);
                    }
                }
            }

            return new BookDetail
            {
                Id = id,
                Title = b["title"]?.ToString() ?? string.Empty,
                Subtitle = b["subtitle"]?.ToString(),
                Authors = AuthorsOf(contributions, null),
                AuthorId = MainAuthorId(contributions),
                Description = b["description"]?.ToString(),
                Pages = Int(b["pages"]),
                Year = Int(b["release_year"]),
                Rating = RoundRating(b["rating"]),
                Ratings = Int(b["ratings_count"]) ?? 0,
                Cover = b["image"]?["url"]?.ToString(),
                Series = series?["series"]?["name"]?.ToString(),
                SeriesPosition = series?["position"] is JsonNode p ? FormatPosition(p) : null,
                Genres = genres,
            };
        }).ConfigureAwait(false);
    }

    private async Task<JsonNode?> Hardcover(string query, JsonObject variables, CancellationToken ct)
    {
        var token = Config?.HardcoverToken?.Trim() ?? string.Empty;
        if (!token.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
        {
            token = "Bearer " + token;
        }

        var body = new JsonObject { ["query"] = query, ["variables"] = variables };
        using var req = new HttpRequestMessage(HttpMethod.Post, HardcoverApi)
        {
            Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"),
        };
        req.Headers.TryAddWithoutValidation("authorization", token);
        using var res = await _http.CreateClient(PluginServiceRegistrator.ApiClient).SendAsync(req, ct).ConfigureAwait(false);
        var text = await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        if (!res.IsSuccessStatusCode)
        {
            throw new BooksException($"Hardcover answered {(int)res.StatusCode}");
        }

        var node = JsonNode.Parse(text);
        if (node?["errors"] is JsonArray errors && errors.Count > 0)
        {
            throw new BooksException("Hardcover: " + errors[0]?["message"]);
        }

        return node?["data"];
    }

    private static List<BookCard> CardsOf(JsonArray? books)
    {
        var cards = new List<BookCard>();
        foreach (var b in books ?? new JsonArray())
        {
            if (b == null || Int(b["id"]) is not int id)
            {
                continue;
            }

            var series = (b["book_series"] as JsonArray)?.FirstOrDefault();
            cards.Add(new BookCard
            {
                Id = id,
                Title = b["title"]?.ToString() ?? string.Empty,
                Authors = AuthorsOf(b["contributions"] as JsonArray, null),
                Year = Int(b["release_year"]),
                Rating = RoundRating(b["rating"]),
                Ratings = Int(b["ratings_count"]) ?? 0,
                Readers = Int(b["users_count"]) ?? 0,
                Cover = b["image"]?["url"]?.ToString(),
                Series = series?["series"]?["name"]?.ToString(),
                SeriesPosition = series?["position"] is JsonNode p ? FormatPosition(p) : null,
            });
        }

        return cards;
    }

    // Authors only: translators, illustrators and narrators are contributions too, and
    // "Jane Austen, Vivien Jones, Tony Tanner" reads like three writers. Hardcover leaves the
    // role empty for the main author on many books, so empty counts as "Author".
    private static string AuthorsOf(JsonArray? contributions, JsonArray? fallbackNames)
    {
        var names = new List<string>();
        foreach (var c in contributions ?? new JsonArray())
        {
            var role = c?["contribution"]?.ToString();
            var name = c?["author"]?["name"]?.ToString();
            if (!string.IsNullOrWhiteSpace(name) && (string.IsNullOrEmpty(role) || role == "Author") && !names.Contains(name))
            {
                names.Add(name);
            }
        }

        if (names.Count == 0 && fallbackNames != null)
        {
            names.AddRange(fallbackNames.Select(n => n?.ToString()).Where(n => !string.IsNullOrWhiteSpace(n)).Take(2)!);
        }

        return names.Count > 2 ? $"{names[0]}, {names[1]} and others" : string.Join(" and ", names);
    }

    private static int? MainAuthorId(JsonArray? contributions)
    {
        foreach (var c in contributions ?? new JsonArray())
        {
            var role = c?["contribution"]?.ToString();
            if ((string.IsNullOrEmpty(role) || role == "Author") && Int(c?["author"]?["id"]) is int id)
            {
                return id;
            }
        }

        return (Int(contributions?.FirstOrDefault()?["author"]?["id"]));
    }

    // Numbers as JSON gives them: 3, 3.0, or (Hardcover's search ids) "1197328". Anything
    // else, including JSON null, is no number rather than an exception.
    private static int? Int(JsonNode? n)
    {
        if (n is not JsonValue v)
        {
            return null;
        }

        if (v.TryGetValue<int>(out var i))
        {
            return i;
        }

        if (v.TryGetValue<double>(out var d))
        {
            return (int)d;
        }

        return v.TryGetValue<string>(out var s) && int.TryParse(s, out var p) ? p : null;
    }

    private static double? Dbl(JsonNode? n) =>
        n is JsonValue v && v.TryGetValue<double>(out var d) ? d : Int(n);

    private static double? RoundRating(JsonNode? n)
    {
        var v = Dbl(n);
        return v is > 0 ? Math.Round(v.Value, 1) : null;
    }

    // Series positions come as 3, 3.0 or 0.5 (a novella between books).
    private static string FormatPosition(JsonNode p)
    {
        var v = Dbl(p) ?? 0;
        return v == Math.Floor(v) ? ((int)v).ToString(System.Globalization.CultureInfo.InvariantCulture)
            : v.ToString("0.#", System.Globalization.CultureInfo.InvariantCulture);
    }

    // =====================================================================
    // The library and downloads (Bookshelf)
    // =====================================================================

    /// <summary>What's happening with each of these books, by Hardcover id. Books Bookshelf doesn't have are left out.</summary>
    public async Task<Dictionary<int, BookState>> StatesAsync(IEnumerable<int> ids, CancellationToken ct)
    {
        var library = await LibraryAsync(false, ct).ConfigureAwait(false);
        var wanted = ids.Where(library.ContainsKey).Distinct().ToList();
        var states = new Dictionary<int, BookState>();
        if (wanted.Count == 0)
        {
            return states;
        }

        // Only books that aren't finished need the queue and the running searches.
        var open = wanted.Where(i => !library[i].HasFile).ToList();
        var queue = open.Count > 0 ? await QueueAsync(ct).ConfigureAwait(false) : new Dictionary<int, QueueItem>();
        var searching = open.Count > 0 ? await SearchingAsync(ct).ConfigureAwait(false) : new HashSet<int>();
        foreach (var id in wanted)
        {
            var b = library[id];
            if (b.HasFile)
            {
                states[id] = new BookState { State = "have" };
            }
            else if (queue.TryGetValue(b.BookshelfId, out var q))
            {
                states[id] = q.Importing
                    ? new BookState { State = "importing", Release = q.Release }
                    : new BookState { State = q.Problem != null ? "problem" : "downloading", Progress = q.Progress, Release = q.Release, Message = q.Problem };
            }
            else if (searching.Contains(b.BookshelfId))
            {
                states[id] = new BookState { State = "searching" };
            }
            else if (b.Monitored)
            {
                states[id] = new BookState { State = "missing" };
            }
        }

        return states;
    }

    /// <summary>Hardcover ids of the books in Bookshelf, newest first (the "Your library" shelf).</summary>
    public async Task<List<int>> RecentAsync(int count, CancellationToken ct)
    {
        var library = await LibraryAsync(false, ct).ConfigureAwait(false);
        return library.Values.Where(b => b.Monitored || b.HasFile).OrderByDescending(b => b.Added).Take(count).Select(b => b.HardcoverId).ToList();
    }

    /// <summary>"Get it": add the book to Bookshelf (or ask it to look again) and start a search.</summary>
    public async Task<(bool Ok, string Message)> GetAsync(int id, string user, CancellationToken ct)
    {
        var c = Config!;
        var library = await LibraryAsync(true, ct).ConfigureAwait(false);
        if (library.TryGetValue(id, out var have))
        {
            if (have.HasFile)
            {
                return (true, "It's already in the library.");
            }

            // Bookshelf already knows the book. Either someone asked for it (look again now), or
            // it came in unwanted with its author: adding one book lists all of the author's
            // books, unmonitored. That second case is a new request, so it counts.
            var fresh = !have.Monitored;
            if (fresh)
            {
                if (!HasAllowance(user, c.BooksPerUserPerDay))
                {
                    return (false, $"That's {c.BooksPerUserPerDay} books today. Try again tomorrow.");
                }

                await Bookshelf(HttpMethod.Put, "book/monitor", new JsonObject { ["bookIds"] = new JsonArray(have.BookshelfId), ["monitored"] = true }, ct).ConfigureAwait(false);
                TakeAllowance(user);
                _logger.LogInformation("Books: {User} asked for Hardcover {Id} (author already in Bookshelf)", user, id);
            }

            await Bookshelf(HttpMethod.Post, "command", new JsonObject { ["name"] = "BookSearch", ["bookIds"] = new JsonArray(have.BookshelfId) }, ct).ConfigureAwait(false);
            _library = null;
            return (true, fresh ? "Added. Looking for a copy now." : "Looking for it again.");
        }

        // The allowance is only used once the book is really added (TakeAllowance below): a
        // book Bookshelf can't take shouldn't cost one of the day's adds (review, 2026-11-23).
        if (!HasAllowance(user, c.BooksPerUserPerDay))
        {
            return (false, $"That's {c.BooksPerUserPerDay} books today. Try again tomorrow.");
        }

        var detail = await DetailAsync(id, ct).ConfigureAwait(false);
        if (detail?.AuthorId is not int authorId)
        {
            return (false, "This book has no author listed, so it can't be added.");
        }

        // Bookshelf's lookup by Hardcover id ("work:<id>") is instant, unlike its word search.
        var found = await Bookshelf(HttpMethod.Get, "book/lookup?term=work:" + id, null, ct).ConfigureAwait(false) as JsonArray;
        if (found?.FirstOrDefault() is not JsonObject book)
        {
            return (false, "Bookshelf couldn't find this book.");
        }

        var roots = await Bookshelf(HttpMethod.Get, "rootfolder", null, ct).ConfigureAwait(false) as JsonArray;
        if (roots?.FirstOrDefault() is not JsonObject root)
        {
            throw new BooksException("Bookshelf has no root folder");
        }

        // Its lookup result leaves out the author and the edition list; both are required to
        // add a book (an empty edition list is a 500). Only this book is wanted: the author's
        // other books are added unmonitored, so they don't all download.
        book["monitored"] = true;
        book["addOptions"] = new JsonObject { ["searchForNewBook"] = true };
        book["editions"] = new JsonArray(new JsonObject
        {
            ["foreignEditionId"] = book["foreignEditionId"]?.ToString(),
            ["monitored"] = true,
            ["manualAdd"] = true,
        });
        book["author"] = new JsonObject
        {
            ["foreignAuthorId"] = authorId.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["qualityProfileId"] = Int(root["defaultQualityProfileId"]) ?? 1,
            ["metadataProfileId"] = Int(root["defaultMetadataProfileId"]) ?? 1,
            ["rootFolderPath"] = root["path"]?.ToString(),
            ["monitored"] = true,
            ["monitorNewItems"] = "none",
            ["addOptions"] = new JsonObject { ["monitor"] = "none", ["searchForMissingBooks"] = false },
        };
        try
        {
            await Bookshelf(HttpMethod.Post, "book", book, ct).ConfigureAwait(false);
        }
        catch (BooksException)
        {
            // Two people pressing Get it on the same book at once: the second add fails because
            // the first got there. Say so instead of "the catalog isn't answering".
            _library = null;
            if ((await LibraryAsync(true, ct).ConfigureAwait(false)).ContainsKey(id))
            {
                return (true, "Someone just asked for it. It's on its way.");
            }

            throw;
        }

        _library = null;
        TakeAllowance(user);
        _logger.LogInformation("Books: {User} asked for {Title} (Hardcover {Id})", user, detail.Title, id);
        return (true, "Added. Looking for a copy now.");
    }

    /// <summary>"Wrong book? Try another copy": drop the current download, block that file, search again.</summary>
    public async Task<(bool Ok, string Message)> RetryAsync(int id, string user, CancellationToken ct)
    {
        var library = await LibraryAsync(true, ct).ConfigureAwait(false);
        if (!library.TryGetValue(id, out var b))
        {
            return (false, "This book isn't on its way.");
        }

        var queue = await QueueAsync(ct).ConfigureAwait(false);
        if (queue.TryGetValue(b.BookshelfId, out var q))
        {
            await Bookshelf(HttpMethod.Delete, $"queue/{q.QueueId}?removeFromClient=true&blocklist=true", null, ct).ConfigureAwait(false);
            _logger.LogInformation("Books: {User} turned down \"{Release}\" for Hardcover {Id}", user, q.Release, id);
        }

        await Bookshelf(HttpMethod.Post, "command", new JsonObject { ["name"] = "BookSearch", ["bookIds"] = new JsonArray(b.BookshelfId) }, ct).ConfigureAwait(false);
        return (true, "Looking for another copy.");
    }

    /// <summary>
    /// "Wrong book? Replace it" on a book in the library (2026-11-23). Deletes Bookshelf's copy,
    /// marks the download it came from as failed (Bookshelf blocks that release and searches
    /// again by itself: "redownload failed" is on), and asks for a search too. The reader's copy
    /// goes when the reading site's feeder sees the file gone (set up outside this plugin). Counts toward
    /// the daily allowance: it's a new download for the shared library.
    /// </summary>
    public async Task<(bool Ok, string Message)> ReplaceAsync(int id, string user, CancellationToken ct)
    {
        var c = Config!;
        var library = await LibraryAsync(true, ct).ConfigureAwait(false);
        if (!library.TryGetValue(id, out var b) || !b.HasFile)
        {
            return (false, "This book isn't in the library.");
        }

        if (!HasAllowance(user, c.BooksPerUserPerDay))
        {
            return (false, $"That's {c.BooksPerUserPerDay} books today. Try again tomorrow.");
        }

        // The grab the file came from, found before the file goes (the history stays either way).
        // Bookshelf has no history/book (404, found by the first real Replace, 2026-11-23): the
        // paged history list filtered by bookId, records under "records".
        var history = await Bookshelf(HttpMethod.Get, $"history?bookId={b.BookshelfId}&pageSize=50&sortKey=date&sortDirection=descending", null, ct).ConfigureAwait(false) as JsonObject;
        var grab = (history?["records"] as JsonArray)?.OfType<JsonObject>()
            .Where(h => h["eventType"]?.ToString() == "grabbed")
            .OrderByDescending(h => h["date"]?.ToString(), StringComparer.Ordinal)
            .FirstOrDefault();

        var files = await Bookshelf(HttpMethod.Get, $"bookfile?bookId={b.BookshelfId}", null, ct).ConfigureAwait(false) as JsonArray;
        foreach (var f in files?.OfType<JsonObject>() ?? Enumerable.Empty<JsonObject>())
        {
            if (Int(f["id"]) is int fileId)
            {
                await Bookshelf(HttpMethod.Delete, $"bookfile/{fileId}", null, ct).ConfigureAwait(false);
            }
        }

        if (Int(grab?["id"]) is int grabId)
        {
            try
            {
                await Bookshelf(HttpMethod.Post, $"history/failed/{grabId}", null, ct).ConfigureAwait(false);
            }
            catch (BooksException ex)
            {
                // Still worth searching: it may pick the same release, but the file is gone.
                _logger.LogWarning("Books: couldn't block the old download for Hardcover {Id}: {Message}", id, ex.Message);
            }
        }

        await Bookshelf(HttpMethod.Post, "command", new JsonObject { ["name"] = "BookSearch", ["bookIds"] = new JsonArray(b.BookshelfId) }, ct).ConfigureAwait(false);
        TakeAllowance(user);
        _library = null;
        _logger.LogInformation("Books: {User} replaced the copy of Hardcover {Id} (old release \"{Release}\")", user, id, grab?["sourceTitle"]?.ToString() ?? "unknown");
        return (true, "Removed that copy. Looking for another one.");
    }

    private async Task<Dictionary<int, LibraryBook>> LibraryAsync(bool fresh, CancellationToken ct)
    {
        if (!fresh && _library is { } l && DateTime.UtcNow - l.At < LibraryFresh)
        {
            return l.Books;
        }

        var books = new Dictionary<int, LibraryBook>();
        if (await Bookshelf(HttpMethod.Get, "book", null, ct).ConfigureAwait(false) is JsonArray arr)
        {
            foreach (var b in arr)
            {
                if (!int.TryParse(b?["foreignBookId"]?.ToString(), out var hid))
                {
                    continue;
                }

                books[hid] = new LibraryBook
                {
                    HardcoverId = hid,
                    BookshelfId = b!["id"]!.GetValue<int>(),
                    Monitored = b["monitored"]?.GetValue<bool>() ?? false,
                    HasFile = (Int(b["statistics"]?["bookFileCount"]) ?? 0) > 0,
                    Added = DateTime.TryParse(b["added"]?.ToString(), out var added) ? added : DateTime.MinValue,
                };
            }
        }

        _library = (DateTime.UtcNow, books);
        return books;
    }

    private async Task<Dictionary<int, QueueItem>> QueueAsync(CancellationToken ct)
    {
        var items = new Dictionary<int, QueueItem>();
        var page = await Bookshelf(HttpMethod.Get, "queue?pageSize=200", null, ct).ConfigureAwait(false);
        foreach (var r in page?["records"] as JsonArray ?? new JsonArray())
        {
            if (r == null || Int(r["bookId"]) is not int bookId)
            {
                continue;
            }

            var size = Dbl(r["size"]) ?? 0;
            var left = Dbl(r["sizeleft"]) ?? 0;
            var tracked = r["trackedDownloadState"]?.ToString() ?? string.Empty;
            var status = r["trackedDownloadStatus"]?.ToString() ?? string.Empty;
            string? problem = null;
            if (status is "warning" or "error")
            {
                // The first status message is the readable one ("No files found are eligible
                // for import", "Unable to parse ..."); errorMessage is the download client's.
                problem = (r["statusMessages"] as JsonArray)?.FirstOrDefault()?["messages"]?[0]?.ToString()
                    ?? r["errorMessage"]?.ToString() ?? "There's a problem with this download.";
            }

            items[bookId] = new QueueItem
            {
                QueueId = r["id"]!.GetValue<int>(),
                Release = r["title"]?.ToString() ?? string.Empty,
                Progress = size > 0 ? Math.Clamp(1 - (left / size), 0, 1) : 0,
                Importing = tracked is "importPending" or "importing" && problem == null,
                Problem = problem,
            };
        }

        return items;
    }

    // Book ids with a search queued or running ("Looking for a copy").
    private async Task<HashSet<int>> SearchingAsync(CancellationToken ct)
    {
        var ids = new HashSet<int>();
        foreach (var cmd in await Bookshelf(HttpMethod.Get, "command", null, ct).ConfigureAwait(false) as JsonArray ?? new JsonArray())
        {
            var status = cmd?["status"]?.ToString();
            if (cmd?["name"]?.ToString() != "BookSearch" || status is not ("queued" or "started"))
            {
                continue;
            }

            foreach (var b in cmd["body"]?["bookIds"] as JsonArray ?? new JsonArray())
            {
                if (Int(b) is int i)
                {
                    ids.Add(i);
                }
            }
        }

        return ids;
    }

    private async Task<JsonNode?> Bookshelf(HttpMethod method, string path, JsonNode? body, CancellationToken ct)
    {
        var c = Config!;
        using var req = new HttpRequestMessage(method, BookshelfBase(c) + "/api/v1/" + path);
        req.Headers.Add("X-Api-Key", c.BookshelfApiKey.Trim());
        req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        if (body != null)
        {
            req.Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");
        }

        using var res = await _http.CreateClient(PluginServiceRegistrator.ApiClient).SendAsync(req, ct).ConfigureAwait(false);
        var text = await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        if (!res.IsSuccessStatusCode)
        {
            _logger.LogWarning("Books: Bookshelf {Method} {Path} answered {Status}: {Body}", method, path.Split('?')[0], (int)res.StatusCode, text.Length > 300 ? text[..300] : text);
            throw new BooksException($"Bookshelf answered {(int)res.StatusCode}");
        }

        return string.IsNullOrWhiteSpace(text) ? null : JsonNode.Parse(text);
    }

    // =====================================================================
    // Helpers
    // =====================================================================

    // Adds per person in the last 24 hours. Memory only, so a Jellyfin restart starts everyone
    // fresh: fine for a guard against double-clicks and curiosity, not a quota.
    private bool HasAllowance(string user, int perDay)
    {
        if (perDay <= 0)
        {
            return true;
        }

        var times = _gets.GetOrAdd(user, _ => new Queue<DateTime>());
        lock (times)
        {
            var cutoff = DateTime.UtcNow.AddDays(-1);
            while (times.Count > 0 && times.Peek() < cutoff)
            {
                times.Dequeue();
            }

            return times.Count < perDay;
        }
    }

    private void TakeAllowance(string user)
    {
        var times = _gets.GetOrAdd(user, _ => new Queue<DateTime>());
        lock (times)
        {
            times.Enqueue(DateTime.UtcNow);
        }
    }

    private async Task<T> Cached<T>(string key, TimeSpan fresh, Func<Task<T>> fetch)
    {
        if (_cache.TryGetValue(key, out var hit) && DateTime.UtcNow - hit.At < fresh)
        {
            return (T)hit.Value;
        }

        var value = await fetch().ConfigureAwait(false);
        if (value != null)
        {
            _cache[key] = (DateTime.UtcNow, value);
        }

        // Searches are the only open-ended keys; drop the oldest when there are many.
        if (_cache.Count > 500)
        {
            foreach (var old in _cache.OrderBy(kv => kv.Value.At).Take(100).Select(kv => kv.Key).ToList())
            {
                _cache.TryRemove(old, out _);
            }
        }

        return value;
    }

    private sealed class LibraryBook
    {
        public int HardcoverId { get; init; }

        public int BookshelfId { get; init; }

        public bool Monitored { get; init; }

        public bool HasFile { get; init; }

        public DateTime Added { get; init; }
    }

    private sealed class QueueItem
    {
        public int QueueId { get; init; }

        public string Release { get; init; } = string.Empty;

        public double Progress { get; init; }

        public bool Importing { get; init; }

        public string? Problem { get; init; }
    }
}

public class BooksException : Exception
{
    public BooksException(string message)
        : base(message)
    {
    }
}

public class BookCard
{
    public int Id { get; init; }

    public string Title { get; init; } = string.Empty;

    public string Authors { get; init; } = string.Empty;

    public int? Year { get; init; }

    public double? Rating { get; init; }

    public int Ratings { get; init; }

    public int Readers { get; init; }

    public string? Cover { get; init; }

    public string? Series { get; init; }

    public string? SeriesPosition { get; init; }
}

public class BookDetail : BookCard
{
    public string? Subtitle { get; init; }

    public int? AuthorId { get; init; }

    public string? Description { get; init; }

    public int? Pages { get; init; }

    public List<string> Genres { get; init; } = new();
}

public class BookState
{
    /// <summary>searching, downloading, importing, have, missing (wanted, no copy found yet) or problem.</summary>
    public string State { get; init; } = string.Empty;

    public double? Progress { get; init; }

    /// <summary>The file being downloaded, so a wrong match is easy to spot.</summary>
    public string? Release { get; init; }

    public string? Message { get; init; }
}
