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
    // Station logos are a few KB to a few hundred; anything far bigger isn't a logo.
    private const int MaxLogoBytes = 2 * 1024 * 1024;

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
            using var resp = await _http.CreateClient(PluginServiceRegistrator.ApiClient)
                .GetAsync(url, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
            // Only pictures: anything else (a web page, say) is no logo, never relayed.
            // Storage servers often label files "octet-stream"; those are let through to be
            // recognized by their first bytes below.
            var declared = resp.Content.Headers.ContentType?.MediaType;
            var type = NetGuard.ImageType(declared);
            var unlabeled = type is null && (string.IsNullOrEmpty(declared) || declared.EndsWith("octet-stream", StringComparison.OrdinalIgnoreCase));
            if (!resp.IsSuccessStatusCode || (type is null && !unlabeled) || resp.Content.Headers.ContentLength > MaxLogoBytes)
            {
                return null;
            }

            await using var src = await resp.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
            using var buffer = new MemoryStream();
            var chunk = new byte[16 * 1024];
            int n;
            while ((n = await src.ReadAsync(chunk, ct).ConfigureAwait(false)) > 0)
            {
                if (buffer.Length + n > MaxLogoBytes)
                {
                    return null;
                }

                buffer.Write(chunk, 0, n);
            }

            var bytes = buffer.ToArray();
            type ??= NetGuard.SniffImage(bytes);
            if (type is null)
            {
                return null;
            }

            var entry = (bytes, type);
            _cache[url] = entry;
            return entry;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or IOException)
        {
            return null;
        }
    }

    public void Clear() => _cache.Clear();
}
