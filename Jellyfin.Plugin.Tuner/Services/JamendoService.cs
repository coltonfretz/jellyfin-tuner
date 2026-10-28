using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.RegularExpressions;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Tuner.Services;

public sealed record JamendoTrack(
    string Id, string Name, string Artist, string Album, string Image,
    int Duration, string Audio, bool Downloadable, string License, string ShareUrl);

public sealed record JamendoStation(string Name, string Color);

/// <summary>
/// Jamendo "stations": a shuffled run of Creative Commons tracks per genre.
///
/// WHY not Jamendo's own radio channels: as of Oct 2026 every streaming.jamendo.com
/// channel 301s to one unrelated third-party stream, so they are dead. The track
/// catalog works, and picking tracks ourselves means exact now-playing info and a
/// working skip button, which real radio can't offer.
///
/// The API sometimes returns zero results for a tag that worked a minute earlier, so
/// each genre keeps a pooled list for hours and a failed refresh keeps the old pool.
/// </summary>
public partial class JamendoService
{
    private const string Api = "https://api.jamendo.com/v3.0";
    private static readonly TimeSpan PoolTtl = TimeSpan.FromHours(12);

    // Same names and colors as the radio genres so the dial reads as one system.
    // Tags are what Jamendo uses; Focus is what a track's own genre list must contain,
    // the same idea as the radio builder's FOCUS filter (Jamendo tags are loose: a
    // "metalcore" search returned a track tagged techno+metalcore).
    private static readonly (string Name, string Color, string[] Tags, string[] Focus)[] Stations =
    {
        ("Metalcore", "#8B1E2D", new[] { "metalcore", "deathcore" }, new[] { "core", "metal" }),
        ("Metal", "#2F2F2F", new[] { "metal" }, new[] { "metal" }),
        ("Hard Rock", "#9C4A1A", new[] { "hardrock" }, new[] { "rock", "metal" }),
        ("Rock", "#1F4E79", new[] { "rock" }, new[] { "rock" }),
        ("Alternative", "#00695C", new[] { "alternative", "indie" }, new[] { "alternative", "indie", "grunge" }),
        ("Punk & Emo", "#AD1457", new[] { "punk", "emo" }, new[] { "punk", "emo" }),
        ("Hip-Hop", "#8D6E00", new[] { "hiphop", "rap" }, new[] { "hip", "rap", "trap" }),
        ("Electronic", "#0277BD", new[] { "electronic", "house", "techno" }, new[] { "electro", "house", "techno", "trance", "dance", "edm", "dubstep", "drumnbass" }),
        ("Chill & Lo-Fi", "#4E6A78", new[] { "lounge", "chillout", "lofi" }, new[] { "lounge", "chill", "lofi", "ambient", "downtempo", "relax" }),
        ("Pop & Hits", "#E64A19", new[] { "pop" }, new[] { "pop" }),
        ("Country & Blues", "#556B2F", new[] { "country", "blues" }, new[] { "country", "blues", "folk", "americana" }),
        ("Jazz & Soul", "#283593", new[] { "jazz", "soul", "funk" }, new[] { "jazz", "soul", "funk", "rnb" }),
        ("Classical & Soundtrack", "#006064", new[] { "classical", "soundtrack" }, new[] { "classical", "soundtrack", "orchestral", "piano", "cinematic" }),
        ("Reggae & Latin", "#2E7D32", new[] { "reggae", "latin" }, new[] { "reggae", "latin", "ska", "dub" }),
    };

    private static readonly string[] NotGuitar = { "techno", "house", "trance", "edm", "electronic", "dance", "dubstep" };
    private static readonly HashSet<string> GuitarStations = new() { "Metalcore", "Metal", "Hard Rock", "Punk & Emo" };

    private readonly IHttpClientFactory _http;
    private readonly ILibraryMonitor _libraryMonitor;
    private readonly ILogger<JamendoService> _logger;
    private readonly ConcurrentDictionary<string, (DateTime At, List<JamendoTrack> Tracks)> _pools = new();
    private readonly ConcurrentDictionary<string, SemaphoreSlim> _poolLocks = new();

    public JamendoService(IHttpClientFactory http, ILibraryMonitor libraryMonitor, ILogger<JamendoService> logger)
    {
        _http = http;
        _libraryMonitor = libraryMonitor;
        _logger = logger;
    }

    private static string ClientId => Plugin.Instance?.Configuration.JamendoClientId?.Trim() ?? string.Empty;

    public bool Enabled => ClientId.Length > 0;

    public IReadOnlyList<JamendoStation> GetStations()
        => Enabled ? Stations.Select(s => new JamendoStation(s.Name, s.Color)).ToList() : Array.Empty<JamendoStation>();

    /// <summary>A random batch from the genre's pool; the client asks again when it runs low.</summary>
    public async Task<IReadOnlyList<JamendoTrack>> GetBatchAsync(string station, int count, CancellationToken ct)
    {
        var def = Stations.FirstOrDefault(s => s.Name == station);
        if (def.Name is null || !Enabled)
        {
            return Array.Empty<JamendoTrack>();
        }

        var pool = await GetPoolAsync(def, ct).ConfigureAwait(false);
        // At most two tracks per artist per batch: popular artists have dozens of tracks
        // in a pool, and a plain shuffle let one artist take half the queue.
        var perArtist = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        var batch = new List<JamendoTrack>();
        foreach (var t in pool.OrderBy(_ => Random.Shared.Next()))
        {
            var n = perArtist.GetValueOrDefault(t.Artist);
            if (n >= 2)
            {
                continue;
            }

            perArtist[t.Artist] = n + 1;
            batch.Add(t);
            if (batch.Count >= Math.Clamp(count, 1, 50))
            {
                break;
            }
        }

        return batch;
    }

    private async Task<List<JamendoTrack>> GetPoolAsync((string Name, string Color, string[] Tags, string[] Focus) def, CancellationToken ct)
    {
        if (_pools.TryGetValue(def.Name, out var p) && DateTime.UtcNow - p.At < PoolTtl && p.Tracks.Count > 0)
        {
            return p.Tracks;
        }

        var gate = _poolLocks.GetOrAdd(def.Name, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (_pools.TryGetValue(def.Name, out p) && DateTime.UtcNow - p.At < PoolTtl && p.Tracks.Count > 0)
            {
                return p.Tracks;
            }

            var found = new Dictionary<string, JamendoTrack>();
            foreach (var tag in def.Tags)
            {
                // Two orderings: all-time popular is the reliable core, this month's
                // popular keeps the station from being the same 200 songs forever.
                foreach (var order in new[] { "popularity_total", "popularity_month" })
                {
                    foreach (var t in await QueryAsync(tag, order, def, ct).ConfigureAwait(false))
                    {
                        found.TryAdd(t.Id, t);
                    }
                }
            }

            if (found.Count == 0 && p.Tracks is { Count: > 0 })
            {
                _logger.LogWarning("Tuner: Jamendo returned nothing for {Station}, keeping the previous pool", def.Name);
                return p.Tracks;
            }

            var list = found.Values.ToList();
            _pools[def.Name] = (DateTime.UtcNow, list);
            return list;
        }
        finally
        {
            gate.Release();
        }
    }

    private async Task<List<JamendoTrack>> QueryAsync(string tag, string order, (string Name, string Color, string[] Tags, string[] Focus) def, CancellationToken ct)
    {
        var url = $"{Api}/tracks/?client_id={Uri.EscapeDataString(ClientId)}&format=json&limit=200"
            + $"&tags={Uri.EscapeDataString(tag)}&order={order}&include=musicinfo+licenses&audioformat=mp32";
        // Retry because the API intermittently answers a valid query with zero results.
        for (var attempt = 0; attempt < 3; attempt++)
        {
            try
            {
                using var doc = JsonDocument.Parse(await _http.CreateClient(PluginServiceRegistrator.ApiClient).GetStringAsync(url, ct).ConfigureAwait(false));
                var results = doc.RootElement.GetProperty("results");
                if (results.GetArrayLength() == 0)
                {
                    await Task.Delay(1500, ct).ConfigureAwait(false);
                    continue;
                }

                var keep = new List<JamendoTrack>();
                foreach (var r in results.EnumerateArray())
                {
                    var genres = r.TryGetProperty("musicinfo", out var mi) && mi.TryGetProperty("tags", out var tags)
                        && tags.TryGetProperty("genres", out var g) && g.ValueKind == JsonValueKind.Array
                        ? g.EnumerateArray().Select(x => x.GetString() ?? string.Empty).ToList()
                        : new List<string>();
                    if (!genres.Any(x => def.Focus.Any(f => x.Contains(f, StringComparison.OrdinalIgnoreCase))))
                    {
                        continue;
                    }

                    if (GuitarStations.Contains(def.Name) && genres.Any(x => NotGuitar.Any(n => x.Contains(n, StringComparison.OrdinalIgnoreCase))))
                    {
                        continue;
                    }

                    keep.Add(new JamendoTrack(
                        Str(r, "id"), Str(r, "name"), Str(r, "artist_name"), Str(r, "album_name"),
                        Str(r, "album_image") is { Length: > 0 } img ? img : Str(r, "image"),
                        r.TryGetProperty("duration", out var d) && d.TryGetInt32(out var dur) ? dur : 0,
                        Str(r, "audio"),
                        r.TryGetProperty("audiodownload_allowed", out var dl) && dl.ValueKind == JsonValueKind.True,
                        Str(r, "license_ccurl"),
                        Str(r, "shareurl")));
                }

                return keep;
            }
            catch (Exception ex) when (ex is HttpRequestException or JsonException or KeyNotFoundException)
            {
                _logger.LogDebug(ex, "Tuner: Jamendo query failed for {Tag}", tag);
                await Task.Delay(1500, ct).ConfigureAwait(false);
            }
        }

        return new List<JamendoTrack>();
    }

    /// <summary>
    /// Save a track into the library. Only when the artist allows downloads: Jamendo's
    /// audiodownload_allowed flag is the artist's own choice, and honoring it is what
    /// keeps "Keep" on the right side of their Creative Commons terms.
    /// </summary>
    public async Task<(bool Ok, string Message)> KeepAsync(string trackId, CancellationToken ct)
    {
        if (!Enabled || !DigitsRegex().IsMatch(trackId))
        {
            return (false, "Unknown track");
        }

        var folder = Plugin.Instance?.Configuration.JamendoKeepFolder;
        if (string.IsNullOrWhiteSpace(folder))
        {
            return (false, "No keep folder configured");
        }

        var url = $"{Api}/tracks/?client_id={Uri.EscapeDataString(ClientId)}&format=json&id={trackId}&audiodlformat=mp32";
        using var doc = JsonDocument.Parse(await _http.CreateClient(PluginServiceRegistrator.ApiClient).GetStringAsync(url, ct).ConfigureAwait(false));
        var r = doc.RootElement.GetProperty("results").EnumerateArray().FirstOrDefault();
        if (r.ValueKind != JsonValueKind.Object)
        {
            return (false, "Track not found");
        }

        if (!(r.TryGetProperty("audiodownload_allowed", out var dl) && dl.ValueKind == JsonValueKind.True))
        {
            return (false, "This artist doesn't allow downloads");
        }

        var download = Str(r, "audiodownload");
        if (!download.StartsWith("https://", StringComparison.Ordinal))
        {
            return (false, "No download link");
        }

        // Artist/Album/Title layout so Jellyfin's music scanner groups it like the rest
        // of the library. Names come from the API, so they're sanitized and the final
        // path is checked to stay inside the keep folder.
        var root = Path.GetFullPath(folder);
        var album = Safe(Str(r, "album_name"));
        var dir = Path.Combine(root, Safe(Str(r, "artist_name")), album.Length > 0 ? album : "Singles");
        var file = Path.GetFullPath(Path.Combine(dir, Safe(Str(r, "name")) + ".mp3"));
        if (!file.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.Ordinal))
        {
            return (false, "Bad path");
        }

        if (File.Exists(file))
        {
            return (true, "Already in your library");
        }

        Directory.CreateDirectory(dir);
        // Write to .part first and rename, so the library scanner never picks up a
        // half-downloaded file; a failed download takes its .part with it.
        var part = file + ".part";
        try
        {
            using var resp = await _http.CreateClient(PluginServiceRegistrator.StreamClient).GetAsync(download, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
            resp.EnsureSuccessStatusCode();
            await using (var src = await resp.Content.ReadAsStreamAsync(ct).ConfigureAwait(false))
            await using (var dst = File.Create(part))
            {
                await src.CopyToAsync(dst, ct).ConfigureAwait(false);
            }

            File.Move(part, file);
        }
        catch
        {
            File.Delete(part);
            throw;
        }

        _libraryMonitor.ReportFileSystemChanged(file);
        return (true, "Saved to your library");
    }

    private static string Str(JsonElement e, string name)
        => e.TryGetProperty(name, out var v) ? (v.ValueKind == JsonValueKind.String ? v.GetString() ?? string.Empty : v.ToString()) : string.Empty;

    private static string Safe(string s)
    {
        var cleaned = UnsafeRegex().Replace(s, "-").Trim().Trim('.');
        return cleaned.Length > 120 ? cleaned[..120] : cleaned;
    }

    [GeneratedRegex("^[0-9]{1,12}$")]
    private static partial Regex DigitsRegex();

    [GeneratedRegex("[\\\\/:*?\"<>|\\x00-\\x1F]")]
    private static partial Regex UnsafeRegex();
}
