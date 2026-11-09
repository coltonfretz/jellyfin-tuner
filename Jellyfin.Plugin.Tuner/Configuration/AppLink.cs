namespace Jellyfin.Plugin.Tuner.Configuration;

/// <summary>
/// One app on the "Get apps" page (profile menu -> Get apps). The admin lists them in the
/// plugin settings; each person sees the ones for the device they're on first.
/// </summary>
public class AppLink
{
    /// <summary>Name as people know it, for example "Jellyfin Desktop".</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>One short line under the name: what it's for, or a tip for installing it.</summary>
    public string Note { get; set; } = string.Empty;

    /// <summary>
    /// Devices it's for, comma-separated: android, iphone (iPhone and iPad), windows, mac,
    /// linux, tv. The page shows an app first on a device in this list, and under
    /// "Other devices" for the rest.
    /// </summary>
    public string Devices { get; set; } = string.Empty;

    /// <summary>
    /// Where to get it: a store page, a website, a direct download, or a GitHub project
    /// (https://github.com/owner/repo). A GitHub project gets the newest release's file for
    /// the viewer's device, unless <see cref="Pinned"/> is set.
    /// </summary>
    public string Url { get; set; } = string.Empty;

    /// <summary>
    /// Use <see cref="Url"/> exactly as given, even for a GitHub project. WHY: a project's
    /// newest release isn't always the one to hand out (a broken build, or a test version
    /// you've tried and want everyone on), so the admin can hold a specific download.
    /// </summary>
    public bool Pinned { get; set; }

    /// <summary>
    /// GitHub only: test versions (prereleases) count as "newest" too. WHY this exists:
    /// some projects only publish test versions for a while. Jellyfin Desktop is the case
    /// that started it (2026-11): its only Qt 6 builds are prereleases, and its newest
    /// stable release is 1.12.0, the old Jellyfin Media Player with a 2020 browser engine.
    /// </summary>
    public bool TestVersions { get; set; }

    /// <summary>
    /// A website that installs from the browser (a PWA). On phones the page adds how to put
    /// it on the home screen, since there's no store button to press.
    /// </summary>
    public bool WebApp { get; set; }
}
