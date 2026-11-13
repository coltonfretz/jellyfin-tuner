using System.Text.RegularExpressions;
using MediaBrowser.Controller.Session;
using MediaBrowser.Controller.SyncPlay;
using MediaBrowser.Controller.SyncPlay.Requests;

namespace Jellyfin.Plugin.Tuner.Services;

/// <summary>
/// Chat for SyncPlay groups ("Watch together"). Jellyfin's SyncPlay keeps everyone's
/// playback in step but has no way to talk, so this adds a room per group.
///
/// Membership comes from Jellyfin's own SyncPlay manager on every call: you can read and
/// write a group's chat only while you are one of its participants. WHY not trust a group
/// id from the page: /SyncPlay/List shows every group's id to anyone with SyncPlay access.
/// Jellyfin only says which USER is in a group, not which device, so the chat shows on all
/// of a member's open Jellyfin windows.
///
/// Messages live in memory only (the last <see cref="Keep"/> per group) and are dropped as
/// soon as the group ends (noticed by the next request from someone who was in it), after
/// <see cref="RoomIdle"/> with nobody asking, or when the server restarts. Nothing is written
/// to disk.
/// </summary>
public class PartyChat
{
    private const int Keep = 200;
    public const int MaxLength = 500;
    private static readonly TimeSpan RoomIdle = TimeSpan.FromMinutes(10);

    private readonly ISyncPlayManager _syncPlay;
    private readonly ISessionManager _sessions;
    private readonly object _lock = new();
    private readonly Dictionary<Guid, Room> _rooms = new();

    public PartyChat(ISyncPlayManager syncPlay, ISessionManager sessions)
    {
        _syncPlay = syncPlay;
        _sessions = sessions;
    }

    public record Message(long Id, string User, string Text, DateTime At, bool System);

    public record Group(Guid Id, string Name, string Me, IReadOnlyList<string> Participants);

    /// <summary>
    /// A video the group is watching together instead of (or between) Jellyfin's own:
    /// Kind "youtube" (Id = video id, kept in step), "twitch" (Id = channel, live) or
    /// "twitchvod" (Id = a past broadcast's number). Twitch isn't kept in step. Position is in seconds at
    /// <see cref="At"/>; while Playing, it moves on with the clock from there.
    /// </summary>
    public record Stage(long Version, string Kind, string Id, string By, bool Playing, double Position, DateTime At);

    /// <summary>The SyncPlay group this user is in right now, or null.</summary>
    public Group? Find(Guid userId, string? deviceId)
    {
        if (userId == Guid.Empty)
        {
            return null;
        }

        // Any of the user's sessions will do: ListGroups only uses it to know who is asking.
        var mine = _sessions.Sessions.Where(s => s.UserId.Equals(userId)).ToList();
        var session = mine.FirstOrDefault(s => s.DeviceId == deviceId) ?? mine.FirstOrDefault();
        if (session is null || string.IsNullOrEmpty(session.UserName))
        {
            return null;
        }

        var me = session.UserName;
        var active = _syncPlay.IsUserActive(userId);
        bool hadRoom;
        lock (_lock)
        {
            hadRoom = _rooms.Values.Any(r => r.People.Contains(me));
        }

        if (!active && !hadRoom)
        {
            return null;
        }

        var groups = _syncPlay.ListGroups(session, new ListGroupsRequest());
        if (hadRoom)
        {
            // A group that's gone (its last person left) takes its chat with it, so the next
            // group starts clean. Only rooms this person was in: they could see that group, so
            // its absence from their list means it ended.
            lock (_lock)
            {
                foreach (var gone in _rooms.Where(r => r.Value.People.Contains(me) && !groups.Any(g => g.GroupId == r.Key)).Select(r => r.Key).ToList())
                {
                    _rooms.Remove(gone);
                }
            }
        }

        if (!active)
        {
            return null;
        }

        var group = groups.FirstOrDefault(g => g.Participants.Any(p => string.Equals(p, me, StringComparison.OrdinalIgnoreCase)));
        if (group is null)
        {
            return null;
        }

        // Someone on two devices is listed twice; the chat shows people, not devices.
        var people = group.Participants.Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        return new Group(group.GroupId, group.GroupName, me, people);
    }

    /// <summary>
    /// Messages after <paramref name="after"/>. With <paramref name="wait"/>, holds the request
    /// open until there is one (or the time is up), so the page needn't ask every second.
    /// Returns null once the user is no longer in a group.
    /// </summary>
    public async Task<(Group Group, List<Message> Messages, Stage? Stage, long StageVersion)?> ReadAsync(Guid userId, string? deviceId, Guid knownGroup, long after, long knownStage, bool wait, CancellationToken ct)
    {
        var deadline = DateTime.UtcNow.AddSeconds(wait ? 24 : 0);
        while (true)
        {
            var group = Find(userId, deviceId);
            if (group is null)
            {
                return null;
            }

            Room room;
            Task signal;
            List<Message> messages;
            Stage? stage;
            long stageVersion;
            bool stageNews;
            lock (_lock)
            {
                room = Touch(group);
                // A different group than the page knew: send it that group's whole history.
                var from = group.Id == knownGroup ? after : 0;
                messages = room.Messages.Where(m => m.Id > from).ToList();
                stage = room.Stage;
                stageVersion = room.StageVersion;
                stageNews = group.Id != knownGroup || room.StageVersion != knownStage;
                signal = room.Signal.Task;
            }

            var left = deadline - DateTime.UtcNow;
            if (messages.Count > 0 || stageNews || left <= TimeSpan.Zero)
            {
                return (group, messages, stage, stageVersion);
            }

            // Wake on a new message, or every few seconds to notice joins, leaves and the group ending.
            var nap = left < TimeSpan.FromSeconds(3) ? left : TimeSpan.FromSeconds(3);
            await Task.WhenAny(signal, Task.Delay(nap, ct)).ConfigureAwait(false);
            ct.ThrowIfCancellationRequested();
        }
    }

    /// <summary>Adds a message from this user to their group. False when they aren't in one.</summary>
    public (bool Ok, string? Error) Post(Guid userId, string? deviceId, string text)
    {
        text = (text ?? string.Empty).Trim();
        if (text.Length == 0)
        {
            return (false, "Empty message");
        }

        if (text.Length > MaxLength)
        {
            text = text[..MaxLength];
        }

        var group = Find(userId, deviceId);
        if (group is null)
        {
            return (false, "You're not in a SyncPlay group");
        }

        lock (_lock)
        {
            var room = Touch(group);
            // Ten messages in ten seconds is plenty for people; it stops a stuck key or a script.
            var now = DateTime.UtcNow;
            room.Recent.RemoveAll(t => now - t.At > TimeSpan.FromSeconds(10));
            if (room.Recent.Count(t => t.User == group.Me) >= 10)
            {
                return (false, "Slow down a little");
            }

            room.Recent.Add((group.Me, now));
            Add(room, group.Me, text, false);
        }

        return (true, null);
    }

    /// <summary>
    /// Starts, steers or stops the group's shared video. Anyone in the group may: it's their
    /// evening, not the server owner's. Actions: share (with a YouTube or Twitch link),
    /// play, pause, seek (with a position), stop.
    /// </summary>
    public (bool Ok, string? Error) Control(Guid userId, string? deviceId, string action, string? url, double? position)
    {
        var group = Find(userId, deviceId);
        if (group is null)
        {
            return (false, "You're not in a SyncPlay group");
        }

        var pos = Math.Clamp(position ?? 0, 0, 7 * 24 * 3600);
        lock (_lock)
        {
            var room = Touch(group);
            var now = DateTime.UtcNow;
            room.Controls.RemoveAll(t => now - t > TimeSpan.FromSeconds(10));
            if (room.Controls.Count >= 40)
            {
                return (false, "Slow down a little");
            }

            room.Controls.Add(now);
            var st = room.Stage;
            switch (action)
            {
                case "share":
                    var link = ParseLink(url);
                    if (link is null)
                    {
                        return (false, "That isn't a YouTube or Twitch link");
                    }

                    room.Stage = new Stage(++room.StageVersion, link.Value.Kind, link.Value.Id, group.Me, true, link.Value.Start, now);
                    Add(room, group.Me, $"{group.Me} shared a {link.Value.Kind switch { "youtube" => "YouTube video", "twitch" => "Twitch stream", _ => "Twitch video" }}", true);
                    return (true, null);
                case "stop":
                    if (st is null)
                    {
                        return (true, null);
                    }

                    room.Stage = null;
                    room.StageVersion++;
                    Add(room, group.Me, $"{group.Me} stopped the shared video", true);
                    return (true, null);
                case "play":
                case "pause":
                case "seek":
                    if (st is null)
                    {
                        return (false, "Nothing is being shared");
                    }

                    var playing = action == "play" || (action == "seek" && st.Playing);
                    room.Stage = st with { Version = ++room.StageVersion, Playing = playing, Position = pos, At = now };
                    Pulse(room);
                    return (true, null);
                default:
                    return (false, "Unknown action");
            }
        }
    }

    private static readonly Regex YouTubeId = new("^[A-Za-z0-9_-]{11}$", RegexOptions.Compiled);
    private static readonly Regex TwitchName = new("^[A-Za-z0-9_]{3,25}$", RegexOptions.Compiled);

    /// <summary>
    /// A YouTube video or Twitch channel/video from a pasted link, or null. Only ids that
    /// match each site's own format come out, so the page never puts anything else in a frame.
    /// </summary>
    public static (string Kind, string Id, double Start)? ParseLink(string? text)
    {
        if (!Uri.TryCreate((text ?? string.Empty).Trim(), UriKind.Absolute, out var u)
            || (u.Scheme != Uri.UriSchemeHttps && u.Scheme != Uri.UriSchemeHttp))
        {
            return null;
        }

        var host = u.Host.ToLowerInvariant();
        if (host.StartsWith("www.", StringComparison.Ordinal) || host.StartsWith("m.", StringComparison.Ordinal))
        {
            host = host[(host.IndexOf('.') + 1)..];
        }

        var parts = u.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries);
        var query = System.Web.HttpUtility.ParseQueryString(u.Query);
        if (host is "youtube.com" or "youtu.be" or "youtube-nocookie.com" or "music.youtube.com")
        {
            string? id = null;
            if (host == "youtu.be")
            {
                id = parts.FirstOrDefault();
            }
            else if (parts.Length == 1 && parts[0] == "watch")
            {
                id = query["v"];
            }
            else if (parts.Length >= 2 && parts[0] is "live" or "shorts" or "embed" or "v")
            {
                id = parts[1];
            }

            return id != null && YouTubeId.IsMatch(id) ? ("youtube", id, ParseStart(query["t"] ?? query["start"])) : null;
        }

        if (host is "twitch.tv" or "go.twitch.tv")
        {
            if (parts.Length >= 2 && parts[0] == "videos" && long.TryParse(parts[1], out var vod))
            {
                return ("twitchvod", vod.ToString(System.Globalization.CultureInfo.InvariantCulture), 0);
            }

            if (parts.Length == 1 && TwitchName.IsMatch(parts[0]))
            {
                return ("twitch", parts[0].ToLowerInvariant(), 0);
            }
        }

        return null;
    }

    // YouTube's t=: 90, 90s or 1h2m3s.
    private static double ParseStart(string? t)
    {
        if (string.IsNullOrEmpty(t))
        {
            return 0;
        }

        if (double.TryParse(t.TrimEnd('s'), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var secs))
        {
            return Math.Max(0, secs);
        }

        var m = Regex.Match(t, @"^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$");
        return m.Success
            ? (m.Groups[1].Success ? int.Parse(m.Groups[1].Value, System.Globalization.CultureInfo.InvariantCulture) * 3600 : 0)
              + (m.Groups[2].Success ? int.Parse(m.Groups[2].Value, System.Globalization.CultureInfo.InvariantCulture) * 60 : 0)
              + (m.Groups[3].Success ? int.Parse(m.Groups[3].Value, System.Globalization.CultureInfo.InvariantCulture) : 0)
            : 0;
    }

    // Callers hold _lock.
    private Room Touch(Group group)
    {
        var now = DateTime.UtcNow;
        foreach (var stale in _rooms.Where(r => now - r.Value.Touched > RoomIdle).Select(r => r.Key).ToList())
        {
            _rooms.Remove(stale);
        }

        if (!_rooms.TryGetValue(group.Id, out var room))
        {
            room = new Room { People = new HashSet<string>(group.Participants, StringComparer.OrdinalIgnoreCase) };
            _rooms[group.Id] = room;
        }

        room.Touched = now;

        // Joins and leaves as lines in the chat, noticed whenever anyone in the group asks.
        var people = new HashSet<string>(group.Participants, StringComparer.OrdinalIgnoreCase);
        foreach (var p in group.Participants.Where(p => !room.People.Contains(p)))
        {
            Add(room, p, $"{p} joined", true);
        }

        foreach (var p in room.People.Where(p => !people.Contains(p)).ToList())
        {
            Add(room, p, $"{p} left", true);
        }

        room.People = people;
        return room;
    }

    private static void Add(Room room, string user, string text, bool system)
    {
        room.Messages.Add(new Message(++room.LastId, user, text, DateTime.UtcNow, system));
        if (room.Messages.Count > Keep)
        {
            room.Messages.RemoveRange(0, room.Messages.Count - Keep);
        }

        Pulse(room);
    }

    // Wake everyone waiting, then arm a fresh signal for the next change.
    private static void Pulse(Room room)
    {
        var fired = room.Signal;
        room.Signal = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        fired.TrySetResult();
    }

    private sealed class Room
    {
        public List<Message> Messages { get; } = new();

        public long LastId { get; set; }

        public HashSet<string> People { get; set; } = new();

        public List<(string User, DateTime At)> Recent { get; } = new();

        public DateTime Touched { get; set; }

        public Stage? Stage { get; set; }

        public long StageVersion { get; set; }

        public List<DateTime> Controls { get; } = new();

        public TaskCompletionSource Signal { get; set; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    }
}
