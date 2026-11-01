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
///
/// Each ticket also carries a random part, so no two are alike: the antenna tells
/// viewers apart by their ticket (who still watches a channel, whose old channel to
/// free on a channel change), and before 1.0.2.0 two viewers who opened Surf in the
/// same second got the same ticket and could stop each other's channel.
/// </summary>
public class StreamTickets
{
    private static readonly TimeSpan Lifetime = TimeSpan.FromHours(12);
    private readonly byte[] _key = RandomNumberGenerator.GetBytes(32);

    public string Issue()
    {
        var exp = DateTimeOffset.UtcNow.Add(Lifetime).ToUnixTimeSeconds().ToString(System.Globalization.CultureInfo.InvariantCulture);
        var nonce = Convert.ToBase64String(RandomNumberGenerator.GetBytes(9)).Replace('+', '-').Replace('/', '_');
        var payload = exp + "." + nonce;
        return payload + "." + Sign(payload);
    }

    public bool IsValid(string? ticket)
    {
        if (string.IsNullOrEmpty(ticket))
        {
            return false;
        }

        // "exp.nonce.sig" (or "exp.sig" from before 1.0.2.0): the signature covers
        // everything before the last dot, the expiry is everything before the first.
        var last = ticket.LastIndexOf('.');
        var first = ticket.IndexOf('.', StringComparison.Ordinal);
        if (first <= 0 || !long.TryParse(ticket.AsSpan(0, first), out var exp))
        {
            return false;
        }

        if (DateTimeOffset.UtcNow.ToUnixTimeSeconds() > exp)
        {
            return false;
        }

        var expected = Encoding.ASCII.GetBytes(Sign(ticket[..last]));
        var given = Encoding.ASCII.GetBytes(ticket[(last + 1)..]);
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
