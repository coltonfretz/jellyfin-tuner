using System.Text;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Http;

namespace Jellyfin.Plugin.Tuner.Services;

/// <summary>
/// Relays HLS for the free channels whose CDN refuses cross-origin requests (17 of
/// 209 on 2026-10-13, all on amagi.tv), so the browser can't fetch them directly.
///
/// Playlists are rewritten so every URI inside them (variants, segments, keys, init
/// maps, alternate audio) points back through this relay, each with its own signature.
/// Segments are streamed through untouched. Only signed URLs are fetched; see
/// <see cref="StreamTickets.SignUrl"/>.
/// </summary>
public partial class HlsRelay
{
    private readonly IHttpClientFactory _http;
    private readonly StreamTickets _tickets;

    public HlsRelay(IHttpClientFactory http, StreamTickets tickets)
    {
        _http = http;
        _tickets = tickets;
    }

    /// <summary>Relative URL (resolved by hls.js against the playlist URL) for a signed upstream URL.</summary>
    public string RelayPath(string upstream)
        => "hls?u=" + Uri.EscapeDataString(Base64Url(upstream)) + "&s=" + _tickets.SignUrl(upstream);

    public async Task RelayAsync(HttpContext ctx, string encodedUrl, string? sig, string ticket, CancellationToken ct)
    {
        string upstream;
        try
        {
            upstream = FromBase64Url(encodedUrl);
        }
        catch (FormatException)
        {
            ctx.Response.StatusCode = StatusCodes.Status400BadRequest;
            return;
        }

        if (!_tickets.IsSignedUrl(upstream, sig) || !Uri.TryCreate(upstream, UriKind.Absolute, out var uri)
            || (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp))
        {
            ctx.Response.StatusCode = StatusCodes.Status403Forbidden;
            return;
        }

        using var req = new HttpRequestMessage(HttpMethod.Get, uri);
        req.Headers.UserAgent.ParseAdd("Mozilla/5.0");
        using var resp = await _http.CreateClient(PluginServiceRegistrator.StreamClient)
            .SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
        if (!resp.IsSuccessStatusCode)
        {
            ctx.Response.StatusCode = (int)resp.StatusCode;
            return;
        }

        var type = resp.Content.Headers.ContentType?.MediaType ?? string.Empty;
        var finalUrl = resp.RequestMessage?.RequestUri ?? uri;
        var looksLikePlaylist = type.Contains("mpegurl", StringComparison.OrdinalIgnoreCase)
            || finalUrl.AbsolutePath.EndsWith(".m3u8", StringComparison.OrdinalIgnoreCase);

        ctx.Response.Headers.CacheControl = "no-store";
        if (!looksLikePlaylist)
        {
            ctx.Response.ContentType = string.IsNullOrEmpty(type) ? "video/mp2t" : type;
            if (resp.Content.Headers.ContentLength is long len)
            {
                ctx.Response.ContentLength = len;
            }

            await using var src = await resp.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
            await src.CopyToAsync(ctx.Response.Body, 64 * 1024, ct).ConfigureAwait(false);
            return;
        }

        var text = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        var rewritten = Rewrite(text, finalUrl, ticket);
        ctx.Response.ContentType = "application/vnd.apple.mpegurl";
        var bytes = Encoding.UTF8.GetBytes(rewritten);
        ctx.Response.ContentLength = bytes.Length;
        await ctx.Response.Body.WriteAsync(bytes, ct).ConfigureAwait(false);
    }

    private string Rewrite(string playlist, Uri baseUri, string ticket)
    {
        var t = "&t=" + Uri.EscapeDataString(ticket);
        var sb = new StringBuilder(playlist.Length * 2);
        foreach (var raw in playlist.Split('\n'))
        {
            var line = raw.TrimEnd('\r');
            if (line.Length == 0)
            {
                sb.Append('\n');
            }
            else if (line[0] == '#')
            {
                // URI="..." attributes: #EXT-X-KEY, #EXT-X-MAP, #EXT-X-MEDIA, I-frame playlists.
                sb.Append(UriAttrRegex().Replace(line, m => $"URI=\"{RelayPath(Absolute(baseUri, m.Groups[1].Value))}{t}\"")).Append('\n');
            }
            else
            {
                sb.Append(RelayPath(Absolute(baseUri, line.Trim()))).Append(t).Append('\n');
            }
        }

        return sb.ToString();
    }

    private static string Absolute(Uri baseUri, string reference) => new Uri(baseUri, reference).AbsoluteUri;

    private static string Base64Url(string s)
        => Convert.ToBase64String(Encoding.UTF8.GetBytes(s)).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static string FromBase64Url(string s)
    {
        var b = s.Replace('-', '+').Replace('_', '/');
        b += new string('=', (4 - (b.Length % 4)) % 4);
        return Encoding.UTF8.GetString(Convert.FromBase64String(b));
    }

    [GeneratedRegex("URI=\"([^\"]+)\"")]
    private static partial Regex UriAttrRegex();
}
