using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.Tuner.Configuration;

public class PluginConfiguration : BasePluginConfiguration
{
    /// <summary>
    /// The radio station list: an M3U where each name is "Genre · Station" (README,
    /// "Station list"). Empty hides Radio's live stations.
    /// </summary>
    public string RadioM3uUrl { get; set; } = string.Empty;

    /// <summary>
    /// Jamendo API client ID. Public, read-only identifier (the client secret is not
    /// needed for catalog reads and is deliberately not stored). Empty disables Jamendo.
    /// </summary>
    public string JamendoClientId { get; set; } = string.Empty;

    /// <summary>
    /// Where "Keep" saves Jamendo tracks, inside a folder an existing Music library
    /// already scans. Must be writable by the Jellyfin process.
    /// </summary>
    public string JamendoKeepFolder { get; set; } = string.Empty;

    /// <summary>
    /// Dispatcharr base URL, used by TV surf mode for the free channels' lineup and
    /// now/next. Empty hides them.
    /// </summary>
    public string DispatcharrUrl { get; set; } = string.Empty;

    /// <summary>Dispatcharr API key (X-API-Key). Server-side only; never sent to browsers.</summary>
    public string DispatcharrApiKey { get; set; } = string.Empty;

    /// <summary>
    /// HDHomeRun base URL for the Antenna channels in TV surf mode. Empty hides them.
    /// Give the tuner a fixed address (DHCP reservation) so this keeps working.
    /// </summary>
    public string HdhomerunUrl { get; set; } = string.Empty;

    /// <summary>
    /// Over-the-air channels to leave out, by guide number, comma-separated (for example
    /// shopping channels, duplicate feeds, or ones nobody watches).
    /// </summary>
    public string AntennaHidden { get; set; } = string.Empty;

    /// <summary>
    /// Friendlier names for over-the-air channels (call signs mean little to viewers):
    /// "number=name" separated by semicolons, for example "7.1=PBS;12.1=NBC".
    /// </summary>
    public string AntennaNames { get; set; } = string.Empty;

    /// <summary>
    /// Home page "Recently Added" rows load a deeper list and slide to the next screen of
    /// posters every <see cref="RotateSeconds"/>. WHY: people kept seeing the same few
    /// posters (or one re-tagged artist) every time they opened the app. Web clients only;
    /// the native TV apps draw their own home screen.
    /// </summary>
    public bool RotateLatestRows { get; set; } = true;

    /// <summary>Seconds between slides of each Recently Added row (minimum 20).</summary>
    public int RotateSeconds { get; set; } = 120;

    /// <summary>
    /// Spread artists out in Recently Added in Music, at most three albums per artist, so
    /// re-tagging one artist's albums doesn't fill the row with them.
    /// </summary>
    public bool MixMusicArtists { get; set; } = true;

    /// <summary>
    /// Seasonal sections: a collection that gets its own tile in everyone's My Media between
    /// two dates each year, and disappears the rest of the year. "Name=MM-DD..MM-DD" pairs
    /// separated by semicolons, both dates included; a range may wrap past New Year
    /// (12-15..01-05). Name is the collection's name. WHY a collection: everyone's pages show it
    /// grouped (Movies, Shows, Episodes, Albums) and the admin curates it with Jellyfin's own
    /// "Add to collection", so no list lives in this plugin.
    /// </summary>
    public string Seasons { get; set; } = "Halloween=10-01..11-01";

    /// <summary>
    /// Keep the "Collections" library out of every account's My Media (a per-user setting,
    /// so new accounts are covered by the daily task). WHY: Jellyfin shows that tile all year
    /// as soon as one collection exists, and seasonal collections are reached through their
    /// own tile instead.
    /// </summary>
    public bool HideCollectionsLibrary { get; set; } = true;

    /// <summary>
    /// Days between redraws of each library's My Media tile, 0 for never. WHY: Jellyfin picks
    /// a random backdrop for a tile only when it redraws it, which happens when a library gets
    /// a metadata refresh, so a library that rarely changes kept the same picture for weeks.
    /// </summary>
    public int ShuffleLibraryTileDays { get; set; } = 3;

    /// <summary>
    /// The Music page: Jellyfin's Music links open a simpler page with Search (genre tiles),
    /// Catalog (playlists, a row per decade, daily shelves, A to Z), Now Playing and Radio as
    /// tabs. Radio moves from the top bar into it. Off by default because it takes over the
    /// Music link; Jellyfin's own page stays reachable from its "Classic view" link.
    /// </summary>
    public bool MusicPage { get; set; }

    /// <summary>
    /// Fewest songs for something to be shown as an album on the Music page. Below this it's
    /// a single, or the one track someone has from a compilation; those are still found by
    /// Search and on the artist's and genre's pages.
    /// </summary>
    public int MusicMinSongs { get; set; } = 4;

    /// <summary>
    /// One TV section: the top bar's TV link opens Surf, with tabs for Jellyfin's Live TV page
    /// ("Guide") and the TV library named in <see cref="TvClassicsLibrary"/> ("Classics").
    /// Live TV and that library leave the top bar and side menu. Jellyfin's own pages are kept
    /// (guide grid, recordings, show pages); only the tabs are added to them.
    /// </summary>
    public bool TvSection { get; set; }

    /// <summary>Name of the TV library shown as the TV section's "Classics" tab. Empty: no such tab.</summary>
    public string TvClassicsLibrary { get; set; } = string.Empty;

    /// <summary>
    /// One Movies section: the Movies link gets tabs Movies | Classics, Classics being the movie
    /// library named in <see cref="MoviesClassicsLibrary"/>, which leaves the top bar, side menu
    /// and My Media. Both are Jellyfin's own pages with the tabs added.
    /// </summary>
    public bool MoviesSection { get; set; }

    /// <summary>Name of the movie library shown as the Movies section's "Classics" tab.</summary>
    public string MoviesClassicsLibrary { get; set; } = string.Empty;

    /// <summary>
    /// Address of a request site (Seerr or Jellyseerr). Set: a "Request" link joins the top bar
    /// and side menu and opens it in the browser. Empty: no link.
    /// </summary>
    public string RequestUrl { get; set; } = string.Empty;

    /// <summary>
    /// "Get apps" in everyone's settings menu (avatar -> the list with Profile, Display ...):
    /// a page of the apps in <see cref="Apps"/>, the ones for the device you're on first.
    /// WHY in the settings menu and not the top bar: you need it once per device, and the
    /// top bar is already full (Fretzflix review 2026-11-09). Off by default.
    /// </summary>
    public bool GetApps { get; set; }

    /// <summary>
    /// The apps on the Get apps page, in the order shown. WHY an array and not a List:
    /// XmlSerializer adds a saved List's items to the default ones instead of replacing them
    /// (so the defaults would come back on every load); an array is replaced whole.
    /// The defaults are only Jellyfin's own apps.
    /// </summary>
    public AppLink[] Apps { get; set; } = DefaultApps();

    public static AppLink[] DefaultApps() => new[]
    {
        new AppLink
        {
            Name = "Jellyfin Desktop",
            Note = "Jellyfin's app for computers.",
            Devices = "windows,mac,linux",
            Url = "https://github.com/jellyfin/jellyfin-desktop",
            TestVersions = true,
        },
        new AppLink { Name = "Jellyfin", Note = "Jellyfin's phone app.", Devices = "android", Url = "https://play.google.com/store/apps/details?id=org.jellyfin.mobile" },
        new AppLink { Name = "Jellyfin", Note = "Jellyfin's phone app.", Devices = "iphone", Url = "https://apps.apple.com/app/id1480192618" },
        new AppLink { Name = "Jellyfin for Android TV", Note = "For Google TV and Android TV.", Devices = "tv", Url = "https://play.google.com/store/apps/details?id=org.jellyfin.androidtv" },
    };

    /// <summary>Kill switch: stop injecting the client script without uninstalling.</summary>
    public bool DisableInjection { get; set; }
}
