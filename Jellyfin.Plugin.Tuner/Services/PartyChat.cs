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
    public async Task<(Group Group, List<Message> Messages)?> ReadAsync(Guid userId, string? deviceId, Guid knownGroup, long after, bool wait, CancellationToken ct)
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
            lock (_lock)
            {
                room = Touch(group);
                // A different group than the page knew: send it that group's whole history.
                var from = group.Id == knownGroup ? after : 0;
                messages = room.Messages.Where(m => m.Id > from).ToList();
                signal = room.Signal.Task;
            }

            var left = deadline - DateTime.UtcNow;
            if (messages.Count > 0 || left <= TimeSpan.Zero)
            {
                return (group, messages);
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

        // Wake everyone waiting, then arm a fresh signal for the next message.
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

        public TaskCompletionSource Signal { get; set; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    }
}
