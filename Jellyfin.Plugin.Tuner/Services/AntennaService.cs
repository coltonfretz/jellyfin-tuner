using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using MediaBrowser.Controller.MediaEncoding;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Tuner.Services;

public sealed record AntennaChannel(string Number, string Name, string Url);

/// <summary>
/// Over-the-air channels from the HDHomeRun, for TV surf mode.
///
/// WHY transcode here instead of adding the HDHomeRun to Jellyfin's Live TV: same
/// reason as the free channels (opening a channel through Live TV is slow), plus
/// broadcast TV is MPEG-2 video, which no browser decodes. So each channel someone
/// is watching gets one ffmpeg (Jellyfin's own build) turning the tuner's MPEG-TS
/// into a short rolling H.264 HLS playlist in a temp folder. Viewers of the same
/// channel share it; it stops when nobody has asked for it for a little while.
///
/// Cost measured 2026-10-15 on the i7-8700B node, software x264 ultrafast:
/// ~0.9 core for a 720p60 channel (downsampled to 30 fps), ~1.3 cores for 1080i.
/// </summary>
public sealed partial class AntennaService : IDisposable
{
    private static readonly TimeSpan LineupTtl = TimeSpan.FromMinutes(10);
    private static readonly TimeSpan GuideTtl = TimeSpan.FromMinutes(15);

    // A session nobody has fetched a playlist or segment from in this long is stopped.
    // hls.js asks for the playlist every ~2 s, so this only trips once the tab is gone.
    private static readonly TimeSpan IdleStop = TimeSpan.FromSeconds(20);

    // Surfing: when both tuners are busy, a session untouched this long may be taken
    // over (that viewer has already moved on and their release call got lost).
    private static readonly TimeSpan StealAfter = TimeSpan.FromSeconds(4);

    private readonly IHttpClientFactory _http;
    private readonly IMediaEncoder _encoder;
    private readonly ILogger<AntennaService> _logger;
    private readonly string _root = Path.Combine(Path.GetTempPath(), "tuner-antenna");
    private readonly object _lock = new();
    private readonly Dictionary<string, Session> _sessions = new();
    private readonly LogoCache _logos;
    private readonly SemaphoreSlim _lineupLock = new(1, 1);
    private readonly SemaphoreSlim _guideLock = new(1, 1);
    private readonly Timer _reaper;
    private IReadOnlyList<AntennaChannel> _lineup = Array.Empty<AntennaChannel>();
    private DateTime _lineupAt = DateTime.MinValue;
    private Dictionary<string, List<TvProgram>> _guide = new();
    private Dictionary<string, string> _logoUrls = new();
    private DateTime _guideAt = DateTime.MinValue;
    private int _tuners = 2;

    public AntennaService(IHttpClientFactory http, IMediaEncoder encoder, ILogger<AntennaService> logger)
    {
        _http = http;
        _encoder = encoder;
        _logger = logger;
        _logos = new LogoCache(http);
        try
        {
            // Leftovers from a previous run (the process was killed mid-stream).
            if (Directory.Exists(_root))
            {
                Directory.Delete(_root, true);
            }
        }
        catch (IOException)
        {
        }

        _reaper = new Timer(_ => Reap(), null, TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(5));
    }

    private static string BaseUrl => (Plugin.Instance?.Configuration.HdhomerunUrl ?? string.Empty).TrimEnd('/');

    public bool Enabled => BaseUrl.Length > 0;

    private static HashSet<string> Hidden => Split(Plugin.Instance?.Configuration.AntennaHidden).ToHashSet(StringComparer.Ordinal);

    // "7.1=PBS (WJCT); 12.1=NBC (WTLV)": broadcast call signs mean little to most viewers.
    private static Dictionary<string, string> Renames => Split(Plugin.Instance?.Configuration.AntennaNames, ';')
        .Select(p => p.Split('=', 2))
        .Where(p => p.Length == 2)
        .GroupBy(p => p[0].Trim())
        .ToDictionary(g => g.Key, g => g.Last()[1].Trim(), StringComparer.Ordinal);

    private static IEnumerable<string> Split(string? s, char sep = ',')
        => (s ?? string.Empty).Split(sep, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

    // "4.1" sorts as major 4, minor 1 (so 9.12 lands after 9.5, not before it).
    public static (int Major, int Minor) SortKey(string number)
    {
        var parts = number.Split('.');
        return (int.TryParse(parts[0], out var a) ? a : 0, parts.Length > 1 && int.TryParse(parts[1], out var b) ? b : 0);
    }

    public async Task<IReadOnlyList<AntennaChannel>> GetLineupAsync(CancellationToken ct)
    {
        if (DateTime.UtcNow - _lineupAt < LineupTtl)
        {
            return _lineup;
        }

        await _lineupLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (DateTime.UtcNow - _lineupAt < LineupTtl)
            {
                return _lineup;
            }

            var client = _http.CreateClient(PluginServiceRegistrator.ApiClient);
            using (var doc = JsonDocument.Parse(await client.GetStringAsync(BaseUrl + "/discover.json", ct).ConfigureAwait(false)))
            {
                if (doc.RootElement.TryGetProperty("TunerCount", out var tc) && tc.TryGetInt32(out var n) && n > 0)
                {
                    _tuners = n;
                }
            }

            var hidden = Hidden;
            var names = Renames;
            var list = new List<AntennaChannel>();
            using (var doc = JsonDocument.Parse(await client.GetStringAsync(BaseUrl + "/lineup.json", ct).ConfigureAwait(false)))
            {
                foreach (var c in doc.RootElement.EnumerateArray())
                {
                    var number = c.GetProperty("GuideNumber").GetString() ?? string.Empty;
                    var url = c.TryGetProperty("URL", out var u) ? u.GetString() : null;
                    if (!ChannelNumberRegex().IsMatch(number) || url is null || hidden.Contains(number)
                        || (c.TryGetProperty("DRM", out var drm) && drm.ValueKind == JsonValueKind.Number && drm.GetInt32() == 1))
                    {
                        continue;
                    }

                    var name = names.GetValueOrDefault(number) ?? c.GetProperty("GuideName").GetString() ?? number;
                    list.Add(new AntennaChannel(number, name, url));
                }
            }

            _lineup = list.OrderBy(c => SortKey(c.Number)).ToList();
            _lineupAt = DateTime.UtcNow;
            return _lineup;
        }
        catch (Exception ex) when (ex is HttpRequestException or JsonException or TaskCanceledException or KeyNotFoundException or InvalidOperationException)
        {
            // The tuner is on Wi-Fi via an extender; a blip shouldn't empty the lineup.
            _logger.LogWarning(ex, "Tuner: could not read the HDHomeRun lineup");
            return _lineup;
        }
        finally
        {
            _lineupLock.Release();
        }
    }

    /// <summary>
    /// Now and next per channel from SiliconDust's guide service. WHY this source: it
    /// comes free with the device (authenticated by the tuner's own rotating DeviceAuth)
    /// and covers ~4-7 h ahead, which is all an info bar shows.
    /// </summary>
    public async Task<Dictionary<string, (TvProgram? Now, TvProgram? Next)>> GetNowNextAsync(CancellationToken ct)
    {
        await EnsureGuideAsync(ct).ConfigureAwait(false);
        var now = DateTimeOffset.UtcNow;
        var result = new Dictionary<string, (TvProgram?, TvProgram?)>();
        foreach (var (number, list) in _guide)
        {
            var cur = list.FirstOrDefault(p => p.Start <= now && now < p.End);
            var next = list.FirstOrDefault(p => p.Start >= (cur?.End ?? now));
            result[number] = (cur, next);
        }

        return result;
    }

    private async Task EnsureGuideAsync(CancellationToken ct)
    {
        if (DateTime.UtcNow - _guideAt < GuideTtl)
        {
            return;
        }

        await _guideLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (DateTime.UtcNow - _guideAt < GuideTtl)
            {
                return;
            }

            var client = _http.CreateClient(PluginServiceRegistrator.ApiClient);
            string auth;
            using (var doc = JsonDocument.Parse(await client.GetStringAsync(BaseUrl + "/discover.json", ct).ConfigureAwait(false)))
            {
                auth = doc.RootElement.GetProperty("DeviceAuth").GetString() ?? string.Empty;
            }

            var guide = new Dictionary<string, List<TvProgram>>();
            var logos = new Dictionary<string, string>();
            var json = await client.GetStringAsync("https://api.hdhomerun.com/api/guide?DeviceAuth=" + Uri.EscapeDataString(auth), ct).ConfigureAwait(false);
            using (var doc = JsonDocument.Parse(json))
            {
                foreach (var ch in doc.RootElement.EnumerateArray())
                {
                    var number = ch.GetProperty("GuideNumber").GetString() ?? string.Empty;
                    if (ch.TryGetProperty("ImageURL", out var img) && img.GetString() is { Length: > 0 } imgUrl)
                    {
                        logos[number] = imgUrl;
                    }

                    if (!ch.TryGetProperty("Guide", out var progs))
                    {
                        continue;
                    }

                    var list = new List<TvProgram>();
                    foreach (var p in progs.EnumerateArray())
                    {
                        var title = p.GetProperty("Title").GetString() ?? string.Empty;
                        if (p.TryGetProperty("EpisodeTitle", out var ep) && ep.GetString() is { Length: > 0 } epTitle)
                        {
                            title += ": " + epTitle;
                        }

                        list.Add(new TvProgram(
                            title,
                            DateTimeOffset.FromUnixTimeSeconds(p.GetProperty("StartTime").GetInt64()),
                            DateTimeOffset.FromUnixTimeSeconds(p.GetProperty("EndTime").GetInt64())));
                    }

                    list.Sort((a, b) => a.Start.CompareTo(b.Start));
                    guide[number] = list;
                }
            }

            _guide = guide;
            _logoUrls = logos;
            _guideAt = DateTime.UtcNow;
        }
        catch (Exception ex) when (ex is HttpRequestException or JsonException or TaskCanceledException or KeyNotFoundException or InvalidOperationException)
        {
            // An old guide beats no guide; try again in a minute.
            _logger.LogWarning(ex, "Tuner: could not read the HDHomeRun guide");
            _guideAt = DateTime.UtcNow - GuideTtl + TimeSpan.FromMinutes(1);
        }
        finally
        {
            _guideLock.Release();
        }
    }

    public async Task<(byte[] Bytes, string Type)?> GetLogoAsync(string number, CancellationToken ct)
    {
        await EnsureGuideAsync(ct).ConfigureAwait(false);
        return await _logos.GetAsync(_logoUrls.GetValueOrDefault(number), ct).ConfigureAwait(false);
    }

    // ---------------- live sessions ----------------

    private sealed class Session
    {
        public required string Number { get; init; }

        public required string Dir { get; init; }

        public required Process Proc { get; init; }

        public DateTime LastAccess { get; set; } = DateTime.UtcNow;

        // Last request per viewer (keyed by their ticket), so one viewer leaving doesn't
        // cut off another watching the same channel.
        public Dictionary<string, DateTime> Viewers { get; } = new(StringComparer.Ordinal);

        public StringBuilder Errors { get; } = new();

        public bool Stopped { get; set; }

        public void Touch(string ticket)
        {
            LastAccess = DateTime.UtcNow;
            Viewers[ticket] = LastAccess;
        }
    }

    public enum PlaylistResult
    {
        Ok,
        UnknownChannel,
        TunersBusy,
        Failed,
    }

    /// <summary>
    /// The channel's live playlist, starting it if needed, with every segment URL
    /// carrying the viewer's ticket (hls.js drops the query when resolving relative URLs).
    /// Waits for the first segment so the player never sees an empty playlist.
    /// </summary>
    public async Task<(PlaylistResult Result, string? Playlist)> GetPlaylistAsync(string number, string ticket, CancellationToken ct)
    {
        var ch = (await GetLineupAsync(ct).ConfigureAwait(false)).FirstOrDefault(c => c.Number == number);
        if (ch is null)
        {
            return (PlaylistResult.UnknownChannel, null);
        }

        Session? s;
        lock (_lock)
        {
            if (!_sessions.TryGetValue(number, out s) || s.Proc.HasExited)
            {
                if (s is not null)
                {
                    StopLocked(s);
                }

                if (_sessions.Count >= _tuners)
                {
                    var victim = _sessions.Values.Where(x => DateTime.UtcNow - x.LastAccess > StealAfter).OrderBy(x => x.LastAccess).FirstOrDefault();
                    if (victim is null)
                    {
                        return (PlaylistResult.TunersBusy, null);
                    }

                    StopLocked(victim);
                }

                s = Start(ch);
                if (s is null)
                {
                    return (PlaylistResult.Failed, null);
                }

                _sessions[number] = s;
            }

            s.Touch(ticket);
        }

        var index = Path.Combine(s.Dir, "index.m3u8");
        var deadline = DateTime.UtcNow.AddSeconds(15);
        while (true)
        {
            if (File.Exists(index))
            {
                string text;
                try
                {
                    text = await File.ReadAllTextAsync(index, ct).ConfigureAwait(false);
                }
                catch (IOException)
                {
                    text = string.Empty;   // ffmpeg mid-rename; next poll gets it
                }

                if (text.Contains("#EXTINF", StringComparison.Ordinal))
                {
                    var t = "?t=" + Uri.EscapeDataString(ticket);
                    var lines = text.Split('\n').Select(l => l.Length > 0 && l[0] != '#' ? l.TrimEnd('\r') + t : l);
                    return (PlaylistResult.Ok, string.Join('\n', lines));
                }
            }

            if (s.Proc.HasExited || DateTime.UtcNow > deadline)
            {
                lock (_lock)
                {
                    _logger.LogWarning("Tuner: antenna {Number} did not start: {Errors}", number, s.Errors.ToString().Trim());
                    StopLocked(s);
                }

                return (PlaylistResult.Failed, null);
            }

            await Task.Delay(200, ct).ConfigureAwait(false);
        }
    }

    /// <summary>Path of a segment of a running session, or null. Also counts as activity.</summary>
    public string? SegmentPath(string number, string name, string ticket)
    {
        if (!SegmentNameRegex().IsMatch(name))
        {
            return null;
        }

        lock (_lock)
        {
            if (!_sessions.TryGetValue(number, out var s))
            {
                return null;
            }

            s.Touch(ticket);
            var path = Path.Combine(s.Dir, name);
            return File.Exists(path) ? path : null;
        }
    }

    /// <summary>
    /// Viewer tuned away: frees the tuner right away (surfing would otherwise hold
    /// both tuners for the idle timeout) unless someone else is still watching.
    /// </summary>
    public void Release(string number, string ticket)
    {
        lock (_lock)
        {
            if (!_sessions.TryGetValue(number, out var s))
            {
                return;
            }

            s.Viewers.Remove(ticket);
            if (!s.Viewers.Values.Any(t => DateTime.UtcNow - t < TimeSpan.FromSeconds(6)))
            {
                StopLocked(s);
            }
        }
    }

    private Session? Start(AntennaChannel ch)
    {
        var dir = Path.Combine(_root, ch.Number + "-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(dir);
        var psi = new ProcessStartInfo(_encoder.EncoderPath)
        {
            RedirectStandardError = true,
            RedirectStandardOutput = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        foreach (var a in new[]
        {
            "-hide_banner", "-nostats", "-loglevel", "error",
            // Over-the-air streams start mid-GOP and carry the odd damaged packet.
            "-fflags", "+genpts+discardcorrupt",
            // ffmpeg's default 5 s of stream analysis was most of a 7 s tune; 1.5 s is
            // enough to find the video and AC-3 tracks (first segment in ~3 s, measured).
            "-probesize", "2M", "-analyzeduration", "1500000",
            "-i", ch.Url,
            "-map", "0:v:0", "-map", "0:a:0?",
            // Deinterlace only frames flagged interlaced (1080i), cap at 30 fps (720p60
            // channels cost half as much) and at 720 lines (SD stays SD).
            "-vf", "yadif=0:-1:1,fps=30000/1001,scale=-2:'min(720,ih)'",
            "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
            "-crf", "23", "-maxrate", "6M", "-bufsize", "12M", "-pix_fmt", "yuv420p",
            // Keyframe every 2 s exactly, so every 2 s segment can start playback.
            "-g", "60", "-keyint_min", "60", "-sc_threshold", "0",
            "-c:a", "aac", "-b:a", "128k", "-ac", "2",
            "-f", "hls", "-hls_time", "2", "-hls_list_size", "6",
            "-hls_flags", "delete_segments+independent_segments+omit_endlist",
            "-hls_segment_filename", Path.Combine(dir, "seg%05d.ts"),
            Path.Combine(dir, "index.m3u8"),
        })
        {
            psi.ArgumentList.Add(a);
        }

        try
        {
            var proc = Process.Start(psi)!;
            var s = new Session { Number = ch.Number, Dir = dir, Proc = proc };
            proc.ErrorDataReceived += (_, e) =>
            {
                if (e.Data is null)
                {
                    return;
                }

                lock (s.Errors)
                {
                    if (s.Errors.Length < 2000)
                    {
                        s.Errors.AppendLine(e.Data);
                    }
                }
            };
            proc.BeginErrorReadLine();
            proc.BeginOutputReadLine();
            _logger.LogInformation("Tuner: antenna {Number} started", ch.Number);
            return s;
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            _logger.LogError(ex, "Tuner: could not start ffmpeg for antenna {Number}", ch.Number);
            TryDelete(dir);
            return null;
        }
    }

    // Safe to call twice and on a session that's already been replaced: two viewers can
    // both notice a failed start, and the second must not take down the session the
    // first one has since started on the same channel (it would run on, holding a
    // tuner, with nothing left to stop it).
    private void StopLocked(Session s)
    {
        if (s.Stopped)
        {
            return;
        }

        s.Stopped = true;
        if (_sessions.TryGetValue(s.Number, out var current) && current == s)
        {
            _sessions.Remove(s.Number);
        }

        try
        {
            if (!s.Proc.HasExited)
            {
                // Frees the HDHomeRun tuner as soon as the TCP stream closes.
                s.Proc.Kill(true);
            }
        }
        catch (InvalidOperationException)
        {
        }

        s.Proc.Dispose();
        TryDelete(s.Dir);
        _logger.LogInformation("Tuner: antenna {Number} stopped", s.Number);
    }

    private void Reap()
    {
        lock (_lock)
        {
            foreach (var s in _sessions.Values.Where(x => DateTime.UtcNow - x.LastAccess > IdleStop || x.Proc.HasExited).ToList())
            {
                StopLocked(s);
            }
        }
    }

    private static void TryDelete(string dir)
    {
        try
        {
            if (Directory.Exists(dir))
            {
                Directory.Delete(dir, true);
            }
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }

    public void Dispose()
    {
        _reaper.Dispose();
        lock (_lock)
        {
            foreach (var s in _sessions.Values.ToList())
            {
                StopLocked(s);
            }
        }

        _lineupLock.Dispose();
        _guideLock.Dispose();
    }

    public static bool IsChannelNumber(string s) => ChannelNumberRegex().IsMatch(s);

    [GeneratedRegex(@"^\d{1,3}\.\d{1,3}$")]
    private static partial Regex ChannelNumberRegex();

    [GeneratedRegex(@"^seg\d{5}\.ts$")]
    private static partial Regex SegmentNameRegex();
}
