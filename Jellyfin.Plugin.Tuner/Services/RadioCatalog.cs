using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Tuner.Services;

public sealed record RadioStation(int Number, string Genre, string Name, string Url, string? LogoUrl);

public sealed record RadioGenre(string Name, string Color, IReadOnlyList<RadioStation> Stations);

/// <summary>
/// Reads the station M3U (RadioM3uUrl) and groups it by genre.
///
/// WHY read the M3U directly instead of asking Jellyfin's Live TV for the channels:
/// the point of this page is to take radio OUT of Live TV, and the M3U already carries
/// everything needed (stable numbers, genre, color, tile). It is also a single small
/// LAN fetch, versus Live TV channel queries that hit Jellyfin's database.
/// </summary>
public partial class RadioCatalog
{
    private static readonly TimeSpan Ttl = TimeSpan.FromMinutes(10);
    private readonly IHttpClientFactory _http;
    private readonly ILogger<RadioCatalog> _logger;
    private readonly SemaphoreSlim _lock = new(1, 1);
    private readonly LogoCache _logos;
    private IReadOnlyList<RadioGenre> _genres = Array.Empty<RadioGenre>();
    private Dictionary<int, RadioStation> _byNumber = new();
    private DateTime _loadedAt = DateTime.MinValue;
    private string _loadedFrom = string.Empty;

    public RadioCatalog(IHttpClientFactory http, ILogger<RadioCatalog> logger)
    {
        _http = http;
        _logger = logger;
        _logos = new LogoCache(http);
    }

    public async Task<IReadOnlyList<RadioGenre>> GetGenresAsync(CancellationToken ct)
    {
        await EnsureLoadedAsync(ct).ConfigureAwait(false);
        return _genres;
    }

    public async Task<RadioStation?> FindAsync(int number, CancellationToken ct)
    {
        await EnsureLoadedAsync(ct).ConfigureAwait(false);
        return _byNumber.GetValueOrDefault(number);
    }

    /// <summary>A station's tile (269 of them, ~20 KB each; see <see cref="LogoCache"/>).</summary>
    public async Task<(byte[] Bytes, string Type)?> GetLogoAsync(int number, CancellationToken ct)
        => await _logos.GetAsync((await FindAsync(number, ct).ConfigureAwait(false))?.LogoUrl, ct).ConfigureAwait(false);

    private async Task EnsureLoadedAsync(CancellationToken ct)
    {
        var url = Plugin.Instance?.Configuration.RadioM3uUrl ?? string.Empty;
        if (DateTime.UtcNow - _loadedAt < Ttl && url == _loadedFrom)
        {
            return;
        }

        // No station list set: live radio is simply empty (Jamendo can still work).
        if (string.IsNullOrWhiteSpace(url))
        {
            _genres = Array.Empty<RadioGenre>();
            _byNumber = new();
            _loadedAt = DateTime.UtcNow;
            _loadedFrom = url;
            return;
        }

        await _lock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (DateTime.UtcNow - _loadedAt < Ttl && url == _loadedFrom)
            {
                return;
            }

            var text = await _http.CreateClient(PluginServiceRegistrator.ApiClient).GetStringAsync(url, ct).ConfigureAwait(false);
            var stations = Parse(text, out var colors);
            _genres = stations
                .GroupBy(s => s.Genre)
                .OrderBy(g => g.Min(s => s.Number))
                .Select(g => new RadioGenre(g.Key, colors.GetValueOrDefault(g.Key, "#455A64"), g.OrderBy(s => s.Number).ToList()))
                .ToList();
            _byNumber = stations.ToDictionary(s => s.Number);
            // A rebuild can redraw a tile at the same address, so old tiles must not linger.
            _logos.Clear();
            _loadedAt = DateTime.UtcNow;
            _loadedFrom = url;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            // Keep serving the last good list; a blip on the list's server shouldn't blank the page.
            _logger.LogWarning(ex, "Tuner: could not refresh the radio list from {Url}", url);
            if (_byNumber.Count == 0)
            {
                throw;
            }
        }
        finally
        {
            _lock.Release();
        }
    }

    private static List<RadioStation> Parse(string m3u, out Dictionary<string, string> colors)
    {
        colors = new Dictionary<string, string>();
        var list = new List<RadioStation>();
        string? extinf = null;
        foreach (var raw in m3u.Split('\n'))
        {
            var line = raw.Trim();
            if (line.StartsWith("#EXTINF", StringComparison.Ordinal))
            {
                extinf = line;
                continue;
            }

            if (extinf is null || line.Length == 0 || line.StartsWith('#'))
            {
                continue;
            }

            var attrs = AttrRegex().Matches(extinf).ToDictionary(m => m.Groups[1].Value, m => m.Groups[2].Value);
            var title = extinf[(extinf.LastIndexOf(',') + 1)..].Trim();
            // Names are "Genre · Station"; fall back to group-title if a line ever lacks it.
            var sep = title.IndexOf(" · ", StringComparison.Ordinal);
            var genre = sep > 0 ? title[..sep] : (attrs.GetValueOrDefault("group-title") ?? "Radio").Replace("Radio · ", string.Empty, StringComparison.Ordinal);
            var name = sep > 0 ? title[(sep + 3)..] : title;
            if (int.TryParse(attrs.GetValueOrDefault("tvg-chno"), out var number))
            {
                list.Add(new RadioStation(number, genre, name, line, attrs.GetValueOrDefault("tvg-logo")));
                if (attrs.TryGetValue("x-genre-color", out var color) && ColorRegex().IsMatch(color))
                {
                    colors[genre] = color;
                }
            }

            extinf = null;
        }

        return list;
    }

    [GeneratedRegex("([a-z-]+)=\"([^\"]*)\"")]
    private static partial Regex AttrRegex();

    [GeneratedRegex("^#[0-9A-Fa-f]{6}$")]
    private static partial Regex ColorRegex();
}
