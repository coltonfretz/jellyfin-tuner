using System.Security.Cryptography;
using System.Text;

namespace Jellyfin.Plugin.Tuner.Services;

/// <summary>
/// Short-lived signed tickets for media URLs.
///
/// WHY: an &lt;audio src&gt; or &lt;img src&gt; request can't carry Jellyfin's
/// Authorization header, and Jellyfin 12 no longer accepts ?api_key= on most
/// endpoints. Putting the user's real access token in a URL would also leak it into
/// logs and history. So an authenticated API call hands out a ticket that only
/// unlocks this plugin's stream/logo relays and expires on its own.
///
/// The key is random per process, so a Jellyfin restart invalidates every ticket;
/// the client simply asks for a fresh one when a stream URL is refused.
/// </summary>
public class StreamTickets
{
    private static readonly TimeSpan Lifetime = TimeSpan.FromHours(12);
    private readonly byte[] _key = RandomNumberGenerator.GetBytes(32);

    public string Issue()
    {
        var exp = DateTimeOffset.UtcNow.Add(Lifetime).ToUnixTimeSeconds().ToString(System.Globalization.CultureInfo.InvariantCulture);
        return exp + "." + Sign(exp);
    }

    public bool IsValid(string? ticket)
    {
        if (string.IsNullOrEmpty(ticket))
        {
            return false;
        }

        var dot = ticket.IndexOf('.', StringComparison.Ordinal);
        if (dot <= 0 || !long.TryParse(ticket.AsSpan(0, dot), out var exp))
        {
            return false;
        }

        if (DateTimeOffset.UtcNow.ToUnixTimeSeconds() > exp)
        {
            return false;
        }

        var expected = Encoding.ASCII.GetBytes(Sign(ticket[..dot]));
        var given = Encoding.ASCII.GetBytes(ticket[(dot + 1)..]);
        return CryptographicOperations.FixedTimeEquals(expected, given);
    }

    /// <summary>
    /// Signature for a URL the HLS relay is allowed to fetch. The relay only follows
    /// URLs it signed itself (a channel's stream, or a URL found inside a playlist it
    /// already relayed), which is what keeps it from being an open proxy.
    /// </summary>
    public string SignUrl(string url) => Sign("u|" + url);

    public bool IsSignedUrl(string url, string? sig)
    {
        if (string.IsNullOrEmpty(sig))
        {
            return false;
        }

        return CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(SignUrl(url)), Encoding.ASCII.GetBytes(sig));
    }

    private string Sign(string payload)
    {
        var mac = HMACSHA256.HashData(_key, Encoding.UTF8.GetBytes(payload));
        return Convert.ToBase64String(mac).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }
}
