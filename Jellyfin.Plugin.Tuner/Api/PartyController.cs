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
    public async Task<ActionResult> Read([FromQuery] Guid group, [FromQuery] long after = 0, [FromQuery] bool wait = false, CancellationToken ct = default)
    {
        if (!Enabled)
        {
            return Ok(new { enabled = false });
        }

        try
        {
            var r = await _chat.ReadAsync(UserId, DeviceId, group, after, wait, ct).ConfigureAwait(false);
            if (r is null)
            {
                return Ok(new { enabled = true, inGroup = false });
            }

            var (g, messages) = r.Value;
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
            });
        }
        catch (OperationCanceledException)
        {
            // The page went away mid-wait.
            return new EmptyResult();
        }
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
