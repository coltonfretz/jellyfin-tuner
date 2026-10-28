using System.Collections.Concurrent;
using System.Text;
using System.Text.RegularExpressions;

namespace Jellyfin.Plugin.Tuner.Services;

/// <summary>
/// Reads the "now playing" title that Icecast/Shoutcast servers interleave into the
/// audio stream.
///
/// WHY server-side: the title only arrives if the request sends Icy-MetaData: 1, and
/// then it is mixed into the byte stream every icy-metaint bytes. Browsers can't add
/// that header to an &lt;audio&gt; request, and the stations don't allow cross-origin
/// fetch, so the page asks us and we open a short-lived side connection.
/// </summary>
public partial class IcyMetadata
{
    private static readonly TimeSpan CacheFor = TimeSpan.FromSeconds(20);
    private const int MaxMetaInt = 256 * 1024;
    private readonly IHttpClientFactory _http;
    private readonly ConcurrentDictionary<string, (DateTime At, string? Title)> _cache = new();

    public IcyMetadata(IHttpClientFactory http)
    {
        _http = http;
    }

    public async Task<string?> GetTitleAsync(string streamUrl, CancellationToken ct)
    {
        // Several listeners on one station shouldn't each open a connection to it.
        if (_cache.TryGetValue(streamUrl, out var hit) && DateTime.UtcNow - hit.At < CacheFor)
        {
            return hit.Title;
        }

        string? title = null;
        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(TimeSpan.FromSeconds(8));
            using var req = new HttpRequestMessage(HttpMethod.Get, streamUrl);
            req.Headers.Add("Icy-MetaData", "1");
            using var resp = await _http.CreateClient(PluginServiceRegistrator.StreamClient)
                .SendAsync(req, HttpCompletionOption.ResponseHeadersRead, cts.Token).ConfigureAwait(false);
            if (resp.IsSuccessStatusCode
                && resp.Headers.TryGetValues("icy-metaint", out var values)
                && int.TryParse(values.FirstOrDefault(), out var metaInt)
                && metaInt > 0 && metaInt <= MaxMetaInt)
            {
                await using var s = await resp.Content.ReadAsStreamAsync(cts.Token).ConfigureAwait(false);
                await SkipAsync(s, metaInt, cts.Token).ConfigureAwait(false);
                var lenByte = new byte[1];
                await s.ReadExactlyAsync(lenByte, cts.Token).ConfigureAwait(false);
                var meta = new byte[lenByte[0] * 16];
                if (meta.Length > 0)
                {
                    await s.ReadExactlyAsync(meta, cts.Token).ConfigureAwait(false);
                    title = ParseTitle(Decode(meta));
                }
            }
        }
        catch (Exception ex) when (ex is HttpRequestException or OperationCanceledException or EndOfStreamException or IOException)
        {
            // No title is a normal outcome (HLS/AAC streams, servers without metadata).
        }

        _cache[streamUrl] = (DateTime.UtcNow, title);
        return title;
    }

    private static async Task SkipAsync(Stream s, int count, CancellationToken ct)
    {
        var buf = new byte[16 * 1024];
        while (count > 0)
        {
            var n = await s.ReadAsync(buf.AsMemory(0, Math.Min(buf.Length, count)), ct).ConfigureAwait(false);
            if (n == 0)
            {
                throw new EndOfStreamException();
            }

            count -= n;
        }
    }

    // Stations send UTF-8 or Latin-1 with no way to tell which; UTF-8 that doesn't
    // round-trip cleanly is treated as Latin-1 so "Motörhead" doesn't become garbage.
    private static string Decode(byte[] meta)
    {
        var utf8 = new UTF8Encoding(false, true);
        try
        {
            return utf8.GetString(meta);
        }
        catch (DecoderFallbackException)
        {
            return Encoding.Latin1.GetString(meta);
        }
    }

    private static string? ParseTitle(string meta)
    {
        var m = TitleRegex().Match(meta);
        if (!m.Success)
        {
            return null;
        }

        var t = m.Groups[1].Value.Trim().Trim('-').Trim();
        // Some stations put ads or their own name in the title slot; those are still
        // more useful than nothing, but a bare dash or empty string is not.
        return t.Length > 1 ? t : null;
    }

    [GeneratedRegex("StreamTitle='(.*?)';", RegexOptions.Singleline)]
    private static partial Regex TitleRegex();
}
