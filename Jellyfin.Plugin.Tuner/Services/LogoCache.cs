using System.Collections.Concurrent;

namespace Jellyfin.Plugin.Tuner.Services;

/// <summary>
/// Station and channel pictures, fetched once and kept in memory. Radio tiles live on
/// whatever plain-http server the station list points at, free-TV logos in Dispatcharr and antenna logos at
/// SiliconDust: none of them can be loaded by an https page or a phone away from home, so
/// the plugin relays them, and a few hundred small images is a few MB.
///
/// Keyed by the image's address, not the channel number: a rebuild that renumbers
/// channels then can't show the old channel's picture on the new one. Each service has
/// its own cache, so one clearing it (a new radio list) doesn't drop the others'.
/// </summary>
public sealed class LogoCache
{
    private readonly IHttpClientFactory _http;
    private readonly ConcurrentDictionary<string, (byte[] Bytes, string Type)> _cache = new();

    public LogoCache(IHttpClientFactory http)
    {
        _http = http;
    }

    /// <summary>The picture at <paramref name="url"/>, or null if there's none or it couldn't be fetched.</summary>
    public async Task<(byte[] Bytes, string Type)?> GetAsync(string? url, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(url))
        {
            return null;
        }

        if (_cache.TryGetValue(url, out var hit))
        {
            return hit;
        }

        try
        {
            using var resp = await _http.CreateClient(PluginServiceRegistrator.ApiClient).GetAsync(url, ct).ConfigureAwait(false);
            if (!resp.IsSuccessStatusCode)
            {
                return null;
            }

            var entry = (await resp.Content.ReadAsByteArrayAsync(ct).ConfigureAwait(false), resp.Content.Headers.ContentType?.MediaType ?? "image/png");
            _cache[url] = entry;
            return entry;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            return null;
        }
    }

    public void Clear() => _cache.Clear();
}
