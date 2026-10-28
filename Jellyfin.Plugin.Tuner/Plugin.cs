using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;
using Jellyfin.Plugin.Tuner.Configuration;

namespace Jellyfin.Plugin.Tuner;

/// <summary>
/// Tuner: a radio dial and a TV surf mode added to the Jellyfin web UI.
///
/// Everything user-facing is a script injected into jellyfin-web (see
/// ScriptInjectionStartupFilter). The server side only does what a browser can't:
/// read the radio list from the LAN, relay http streams to https pages, read
/// in-stream song titles, and talk to Jamendo/Dispatcharr with server-held keys.
/// </summary>
public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
    }

    public static Plugin? Instance { get; private set; }

    public override string Name => "Tuner";

    public override Guid Id => Guid.Parse("6d5e2f2a-5308-427c-9e34-42892a8fe0cc");

    public override string Description => "Radio dial and TV surf mode for the Jellyfin web UI.";

    /// <summary>
    /// Version string used to cache-bust the injected script. The assembly version
    /// changes on every release, so browsers fetch the new client after an upgrade.
    /// </summary>
    public static string ClientVersion => typeof(Plugin).Assembly.GetName().Version?.ToString() ?? "0";

    public IEnumerable<PluginPageInfo> GetPages()
    {
        return new[]
        {
            new PluginPageInfo
            {
                Name = Name,
                EmbeddedResourcePath = "Tuner.Configuration.configPage.html",
            },
        };
    }
}
