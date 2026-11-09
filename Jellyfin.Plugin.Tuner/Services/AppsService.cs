using System.Collections.Concurrent;
using System.Text.Json;
using Jellyfin.Plugin.Tuner.Configuration;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Tuner.Services;

/// <summary>
/// Turns the admin's app list (<see cref="PluginConfiguration.Apps"/>) into what the Get apps
/// page shows: a link per app and, for GitHub projects, the newest release's file for each
/// device (the Windows installer, the Linux AppImage ...) with its version.
///
/// WHY the server looks up GitHub and not each browser: one cached lookup serves everyone,
/// GitHub's API allows 60 unauthenticated calls an hour per address (a household of phones
/// behind one router would use that up), and the page loads with the answer already there.
///
/// WHY not GitHub's own "latest" link: it skips prereleases, and for Jellyfin Desktop
/// (2026-11) that meant 1.12.0, the old app we were moving people off.
///
/// Kept free of Plugin.Instance (the list is passed in) so it can be tried on its own.
/// </summary>
public class AppsService
{
    public static readonly string[] DeviceKinds = { "android", "iphone", "windows", "mac", "linux", "tv" };

    private static readonly TimeSpan Fresh = TimeSpan.FromHours(6);
    private static readonly TimeSpan RetryAfterFailure = TimeSpan.FromMinutes(15);

    private readonly IHttpClientFactory _http;
    private readonly ILogger<AppsService> _logger;

    // Per GitHub project: its recent releases, and when they were fetched. A failed fetch
    // keeps the last good list (marked to retry soon) rather than dropping to no files.
    private readonly ConcurrentDictionary<string, (DateTime At, List<Release>? Releases)> _cache = new(StringComparer.OrdinalIgnoreCase);

    public AppsService(IHttpClientFactory http, ILogger<AppsService> logger)
    {
        _http = http;
        _logger = logger;
    }

    public record Release(string Tag, bool Test, string Page, List<(string Name, string Url)> Files);

    public record DeviceLink(string Url, string? Version, bool Test, string? File);

    public record AppView(string Name, string Note, string[] Devices, bool WebApp, string Url, Dictionary<string, DeviceLink> Links);

    public async Task<List<AppView>> ResolveAsync(IEnumerable<AppLink> apps, CancellationToken ct)
    {
        var result = new List<AppView>();
        foreach (var app in apps)
        {
            // Only http(s): these become links in everyone's page, and a javascript: address
            // typed into the settings would run there.
            if (string.IsNullOrWhiteSpace(app.Name) || !IsWebAddress(app.Url, out var url))
            {
                continue;
            }

            var devices = (app.Devices ?? string.Empty)
                .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Select(d => d.ToLowerInvariant())
                .Where(d => DeviceKinds.Contains(d))
                .Distinct()
                .ToArray();
            var links = new Dictionary<string, DeviceLink>();
            var repo = app.Pinned ? null : GitHubRepo(url);
            if (repo != null)
            {
                var releases = await ReleasesAsync(repo, ct).ConfigureAwait(false);
                url = new Uri($"https://github.com/{repo}/releases");
                foreach (var device in devices)
                {
                    var link = PickFile(releases, device, app.TestVersions);
                    if (link != null)
                    {
                        links[device] = link;
                    }
                }
            }

            result.Add(new AppView(app.Name.Trim(), (app.Note ?? string.Empty).Trim(), devices, app.WebApp, url.AbsoluteUri, links));
        }

        return result;
    }

    private static bool IsWebAddress(string? s, out Uri uri)
    {
        uri = null!;
        return Uri.TryCreate((s ?? string.Empty).Trim(), UriKind.Absolute, out var u)
            && (u.Scheme == Uri.UriSchemeHttps || u.Scheme == Uri.UriSchemeHttp)
            && (uri = u) != null;
    }

    /// <summary>"owner/repo" for a github.com project address (any page of it), else null.</summary>
    public static string? GitHubRepo(Uri url)
    {
        if (!url.Host.Equals("github.com", StringComparison.OrdinalIgnoreCase)
            && !url.Host.Equals("www.github.com", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        var parts = url.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries);
        // A direct file (/owner/repo/releases/download/...) is a specific version: use it as given.
        if (parts.Length < 2 || (parts.Length > 3 && parts[2] == "releases" && parts[3] == "download"))
        {
            return null;
        }

        var repo = parts[1].EndsWith(".git", StringComparison.OrdinalIgnoreCase) ? parts[1][..^4] : parts[1];
        return $"{parts[0]}/{repo}";
    }

    /// <summary>
    /// The newest release with a file for this device (test versions only if allowed). If no
    /// release has a matching file, the newest allowed release's page, so there's still a link
    /// to something current. Null when GitHub couldn't be reached and nothing is cached: the
    /// page then uses the project's releases page.
    /// </summary>
    public static DeviceLink? PickFile(List<Release>? releases, string device, bool testOk)
    {
        if (releases == null)
        {
            return null;
        }

        var allowed = releases.Where(r => testOk || !r.Test).ToList();
        foreach (var r in allowed)
        {
            var best = r.Files
                .Select(f => (f, Score: Score(device, f.Name)))
                .Where(x => x.Score > 0)
                .OrderByDescending(x => x.Score)
                .FirstOrDefault();
            if (best.Score > 0)
            {
                return new DeviceLink(best.f.Url, r.Tag, r.Test, best.f.Name);
            }
        }

        var newest = allowed.FirstOrDefault();
        return newest == null ? null : new DeviceLink(newest.Page, newest.Tag, newest.Test, null);
    }

    /// <summary>
    /// How well a release file fits a device; 0 or less means not for it. Release files follow
    /// no standard, so this goes by the usual words and extensions in their names.
    /// Examples it was written against (jellyfin-desktop 2.1.0-pre1):
    /// jellyfin-desktop-v2.1.0-pre1-windows-x64-installer.zip (windows, beats -portable.zip),
    /// -linux-appimage-x86_64.zip (linux), -macos-arm64.zip (mac); older 1.12.0:
    /// JellyfinMediaPlayer-1.12.0-windows-x64.exe (beats -x86.exe and -x64-legacy.exe).
    /// </summary>
    public static int Score(string device, string fileName)
    {
        var n = fileName.ToLowerInvariant();
        if (n.EndsWith(".sha256") || n.EndsWith(".sha512") || n.EndsWith(".sig") || n.EndsWith(".asc")
            || n.EndsWith(".txt") || n.EndsWith(".json") || n.EndsWith(".yml") || n.EndsWith(".blockmap")
            || n.Contains("debug") || n.Contains("symbols") || n.Contains("source"))
        {
            return 0;
        }

        bool Has(params string[] words) => words.Any(n.Contains);
        var arm = Has("arm64", "aarch64", "armv7", "armhf");
        var x86Only = (Has("x86", "i386", "i686", "win32") && !Has("x86_64", "x86-64", "amd64")) || n.EndsWith("-x86.exe");
        int score;
        switch (device)
        {
            case "windows":
                if (!Has("windows", "win64", "-win-", "_win_") && !n.EndsWith(".exe") && !n.EndsWith(".msi") && !n.EndsWith(".msix"))
                {
                    return 0;
                }

                score = 10;
                if (n.EndsWith(".exe") || n.EndsWith(".msi") || n.EndsWith(".msix") || n.Contains("installer") || n.Contains("setup")) score += 5;
                if (n.Contains("portable")) score -= 2;
                if (n.Contains("legacy")) score -= 3;
                if (arm) score -= 6;
                if (x86Only) score -= 6;
                return score;
            case "mac":
                if (!Has("mac", "osx", "darwin", "apple") && !n.EndsWith(".dmg") && !n.EndsWith(".pkg"))
                {
                    return 0;
                }

                score = 10;
                if (n.EndsWith(".dmg") || n.EndsWith(".pkg")) score += 3;
                // Most Macs sold since 2021 are Apple silicon; a browser can't reliably tell.
                if (Has("arm64", "aarch64", "applesilicon", "apple-silicon", "universal")) score += 1;
                return score;
            case "linux":
                if (!Has("linux", "appimage") && !n.EndsWith(".deb") && !n.EndsWith(".rpm") && !n.EndsWith(".flatpak"))
                {
                    return 0;
                }

                // AppImage runs on any distribution, so it's the one to hand someone.
                score = Has("appimage") ? 15 : n.EndsWith(".flatpak") ? 9 : n.EndsWith(".deb") ? 8 : n.EndsWith(".rpm") ? 7 : 5;
                if (arm) score -= 6;
                return score;
            case "android":
                if (!n.EndsWith(".apk"))
                {
                    return 0;
                }

                score = 10;
                if (Has("universal", "arm64-v8a")) score += 1;
                return score;
            default:
                // iPhone apps come from the App Store and TV apps from a store or a setup page;
                // neither is a file to download.
                return 0;
        }
    }

    private async Task<List<Release>?> ReleasesAsync(string repo, CancellationToken ct)
    {
        if (_cache.TryGetValue(repo, out var hit) && DateTime.UtcNow - hit.At < (hit.Releases == null ? RetryAfterFailure : Fresh))
        {
            return hit.Releases;
        }

        try
        {
            var client = _http.CreateClient(PluginServiceRegistrator.ApiClient);
            using var req = new HttpRequestMessage(HttpMethod.Get, $"https://api.github.com/repos/{repo}/releases?per_page=15");
            req.Headers.Accept.ParseAdd("application/vnd.github+json");
            using var resp = await client.SendAsync(req, ct).ConfigureAwait(false);
            resp.EnsureSuccessStatusCode();
            await using var body = await resp.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
            using var doc = await JsonDocument.ParseAsync(body, cancellationToken: ct).ConfigureAwait(false);
            var list = new List<Release>();
            foreach (var r in doc.RootElement.EnumerateArray())
            {
                if (r.TryGetProperty("draft", out var draft) && draft.GetBoolean())
                {
                    continue;
                }

                var files = new List<(string, string)>();
                if (r.TryGetProperty("assets", out var assets))
                {
                    foreach (var a in assets.EnumerateArray())
                    {
                        files.Add((a.GetProperty("name").GetString() ?? string.Empty, a.GetProperty("browser_download_url").GetString() ?? string.Empty));
                    }
                }

                list.Add(new Release(
                    r.GetProperty("tag_name").GetString() ?? string.Empty,
                    r.TryGetProperty("prerelease", out var pre) && pre.GetBoolean(),
                    r.GetProperty("html_url").GetString() ?? $"https://github.com/{repo}/releases",
                    files));
            }

            // Kept in GitHub's order, which is newest first.
            _cache[repo] = (DateTime.UtcNow, list);
            return list;
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            _logger.LogWarning("Get apps: couldn't read {Repo}'s releases from GitHub ({Error}); using the last list if there is one", repo, ex.Message);
            // Nothing cached: remember the failure so the next try waits RetryAfterFailure.
            // A last good list: keep serving it, dated so it's tried again in that same time.
            var last = hit.Releases;
            _cache[repo] = (last == null ? DateTime.UtcNow : DateTime.UtcNow - Fresh + RetryAfterFailure, last);
            return last;
        }
    }
}
