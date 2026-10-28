using Jellyfin.Plugin.Tuner.Services;
using MediaBrowser.Model.Tasks;

namespace Jellyfin.Plugin.Tuner.Tasks;

/// <summary>
/// Dashboard → Scheduled Tasks → Tuner → "Seasons and library tiles". Daily, plus once at
/// startup so a deploy or a settings change takes effect without waiting for the night.
/// Everything it does is idempotent; see <see cref="SeasonService"/> for what and why.
/// </summary>
public class SeasonsTask : IScheduledTask
{
    private readonly SeasonService _seasons;

    public SeasonsTask(SeasonService seasons)
    {
        _seasons = seasons;
    }

    public string Name => "Seasons and library tiles";

    public string Key => "TunerSeasons";

    public string Description => "Shares seasonal playlists in season, keeps the Collections library out of My Media, and redraws library tiles every few days.";

    public string Category => "Tuner";

    public Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
        => _seasons.RunUpkeepAsync(progress, cancellationToken);

    public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
    {
        // 04:10: after midnight so a season starts on its first day, clear of the 03:00ish
        // library scan and backups.
        yield return new TaskTriggerInfo { Type = TaskTriggerInfoType.DailyTrigger, TimeOfDayTicks = TimeSpan.FromHours(4).Add(TimeSpan.FromMinutes(10)).Ticks };
        yield return new TaskTriggerInfo { Type = TaskTriggerInfoType.StartupTrigger };
    }
}
