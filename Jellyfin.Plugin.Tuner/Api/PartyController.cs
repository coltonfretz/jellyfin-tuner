using System.Collections.Concurrent;
using System.Globalization;
using Jellyfin.Plugin.Tuner.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Tuner.Api;

/// <summary>
/// Chat for SyncPlay groups (<see cref="PartyChat"/>). The page keeps one request open at a
/// time (a long poll): GET returns as soon as there's a new message, or after ~24 s with
/// none. Long polling instead of a WebSocket because it goes through ApiClient with the
/// user's normal sign-in and any reverse proxy, with nothing extra to set up.
/// </summary>
[ApiController]
[Route("Tuner/party")]
[Authorize]
public class PartyController : ControllerBase
{
    private readonly PartyChat _chat;
    private readonly ILogger<PartyController> _logger;

    public PartyController(PartyChat chat, ILogger<PartyController> logger)
    {
        _chat = chat;
        _logger = logger;
    }

    private static bool Enabled => Plugin.Instance?.Configuration.SyncPlayChat == true;

    private Guid UserId => Guid.TryParse(User.FindFirst("Jellyfin-UserId")?.Value, out var id) ? id : Guid.Empty;

    private string? DeviceId => User.FindFirst("Jellyfin-DeviceId")?.Value;

    [HttpGet]
    public async Task<ActionResult> Read([FromQuery] Guid group, [FromQuery] long after = 0, [FromQuery] long stage = -1, [FromQuery] bool wait = false, CancellationToken ct = default)
    {
        if (!Enabled)
        {
            return Ok(new { enabled = false });
        }

        try
        {
            var r = await _chat.ReadAsync(UserId, DeviceId, group, after, stage, wait, ct).ConfigureAwait(false);
            if (r is null)
            {
                return Ok(new { enabled = true, inGroup = false });
            }

            var (g, messages, st, version) = r.Value;
            Response.Headers.CacheControl = "no-store";
            return Ok(new
            {
                enabled = true,
                inGroup = true,
                group = g.Id,
                name = g.Name,
                me = g.Me,
                people = g.Participants,
                messages = messages.Select(m => new { id = m.Id, user = m.User, text = m.Text, at = m.At, system = m.System }),
                // The clock the stage's times are on, so pages can line up with it.
                now = DateTime.UtcNow,
                stageVersion = version,
                stage = st is null ? null : new { kind = st.Kind, id = st.Id, by = st.By, playing = st.Playing, position = st.Position, at = st.At },
            });
        }
        catch (OperationCanceledException)
        {
            // The page went away mid-wait.
            return new EmptyResult();
        }
    }

    public class StageBody
    {
        public string? Action { get; set; }

        public string? Url { get; set; }

        public double? Position { get; set; }
    }

    [HttpPost("stage")]
    public ActionResult Stage([FromBody] StageBody body)
    {
        if (!Enabled)
        {
            return NotFound();
        }

        var (ok, error) = _chat.Control(UserId, DeviceId, body?.Action ?? string.Empty, body?.Url, body?.Position);
        return ok ? Ok(new { ok = true }) : BadRequest(new { message = error });
    }

    public class PostBody
    {
        public string? Text { get; set; }
    }

    [HttpPost]
    public ActionResult Post([FromBody] PostBody body)
    {
        if (!Enabled)
        {
            return NotFound();
        }

        var (ok, error) = _chat.Post(UserId, DeviceId, body?.Text ?? string.Empty);
        return ok ? Ok(new { ok = true }) : BadRequest(new { message = error });
    }

    public class ReportBody
    {
        public string? Problem { get; set; }

        public string? Kind { get; set; }

        public string? VideoId { get; set; }

        public int? Code { get; set; }

        public bool? Live { get; set; }

        public string? Agent { get; set; }
    }

    // Per user: when their recent reports came in, so a page stuck in a loop can't flood the log.
    private static readonly ConcurrentDictionary<Guid, Queue<DateTime>> ReportTimes = new();

    /// <summary>
    /// A shared video that failed on someone's screen. YouTube and Twitch play in the viewer's
    /// browser, so without this the server never learns why (watch party 2026-11-14: the
    /// Jellyfin Desktop app and an iPhone failed and nothing in any log said why). Written to
    /// Jellyfin's log as one warning line: user, app, device, what failed, browser.
    /// </summary>
    [HttpPost("report")]
    public ActionResult Report([FromBody] ReportBody body)
    {
        if (!Enabled || body is null)
        {
            return NotFound();
        }

        var now = DateTime.UtcNow;
        var times = ReportTimes.GetOrAdd(UserId, _ => new Queue<DateTime>());
        lock (times)
        {
            while (times.Count > 0 && now - times.Peek() > TimeSpan.FromMinutes(10))
            {
                times.Dequeue();
            }

            if (times.Count >= 20)
            {
                return Ok(new { ok = false });
            }

            times.Enqueue(now);
        }

        _logger.LogWarning(
            "Tuner watch together: {Problem} for {User} on {Client} {Version} ({Device}): {Kind} {VideoId} code={Code} live={Live} agent=\"{Agent}\"",
            Clean(body.Problem, 40),
            User.Identity?.Name ?? "?",
            Clean(User.FindFirst("Jellyfin-Client")?.Value, 60),
            Clean(User.FindFirst("Jellyfin-Version")?.Value, 30),
            Clean(User.FindFirst("Jellyfin-Device")?.Value, 60),
            Clean(body.Kind, 12),
            Clean(body.VideoId, 40),
            body.Code?.ToString(CultureInfo.InvariantCulture) ?? "-",
            body.Live == true ? "yes" : "no",
            Clean(body.Agent, 300));
        return Ok(new { ok = true });
    }

    // Page-supplied text goes into a log line: short, one line, printable only.
    private static string Clean(string? s, int max)
    {
        if (string.IsNullOrWhiteSpace(s))
        {
            return "-";
        }

        var chars = s.Where(c => !char.IsControl(c)).Take(max).ToArray();
        return new string(chars).Replace('"', '\'');
    }
}
