using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using Microsoft.AspNetCore.Http;

namespace Jellyfin.Plugin.Tuner.Services;

/// <summary>
/// Safety rails for content the plugin relays from other people's servers (radio
/// stations, free-TV CDNs, Jamendo).
///
/// WHY (security review 2026-11-09): the relays answer on Jellyfin's own address. If an
/// upstream (a station, a CDN, an entry in a public channel list) turned hostile, two
/// things could go wrong without these rails:
/// - it could answer with a web page instead of audio or video. Served from Jellyfin's
///   address, a page's script could read the signed-in admin's session.
/// - its playlist (or a redirect) could point at a home or cluster address, making
///   Jellyfin fetch our own LAN services for whoever is watching.
/// </summary>
public static class NetGuard
{
    /// <summary>
    /// ConnectCallback for the stream client: resolves the name and connects only to
    /// public internet addresses. It runs for every connection, so redirects are covered
    /// too, and checking the address actually connected to (not the name) also stops a
    /// name that resolves to a home address.
    /// </summary>
    public static async ValueTask<Stream> ConnectPublicOnlyAsync(SocketsHttpConnectionContext ctx, CancellationToken ct)
    {
        var host = ctx.DnsEndPoint.Host;
        var addresses = IPAddress.TryParse(host, out var literal)
            ? new[] { literal }
            : await Dns.GetHostAddressesAsync(host, ct).ConfigureAwait(false);
        var allowed = addresses.Where(IsPublic).ToArray();
        if (allowed.Length == 0)
        {
            throw new HttpRequestException($"{host} is not a public internet address; Tuner only relays from the internet");
        }

        var socket = new Socket(SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
        try
        {
            await socket.ConnectAsync(allowed, ctx.DnsEndPoint.Port, ct).ConfigureAwait(false);
            return new NetworkStream(socket, ownsSocket: true);
        }
        catch
        {
            socket.Dispose();
            throw;
        }
    }

    /// <summary>False for loopback, private, link-local, carrier-grade NAT, multicast and other non-internet ranges.</summary>
    public static bool IsPublic(IPAddress ip)
    {
        if (ip.IsIPv4MappedToIPv6)
        {
            ip = ip.MapToIPv4();
        }

        if (ip.AddressFamily == AddressFamily.InterNetwork)
        {
            var b = ip.GetAddressBytes();
            return !(b[0] == 0                                   // "this network"
                || b[0] == 10                                    // private (also the cluster's pod and service ranges)
                || b[0] == 127                                   // loopback
                || (b[0] == 100 && b[1] >= 64 && b[1] <= 127)    // carrier-grade NAT (Tailscale uses it too)
                || (b[0] == 169 && b[1] == 254)                  // link-local (cloud metadata lives here)
                || (b[0] == 172 && b[1] >= 16 && b[1] <= 31)     // private
                || (b[0] == 192 && b[1] == 168)                  // private (our LAN)
                || (b[0] == 192 && b[1] == 0 && b[2] == 0)       // protocol assignments
                || (b[0] == 198 && (b[1] == 18 || b[1] == 19))   // benchmarking
                || b[0] >= 224);                                 // multicast and reserved
        }

        if (ip.AddressFamily == AddressFamily.InterNetworkV6)
        {
            var b = ip.GetAddressBytes();
            return !(IPAddress.IsLoopback(ip)
                || ip.Equals(IPAddress.IPv6None)
                || ip.IsIPv6LinkLocal || ip.IsIPv6SiteLocal || ip.IsIPv6Multicast
                || (b[0] & 0xFE) == 0xFC);                       // unique local (fc00::/7)
        }

        return false;
    }

    // ---- what a relayed response may claim to be ----
    // Unknown or unexpected types are replaced, not passed on: a station that labels its
    // stream oddly keeps working, and nothing relayed can ever be treated as a page.

    private static readonly string[] SegmentTypes =
    {
        "video/mp2t", "video/mp4", "audio/mp4", "audio/aac", "audio/mpeg", "application/mp4",
        "application/octet-stream", "binary/octet-stream",
    };

    // No SVG: it's XML text, so a logo from a station's site would be read by the
    // browser's XML engine (the part hit by Chrome's November 2026 zero-day) and could
    // hold script. A station with only an SVG logo shows no logo.
    private static readonly string[] ImageTypes =
    {
        "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp",
        "image/x-icon", "image/vnd.microsoft.icon",
    };

    /// <summary>A radio stream's type: any audio type (or Ogg) as sent, anything else becomes audio/mpeg.</summary>
    public static string AudioType(string? upstream)
    {
        var t = MediaType(upstream);
        return t.StartsWith("audio/", StringComparison.Ordinal) || t == "application/ogg" ? t : "audio/mpeg";
    }

    /// <summary>A TV segment's type: known media types as sent, anything else becomes video/mp2t.</summary>
    public static string SegmentType(string? upstream)
    {
        var t = MediaType(upstream);
        return SegmentTypes.Contains(t) ? t : "video/mp2t";
    }

    /// <summary>A logo's type, or null when it isn't a picture (then there's no logo).</summary>
    public static string? ImageType(string? upstream)
    {
        var t = MediaType(upstream);
        return ImageTypes.Contains(t) ? t : null;
    }

    /// <summary>The picture type from a file's first bytes (PNG, JPEG, GIF, WebP), or null. Never SVG: that's text and could hold script.</summary>
    public static string? SniffImage(byte[] b)
    {
        if (b.Length >= 8 && b[0] == 0x89 && b[1] == 0x50 && b[2] == 0x4E && b[3] == 0x47)
        {
            return "image/png";
        }

        if (b.Length >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF)
        {
            return "image/jpeg";
        }

        if (b.Length >= 6 && b[0] == 'G' && b[1] == 'I' && b[2] == 'F' && b[3] == '8')
        {
            return "image/gif";
        }

        if (b.Length >= 12 && b[0] == 'R' && b[1] == 'I' && b[2] == 'F' && b[3] == 'F' && b[8] == 'W' && b[9] == 'E' && b[10] == 'B' && b[11] == 'P')
        {
            return "image/webp";
        }

        return null;
    }

    /// <summary>
    /// Headers for every relayed response: the browser must take the type as given
    /// (nosniff), and if someone opens the address directly, nothing in it may run
    /// (sandbox). Players and img tags ignore both.
    /// </summary>
    public static void LockDown(HttpResponse response)
    {
        response.Headers["X-Content-Type-Options"] = "nosniff";
        response.Headers["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
    }

    private static string MediaType(string? contentType)
        => (contentType ?? string.Empty).Split(';')[0].Trim().ToLowerInvariant();
}
