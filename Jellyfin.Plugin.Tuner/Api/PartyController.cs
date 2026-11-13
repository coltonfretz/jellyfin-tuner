using Jellyfin.Plugin.Tuner.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

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

    public PartyController(PartyChat chat)
    {
        _chat = chat;
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
}
