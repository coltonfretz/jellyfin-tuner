using System.Reflection;
using Jellyfin.Plugin.Tuner.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Tuner.Api;

/// <summary>
/// HTTP surface for the injected client.
///
/// Auth model: JSON endpoints use Jellyfin's normal [Authorize] (the page calls them
/// through ApiClient, which sends the user's token). Media endpoints (stream, logo)
/// are hit by &lt;audio&gt;/&lt;img&gt; tags that can't send headers, so they take a
/// signed ticket from <see cref="StreamTickets"/> and only ever relay URLs that are in
/// the server's own station list, so this is not an open proxy.
/// </summary>
[ApiController]
[Route("Tuner")]
public class TunerController : ControllerBase
{
    private readonly RadioCatalog _radio;
    private readonly IcyMetadata _icy;
    private readonly JamendoService _jamendo;
    private readonly StreamTickets _tickets;
    private readonly TvService _tv;
    private readonly HlsRelay _relay;
    private readonly AntennaService _antenna;
    private readonly SeasonService _seasons;
    private readonly IHttpClientFactory _http;
    private readonly ILogger<TunerController> _logger;

    public TunerController(RadioCatalog radio, IcyMetadata icy, JamendoService jamendo, StreamTickets tickets, TvService tv, HlsRelay relay, AntennaService antenna, SeasonService seasons, IHttpClientFactory http, ILogger<TunerController> logger)
    {
        _radio = radio;
        _icy = icy;
        _jamendo = jamendo;
        _tickets = tickets;
        _tv = tv;
        _relay = relay;
        _antenna = antenna;
        _seasons = seasons;
        _http = http;
        _logger = logger;
    }

    // ---- Client assets (anonymous: the login page loads index.html too) ----

    [HttpGet("client.js")]
    [AllowAnonymous]
    public IActionResult ClientScript() => Embedded("Tuner.Web.tuner.js", "application/javascript");

    [HttpGet("homerows.js")]
    [AllowAnonymous]
    public IActionResult HomeRowsScript() => Embedded("Tuner.Web.homerows.js", "application/javascript");

    [HttpGet("client.css")]
    [AllowAnonymous]
    public IActionResult ClientStyle() => Embedded("Tuner.Web.tuner.css", "text/css");

    // hls.js 1.7.3 (Apache-2.0, vendored and checked against npm's integrity hash).
    // Loaded only when the TV page opens, so radio-only use never pays for 600 KB.
    [HttpGet("hls.js")]
    [AllowAnonymous]
    public IActionResult HlsScript() => Embedded("Tuner.Web.hls.min.js", "application/javascript");

    // ---- TV ----

    [HttpGet("tv")]
    [Authorize]
    public async Task<ActionResult> Tv(CancellationToken ct)
    {
        if (!_tv.Enabled && !_antenna.Enabled)
        {
            return Ok(new { enabled = false });
        }

        var ticket = _tickets.Issue();
        var channels = new List<object>();

        // Antenna first: real channel numbers (4.1 ... 59.3) sort ahead of the 101+ blocks.
        if (_antenna.Enabled)
        {
            foreach (var c in await _antenna.GetLineupAsync(ct).ConfigureAwait(false))
            {
                channels.Add(new
                {
                    number = c.Number,
                    name = c.Name,
                    group = "Antenna",
                    kind = "antenna",
                    hasLogo = true,
                    logo = $"Tuner/tv/antenna/{c.Number}/logo",
                    url = $"Tuner/tv/antenna/{c.Number}/index.m3u8",
                });
            }
        }

        if (_tv.Enabled)
        {
            try
            {
                foreach (var c in await _tv.GetLineupAsync(ct).ConfigureAwait(false))
                {
                    channels.Add(new
                    {
                        number = c.Number.ToString(System.Globalization.CultureInfo.InvariantCulture),
                        name = c.Name,
                        group = c.Group,
                        kind = "free",
                        hasLogo = c.LogoId != null,
                        logo = $"Tuner/tv/{c.Number}/logo",
                        url = c.StreamUrl,
                        // Fallback for CDNs that refuse cross-origin requests; see HlsRelay.
                        relay = "Tuner/tv/" + _relay.RelayPath(c.StreamUrl),
                    });
                }
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or System.Text.Json.JsonException)
            {
                // Dispatcharr down: the antenna still works on its own.
                _logger.LogWarning("Tuner: free channels unavailable: {Message}", ex.Message);
            }
        }

        return Ok(new { enabled = true, ticket, channels });
    }

    [HttpGet("tv/guide")]
    [Authorize]
    public async Task<ActionResult> TvGuide(CancellationToken ct)
    {
        var result = new Dictionary<string, object>();
        static object Entry((TvProgram? Now, TvProgram? Next) v) => new
        {
            now = v.Now is { } n ? new { title = n.Title, start = n.Start, end = n.End } : null,
            next = v.Next is { } x ? new { title = x.Title, start = x.Start, end = x.End } : null,
        };

        if (_tv.Enabled)
        {
            foreach (var kv in await _tv.GetNowNextAsync(ct).ConfigureAwait(false))
            {
                result[kv.Key.ToString(System.Globalization.CultureInfo.InvariantCulture)] = Entry(kv.Value);
            }
        }

        if (_antenna.Enabled)
        {
            foreach (var kv in await _antenna.GetNowNextAsync(ct).ConfigureAwait(false))
            {
                result[kv.Key] = Entry(kv.Value);
            }
        }

        return Ok(result);
    }

    // ---- Antenna (HDHomeRun via a per-channel live transcode; see AntennaService) ----

    [HttpGet("tv/antenna/{number}/index.m3u8")]
    [AllowAnonymous]
    public async Task<ActionResult> AntennaPlaylist(string number, [FromQuery] string? t, CancellationToken ct)
    {
        if (!_tickets.IsValid(t) || !AntennaService.IsChannelNumber(number))
        {
            return Forbid();
        }

        var (result, playlist) = await _antenna.GetPlaylistAsync(number, t!, ct).ConfigureAwait(false);
        Response.Headers.CacheControl = "no-store";
        return result switch
        {
            AntennaService.PlaylistResult.Ok => Content(playlist!, "application/vnd.apple.mpegurl"),
            AntennaService.PlaylistResult.UnknownChannel => NotFound(),
            // The client tells "both tuners busy" apart from "this channel won't start".
            AntennaService.PlaylistResult.TunersBusy => StatusCode(StatusCodes.Status429TooManyRequests),
            _ => StatusCode(StatusCodes.Status503ServiceUnavailable),
        };
    }

    [HttpGet("tv/antenna/{number}/{segment}")]
    [AllowAnonymous]
    public ActionResult AntennaSegment(string number, string segment, [FromQuery] string? t)
    {
        if (!_tickets.IsValid(t) || !AntennaService.IsChannelNumber(number))
        {
            return Forbid();
        }

        var path = _antenna.SegmentPath(number, segment, t!);
        if (path is null)
        {
            return NotFound();
        }

        Response.Headers.CacheControl = "no-store";
        return PhysicalFile(path, "video/mp2t");
    }

    [HttpPost("tv/antenna/{number}/release")]
    [AllowAnonymous]
    public ActionResult AntennaRelease(string number, [FromQuery] string? t)
    {
        if (!_tickets.IsValid(t) || !AntennaService.IsChannelNumber(number))
        {
            return Forbid();
        }

        _antenna.Release(number, t!);
        return NoContent();
    }

    [HttpGet("tv/antenna/{number}/logo")]
    [AllowAnonymous]
    public async Task<ActionResult> AntennaLogo(string number, [FromQuery] string? t, CancellationToken ct)
    {
        if (!_tickets.IsValid(t) || !AntennaService.IsChannelNumber(number))
        {
            return Forbid();
        }

        return Logo(await _antenna.GetLogoAsync(number, ct).ConfigureAwait(false));
    }

    [HttpGet("tv/{number:int}/logo")]
    [AllowAnonymous]
    public async Task<ActionResult> TvLogo(int number, [FromQuery] string? t, CancellationToken ct)
    {
        if (!_tickets.IsValid(t))
        {
            return Forbid();
        }

        return Logo(await _tv.GetLogoAsync(number, ct).ConfigureAwait(false));
    }

    [HttpGet("tv/hls")]
    [AllowAnonymous]
    public async Task TvHls([FromQuery] string? u, [FromQuery] string? s, [FromQuery] string? t, CancellationToken ct)
    {
        if (!_tickets.IsValid(t) || string.IsNullOrEmpty(u))
        {
            Response.StatusCode = StatusCodes.Status403Forbidden;
            return;
        }

        try
        {
            await _relay.RelayAsync(HttpContext, u, s, t!, ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // Viewer changed channel mid-segment.
        }
        catch (HttpRequestException ex)
        {
            _logger.LogInformation("Tuner: HLS relay fetch failed: {Message}", ex.Message);
            if (!Response.HasStarted)
            {
                Response.StatusCode = StatusCodes.Status502BadGateway;
            }
        }
    }

    // ---- Seasons ----

    /// <summary>
    /// Collections that are in season today, for the extra My Media tiles. Empty most of the
    /// year. Ids only: the client fetches the picture through Jellyfin's own image endpoint.
    /// </summary>
    [HttpGet("seasons")]
    [Authorize]
    public ActionResult Seasons()
    {
        return Ok(_seasons.ActiveTiles().Select(t => new { id = t.Id.ToString("N"), name = t.Name, imageType = t.ImageType, imageTag = t.ImageTag }));
    }

    // ---- Radio ----

    [HttpGet("radio")]
    [Authorize]
    public async Task<ActionResult> Radio(CancellationToken ct)
    {
        var genres = await _radio.GetGenresAsync(ct).ConfigureAwait(false);
        return Ok(new
        {
            ticket = _tickets.Issue(),
            genres = genres.Select(g => new
            {
                name = g.Name,
                color = g.Color,
                stations = g.Stations.Select(s => new { number = s.Number, name = s.Name, hasLogo = s.LogoUrl != null }),
            }),
            jamendo = _jamendo.GetStations().Select(j => new { name = j.Name, color = j.Color }),
        });
    }

    [HttpGet("radio/{number:int}/nowplaying")]
    [Authorize]
    public async Task<ActionResult> NowPlaying(int number, CancellationToken ct)
    {
        var st = await _radio.FindAsync(number, ct).ConfigureAwait(false);
        if (st is null)
        {
            return NotFound();
        }

        return Ok(new { title = await _icy.GetTitleAsync(st.Url, ct).ConfigureAwait(false) });
    }

    [HttpGet("radio/{number:int}/logo")]
    [AllowAnonymous]
    public async Task<ActionResult> RadioLogo(int number, [FromQuery] string? t, CancellationToken ct)
    {
        if (!_tickets.IsValid(t))
        {
            return Forbid();
        }

        return Logo(await _radio.GetLogoAsync(number, ct).ConfigureAwait(false));
    }

    /// <summary>
    /// Relays a station's stream. WHY relay at all: many stations are plain http, which
    /// an https page (Jellyfin through a reverse proxy, or the phone app off the LAN)
    /// refuses to play, and some send no CORS headers. Bandwidth is trivial (radio is
    /// 128-320 kbps). The relay ends when the listener disconnects.
    /// </summary>
    [HttpGet("radio/{number:int}/stream")]
    [AllowAnonymous]
    public async Task Stream(int number, [FromQuery] string? t, CancellationToken ct)
    {
        if (!_tickets.IsValid(t))
        {
            Response.StatusCode = StatusCodes.Status403Forbidden;
            return;
        }

        var st = await _radio.FindAsync(number, ct).ConfigureAwait(false);
        if (st is null)
        {
            Response.StatusCode = StatusCodes.Status404NotFound;
            return;
        }

        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, st.Url);
            using var resp = await _http.CreateClient(PluginServiceRegistrator.StreamClient)
                .SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
            if (!resp.IsSuccessStatusCode)
            {
                Response.StatusCode = StatusCodes.Status502BadGateway;
                return;
            }

            Response.ContentType = resp.Content.Headers.ContentType?.ToString() ?? "audio/mpeg";
            Response.Headers.CacheControl = "no-store";
            await using var src = await resp.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
            await src.CopyToAsync(Response.Body, 16 * 1024, ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // Listener tuned away or closed the tab: the normal way a relay ends.
        }
        catch (HttpRequestException ex)
        {
            _logger.LogInformation("Tuner: station {Number} unreachable: {Message}", number, ex.Message);
            if (!Response.HasStarted)
            {
                Response.StatusCode = StatusCodes.Status502BadGateway;
            }
        }
    }

    // ---- Jamendo ----

    [HttpGet("jamendo/{station}/tracks")]
    [Authorize]
    public async Task<ActionResult> JamendoTracks(string station, [FromQuery] int count = 20, CancellationToken ct = default)
    {
        // Jellyfin's serializer keeps C# PascalCase names; the client uses camelCase,
        // so shape the response explicitly rather than depend on serializer settings.
        var tracks = await _jamendo.GetBatchAsync(station, count, ct).ConfigureAwait(false);
        return Ok(tracks.Select(t => new
        {
            id = t.Id, name = t.Name, artist = t.Artist, album = t.Album, image = t.Image, duration = t.Duration,
            audio = t.Audio, downloadable = t.Downloadable, license = t.License, shareUrl = t.ShareUrl,
        }));
    }

    [HttpPost("jamendo/keep/{trackId}")]
    [Authorize]
    public async Task<ActionResult> JamendoKeep(string trackId, CancellationToken ct)
    {
        try
        {
            var (ok, message) = await _jamendo.KeepAsync(trackId, ct).ConfigureAwait(false);
            return ok ? Ok(new { message }) : BadRequest(new { message });
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or UnauthorizedAccessException)
        {
            _logger.LogWarning(ex, "Tuner: keep failed for Jamendo track {Track}", trackId);
            return StatusCode(StatusCodes.Status502BadGateway, new { message = "Couldn't save that track" });
        }
    }

    // A station or channel picture (LogoCache): a day in the browser, they rarely change.
    private ActionResult Logo((byte[] Bytes, string Type)? logo)
    {
        if (logo is null)
        {
            return NotFound();
        }

        Response.Headers.CacheControl = "private, max-age=86400";
        return File(logo.Value.Bytes, logo.Value.Type);
    }

    private IActionResult Embedded(string name, string type)
    {
        var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(name);
        if (stream is null)
        {
            return NotFound();
        }

        // The injected URL carries ?v=<plugin version>, so long caching is safe.
        Response.Headers.CacheControl = "public, max-age=604800";
        return File(stream, type + "; charset=utf-8");
    }
}
