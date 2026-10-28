using System.Globalization;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Xml;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Tuner.Services;

public sealed record TvChannel(int Number, string Name, string Group, int? LogoId, string StreamUrl);

public sealed record TvProgram(string Title, DateTimeOffset Start, DateTimeOffset End);

/// <summary>
/// Lineup and guide for TV surf mode, read from Dispatcharr.
///
/// WHY bypass Jellyfin's Live TV for playback: opening a channel through Jellyfin
/// (PlaybackInfo + remux) took 46 s on 2026-10-13, which makes surfing pointless. The
/// free channels are already HLS that browsers can play, 192 of 209 straight from the
/// source, so the page plays the upstream URL Dispatcharr curated and only falls back to
/// <see cref="HlsRelay"/> for sources that refuse cross-origin requests.
///
/// WHY Dispatcharr's guide instead of Jellyfin's: Jellyfin refreshes its copy every 6 h
/// (more often hit SQLite lock contention), while Dispatcharr refreshes short-horizon
/// sources every 3 h. Reading its XMLTV here keeps the info bar current.
/// </summary>
public class TvService
{
    private static readonly TimeSpan LineupTtl = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan GuideTtl = TimeSpan.FromMinutes(10);
    private readonly IHttpClientFactory _http;
    private readonly ILogger<TvService> _logger;
    private readonly SemaphoreSlim _lineupLock = new(1, 1);
    private readonly SemaphoreSlim _guideLock = new(1, 1);
    private readonly LogoCache _logos;
    private IReadOnlyList<TvChannel> _lineup = Array.Empty<TvChannel>();
    private DateTime _lineupAt = DateTime.MinValue;
    private Dictionary<string, List<TvProgram>> _guide = new();
    private DateTime _guideAt = DateTime.MinValue;

    public TvService(IHttpClientFactory http, ILogger<TvService> logger)
    {
        _http = http;
        _logger = logger;
        _logos = new LogoCache(http);
    }

    private static string BaseUrl => (Plugin.Instance?.Configuration.DispatcharrUrl ?? string.Empty).TrimEnd('/');

    private static string ApiKey => Plugin.Instance?.Configuration.DispatcharrApiKey ?? string.Empty;

    public bool Enabled => BaseUrl.Length > 0 && ApiKey.Length > 0;

    public async Task<IReadOnlyList<TvChannel>> GetLineupAsync(CancellationToken ct)
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

            var groups = new Dictionary<int, string>();
            foreach (var g in await GetListAsync("/api/channels/groups/", ct).ConfigureAwait(false))
            {
                groups[g.GetProperty("id").GetInt32()] = g.GetProperty("name").GetString() ?? string.Empty;
            }

            var streams = new Dictionary<int, string>();
            foreach (var s in await GetListAsync("/api/channels/streams/?page_size=2000", ct).ConfigureAwait(false))
            {
                // WHY skip stale: the weekly FAST rebuild drops channels that are dead or
                // stuck below 360p, and Dispatcharr marks them stale on its next refresh.
                // It keeps them 30 days so one that recovers relinks to its old number;
                // until then it shouldn't sit in the lineup showing a black screen.
                if (s.TryGetProperty("is_stale", out var stale) && stale.ValueKind == JsonValueKind.True)
                {
                    continue;
                }

                streams[s.GetProperty("id").GetInt32()] = s.GetProperty("url").GetString() ?? string.Empty;
            }

            var lineup = new List<TvChannel>();
            foreach (var c in await GetListAsync("/api/channels/channels/?page_size=2000", ct).ConfigureAwait(false))
            {
                // "Hidden from output" in Dispatcharr is how channels are retired without
                // deleting them (duplicates of antenna channels, dead networks whose stream
                // now carries something else); keep Surf TV in line with that.
                if (c.GetProperty("channel_number").ValueKind != JsonValueKind.Number
                    || (c.TryGetProperty("hidden_from_output", out var hid) && hid.ValueKind == JsonValueKind.True))
                {
                    continue;
                }

                // A channel can hold several streams for failover; the first is primary.
                var streamIds = c.GetProperty("streams").EnumerateArray()
                    .Select(x => x.ValueKind == JsonValueKind.Number ? x.GetInt32() : x.GetProperty("id").GetInt32());
                var url = streamIds.Select(id => streams.GetValueOrDefault(id)).FirstOrDefault(u => !string.IsNullOrEmpty(u));
                if (url is null || !url.StartsWith("http", StringComparison.Ordinal))
                {
                    continue;
                }

                var groupId = c.TryGetProperty("channel_group_id", out var gid) && gid.ValueKind == JsonValueKind.Number ? gid.GetInt32() : -1;
                int? logoId = c.TryGetProperty("logo_id", out var lid) && lid.ValueKind == JsonValueKind.Number ? lid.GetInt32() : null;
                lineup.Add(new TvChannel(
                    (int)c.GetProperty("channel_number").GetDouble(),
                    c.GetProperty("name").GetString() ?? string.Empty,
                    groups.GetValueOrDefault(groupId, "Other"),
                    logoId,
                    url));
            }

            _lineup = lineup.OrderBy(c => c.Number).ToList();
            _lineupAt = DateTime.UtcNow;
            return _lineup;
        }
        catch (Exception ex) when (ex is HttpRequestException or JsonException or TaskCanceledException or KeyNotFoundException or InvalidOperationException)
        {
            _logger.LogWarning(ex, "Tuner: could not read the Dispatcharr lineup");
            if (_lineup.Count == 0)
            {
                throw;
            }

            return _lineup;
        }
        finally
        {
            _lineupLock.Release();
        }
    }

    /// <summary>Now and next per channel number, from Dispatcharr's XMLTV output.</summary>
    public async Task<Dictionary<int, (TvProgram? Now, TvProgram? Next)>> GetNowNextAsync(CancellationToken ct)
    {
        await EnsureGuideAsync(ct).ConfigureAwait(false);
        var now = DateTimeOffset.UtcNow;
        var result = new Dictionary<int, (TvProgram?, TvProgram?)>();
        foreach (var (id, list) in _guide)
        {
            if (!int.TryParse(id, NumberStyles.Integer, CultureInfo.InvariantCulture, out var number))
            {
                continue;
            }

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

            // ~3 MB of XML. Stream it rather than building a DOM, and keep only the
            // next 12 hours, which is all an info bar ever shows.
            var horizon = DateTimeOffset.UtcNow.AddHours(12);
            var past = DateTimeOffset.UtcNow.AddHours(-1);
            var guide = new Dictionary<string, List<TvProgram>>();
            using var resp = await _http.CreateClient(PluginServiceRegistrator.ApiClient)
                .GetAsync(BaseUrl + "/output/epg", HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
            resp.EnsureSuccessStatusCode();
            await using var stream = await resp.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
            using var reader = XmlReader.Create(stream, new XmlReaderSettings { Async = true, DtdProcessing = DtdProcessing.Ignore });
            while (await reader.ReadAsync().ConfigureAwait(false))
            {
                if (reader.NodeType != XmlNodeType.Element || reader.Name != "programme")
                {
                    continue;
                }

                var channel = reader.GetAttribute("channel");
                var start = ParseXmltvTime(reader.GetAttribute("start"));
                var stop = ParseXmltvTime(reader.GetAttribute("stop"));
                string? title = null;
                using (var sub = reader.ReadSubtree())
                {
                    while (await sub.ReadAsync().ConfigureAwait(false))
                    {
                        if (sub.NodeType == XmlNodeType.Element && sub.Name == "title")
                        {
                            title = await sub.ReadElementContentAsStringAsync().ConfigureAwait(false);
                            break;
                        }
                    }
                }

                if (channel is null || start is null || stop is null || title is null || stop < past || start > horizon)
                {
                    continue;
                }

                if (!guide.TryGetValue(channel, out var list))
                {
                    guide[channel] = list = new List<TvProgram>();
                }

                list.Add(new TvProgram(title, start.Value, stop.Value));
            }

            foreach (var list in guide.Values)
            {
                list.Sort((a, b) => a.Start.CompareTo(b.Start));
            }

            _guide = guide;
            _guideAt = DateTime.UtcNow;
        }
        catch (Exception ex) when (ex is HttpRequestException or XmlException or TaskCanceledException)
        {
            // An old guide beats no guide; try again on the next request after a minute.
            _logger.LogWarning(ex, "Tuner: could not read the Dispatcharr guide");
            _guideAt = DateTime.UtcNow - GuideTtl + TimeSpan.FromMinutes(1);
        }
        finally
        {
            _guideLock.Release();
        }
    }

    // XMLTV times look like "20261013220000 +0000".
    private static DateTimeOffset? ParseXmltvTime(string? s)
        => s is not null && DateTimeOffset.TryParseExact(s, "yyyyMMddHHmmss zzz", CultureInfo.InvariantCulture, DateTimeStyles.None, out var t) ? t : null;

    public async Task<(byte[] Bytes, string Type)?> GetLogoAsync(int number, CancellationToken ct)
    {
        var ch = (await GetLineupAsync(ct).ConfigureAwait(false)).FirstOrDefault(c => c.Number == number);
        return await _logos.GetAsync(ch?.LogoId is null ? null : $"{BaseUrl}/api/channels/logos/{ch.LogoId}/cache/", ct).ConfigureAwait(false);
    }

    private async Task<List<JsonElement>> GetListAsync(string path, CancellationToken ct)
    {
        using var req = new HttpRequestMessage(HttpMethod.Get, BaseUrl + path);
        req.Headers.Add("X-API-Key", ApiKey);
        req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        using var resp = await _http.CreateClient(PluginServiceRegistrator.ApiClient).SendAsync(req, ct).ConfigureAwait(false);
        resp.EnsureSuccessStatusCode();
        using var doc = JsonDocument.Parse(await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false));
        // Dispatcharr returns either a bare array or a paginated {results: [...]}.
        var root = doc.RootElement;
        var arr = root.ValueKind == JsonValueKind.Object && root.TryGetProperty("results", out var r) ? r : root;
        return arr.EnumerateArray().Select(e => e.Clone()).ToList();
    }
}
