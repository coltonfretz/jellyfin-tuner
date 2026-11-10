using System.Net;
using Jellyfin.Plugin.Tuner.Services;
using Jellyfin.Plugin.Tuner.Web;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.Tuner;

public class PluginServiceRegistrator : IPluginServiceRegistrator
{
    public const string StreamClient = "tuner-stream";
    public const string ApiClient = "tuner-api";

    public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
    {
        // Request-time injection of the client script into jellyfin-web's index.html.
        serviceCollection.AddSingleton<IStartupFilter, ScriptInjectionStartupFilter>();

        // WHY two clients: radio relays are open-ended streams, so they must not have a
        // timeout and must not buffer. Catalog/API calls should fail fast instead.
        // The stream client fetches from addresses other people control (stations, CDNs,
        // playlists, redirects), so it may only connect to the public internet
        // (NetGuard). The API client keeps LAN access: Dispatcharr, the HDHomeRun and the
        // station list are home services the admin set.
        serviceCollection.AddHttpClient(StreamClient, c =>
        {
            c.Timeout = Timeout.InfiniteTimeSpan;
            c.DefaultRequestHeaders.UserAgent.ParseAdd("JellyfinTuner/0.1");
        }).ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler
        {
            AutomaticDecompression = DecompressionMethods.None,
            AllowAutoRedirect = true,
            MaxAutomaticRedirections = 5,
            ConnectTimeout = TimeSpan.FromSeconds(8),
            ConnectCallback = NetGuard.ConnectPublicOnlyAsync,
        });
        serviceCollection.AddHttpClient(ApiClient, c =>
        {
            c.Timeout = TimeSpan.FromSeconds(20);
            c.DefaultRequestHeaders.UserAgent.ParseAdd("JellyfinTuner/0.1");
        });

        serviceCollection.AddSingleton<StreamTickets>();
        serviceCollection.AddSingleton<RadioCatalog>();
        serviceCollection.AddSingleton<IcyMetadata>();
        serviceCollection.AddSingleton<JamendoService>();
        serviceCollection.AddSingleton<TvService>();
        serviceCollection.AddSingleton<HlsRelay>();
        serviceCollection.AddSingleton<AntennaService>();
        serviceCollection.AddSingleton<SeasonService>();
        serviceCollection.AddSingleton<AppsService>();
    }
}
