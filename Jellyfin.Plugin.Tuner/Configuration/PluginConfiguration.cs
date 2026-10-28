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

    /// <summary>Kill switch: stop injecting the client script without uninstalling.</summary>
    public bool DisableInjection { get; set; }
}
