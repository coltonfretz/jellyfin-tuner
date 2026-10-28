using System.Globalization;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Drawing;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Playlists;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.IO;
using MediaBrowser.Model.Playlists;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Tuner.Services;

/// <summary>
/// Seasonal sections (e.g. Halloween) and fresh My Media tiles.
///
/// A season is an ordinary Jellyfin collection plus a date range from the plugin settings.
/// While it's in season the client adds a tile for it to My Media (see /Tuner/seasons and
/// injectSeasonal() in tuner.js); out of season the tile is simply not drawn, so nothing
/// has to be moved or deleted to "put the decorations away".
///
/// The daily task (<see cref="Tasks.SeasonsTask"/>) does the server-side upkeep:
///   1. Playlists inside a season's collection are public in season and private (owner
///      only) otherwise, so "Halloween Mix" isn't sitting in everyone's Playlists in June.
///   2. The Collections library stays out of every account's My Media. Jellyfin shows that
///      tile all year once any collection exists, which would undo the "seasonal" part.
///      It's a per-user setting, so it's re-checked daily to cover new accounts.
///   3. Library tiles get redrawn every few days so they pick a new backdrop.
/// </summary>
public class SeasonService
{
    private readonly ILibraryManager _library;
    private readonly IUserManager _users;
    private readonly IPlaylistManager _playlists;
    private readonly IProviderManager _providers;
    private readonly IFileSystem _fileSystem;
    private readonly IImageProcessor _images;
    private readonly ILogger<SeasonService> _logger;

    public SeasonService(ILibraryManager library, IUserManager users, IPlaylistManager playlists, IProviderManager providers, IFileSystem fileSystem, IImageProcessor images, ILogger<SeasonService> logger)
    {
        _library = library;
        _users = users;
        _playlists = playlists;
        _providers = providers;
        _fileSystem = fileSystem;
        _images = images;
        _logger = logger;
    }

    public record Season(string Name, int StartMonth, int StartDay, int EndMonth, int EndDay)
    {
        /// <summary>Both ends included. A range that ends "before" it starts wraps past New Year.</summary>
        public bool Covers(DateTime day)
        {
            var d = (day.Month * 100) + day.Day;
            var start = (StartMonth * 100) + StartDay;
            var end = (EndMonth * 100) + EndDay;
            return start <= end ? d >= start && d <= end : d >= start || d <= end;
        }
    }

    /// <summary>Parses "Name=MM-DD..MM-DD;..." and skips (and logs) anything malformed.</summary>
    public IReadOnlyList<Season> Seasons()
    {
        var list = new List<Season>();
        var raw = Plugin.Instance?.Configuration.Seasons ?? string.Empty;
        foreach (var part in raw.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var eq = part.LastIndexOf('=');
            var range = eq > 0 ? part[(eq + 1)..].Split("..", StringSplitOptions.TrimEntries) : Array.Empty<string>();
            if (range.Length == 2 && TryMonthDay(range[0], out var sm, out var sd) && TryMonthDay(range[1], out var em, out var ed))
            {
                list.Add(new Season(part[..eq].Trim(), sm, sd, em, ed));
            }
            else
            {
                _logger.LogWarning("Tuner: ignoring season setting {Part}; expected Name=MM-DD..MM-DD", part);
            }
        }

        return list;
    }

    private static bool TryMonthDay(string s, out int month, out int day)
    {
        month = day = 0;
        // Parsed against a leap year so 02-29 is accepted; a range simply covers it when it exists.
        if (!DateTime.TryParseExact("2000-" + s, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var d))
        {
            return false;
        }

        month = d.Month;
        day = d.Day;
        return true;
    }

    /// <summary>The collection a season refers to, by exact name (case-insensitive).</summary>
    public BoxSet? FindCollection(string name)
    {
        return _library.GetItemList(new InternalItemsQuery
        {
            IncludeItemTypes = [BaseItemKind.BoxSet],
            Recursive = true,
            Name = name,
        }).OfType<BoxSet>().FirstOrDefault(b => string.Equals(b.Name, name, StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>Collections whose season covers today (server local time), in settings order.</summary>
    public IEnumerable<BoxSet> ActiveCollections()
    {
        var today = DateTime.Now;
        foreach (var season in Seasons())
        {
            if (!season.Covers(today))
            {
                continue;
            }

            var box = FindCollection(season.Name);
            if (box != null)
            {
                yield return box;
            }
        }
    }

    /// <summary>A tile for the client: the collection, and the picture to draw (16:9 Thumb if it has one).</summary>
    public record Tile(Guid Id, string Name, string ImageType, string? ImageTag);

    public IEnumerable<Tile> ActiveTiles()
    {
        foreach (var box in ActiveCollections())
        {
            var thumb = box.GetImageInfo(ImageType.Thumb, 0);
            var info = thumb ?? box.GetImageInfo(ImageType.Primary, 0);
            yield return new Tile(box.Id, box.Name, thumb != null ? "Thumb" : "Primary", info != null ? _images.GetImageCacheTag(box, info) : null);
        }
    }

    public async Task RunUpkeepAsync(IProgress<double> progress, CancellationToken ct)
    {
        var config = Plugin.Instance?.Configuration;
        if (config == null)
        {
            return;
        }

        await SyncPlaylistSharingAsync(ct).ConfigureAwait(false);
        progress.Report(20);
        if (config.HideCollectionsLibrary)
        {
            await HideCollectionsLibraryAsync().ConfigureAwait(false);
        }

        progress.Report(40);
        if (config.ShuffleLibraryTileDays > 0)
        {
            await ShuffleLibraryTilesAsync(TimeSpan.FromDays(config.ShuffleLibraryTileDays), ct).ConfigureAwait(false);
        }

        progress.Report(100);
    }

    private async Task SyncPlaylistSharingAsync(CancellationToken ct)
    {
        var today = DateTime.Now;
        foreach (var season in Seasons())
        {
            var box = FindCollection(season.Name);
            if (box == null)
            {
                _logger.LogInformation("Tuner: no collection named {Name} for the season setting", season.Name);
                continue;
            }

            var inSeason = season.Covers(today);
            foreach (var playlist in box.GetLinkedChildren().OfType<Playlist>())
            {
                if (playlist.OpenAccess == inSeason)
                {
                    continue;
                }

                // Through the playlist manager so the playlist file on disk agrees with the database.
                await _playlists.UpdatePlaylist(new PlaylistUpdateRequest
                {
                    Id = playlist.Id,
                    UserId = playlist.OwnerUserId,
                    Public = inSeason,
                }).ConfigureAwait(false);
                _logger.LogInformation("Tuner: playlist {Name} is now {State}", playlist.Name, inSeason ? "public" : "private");
            }

            ct.ThrowIfCancellationRequested();
        }
    }

    private async Task HideCollectionsLibraryAsync()
    {
        var collections = _library.GetUserRootFolder().Children.OfType<CollectionFolder>()
            .Where(f => f.CollectionType == CollectionType.boxsets)
            .Select(f => f.Id)
            .ToList();
        if (collections.Count == 0)
        {
            return;
        }

        foreach (var user in _users.GetUsers().ToList())
        {
            var configuration = _users.GetUserDto(user, string.Empty).Configuration;
            var excludes = configuration.MyMediaExcludes ?? Array.Empty<Guid>();
            var missing = collections.Where(id => !excludes.Contains(id)).ToList();
            if (missing.Count == 0)
            {
                continue;
            }

            configuration.MyMediaExcludes = excludes.Concat(missing).ToArray();
            await _users.UpdateConfigurationAsync(user.Id, configuration).ConfigureAwait(false);
            _logger.LogInformation("Tuner: hid the Collections library from {User}'s My Media", user.Username);
        }
    }

    /// <summary>
    /// Deletes each library tile older than <paramref name="maxAge"/> and has Jellyfin draw it
    /// again, which picks a new random backdrop. Libraries with their own uploaded picture would
    /// lose it, which is why this can be turned off (ShuffleLibraryTileDays = 0).
    /// </summary>
    private async Task ShuffleLibraryTilesAsync(TimeSpan maxAge, CancellationToken ct)
    {
        var due = DateTime.UtcNow - maxAge;
        var folders = _library.GetUserRootFolder().Children.OfType<CollectionFolder>()
            .Where(f => f.CollectionType != CollectionType.boxsets && f.CollectionType != CollectionType.playlists)
            .ToList();
        foreach (var folder in folders)
        {
            ct.ThrowIfCancellationRequested();
            var image = folder.GetImageInfo(ImageType.Primary, 0);
            if (image != null && image.DateModified > due)
            {
                continue;
            }

            try
            {
                if (image != null)
                {
                    await folder.DeleteImageAsync(ImageType.Primary, 0).ConfigureAwait(false);
                }

                // Only this folder (RefreshSingleItem doesn't walk its contents), with the same
                // default options a library scan uses: with no Primary image left, Jellyfin's
                // own library-tile generator draws a new one. MetadataRefreshMode.None looks
                // tidier but skips the image step too (0.6.0.0 left three tiles blank that way).
                await _providers.RefreshSingleItem(folder, new MetadataRefreshOptions(new DirectoryService(_fileSystem)), ct).ConfigureAwait(false);
                if (folder.GetImageInfo(ImageType.Primary, 0) != null)
                {
                    _logger.LogInformation("Tuner: redrew the {Name} library tile", folder.Name);
                }
                else
                {
                    _logger.LogWarning("Tuner: the {Name} library tile wasn't redrawn; the next library scan will draw it", folder.Name);
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                // A missing tile just shows the library icon, and the next run tries again.
                _logger.LogWarning(ex, "Tuner: could not redraw the {Name} library tile", folder.Name);
            }
        }
    }
}
