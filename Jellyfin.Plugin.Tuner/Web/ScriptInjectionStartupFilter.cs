using System.Text;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Tuner.Web;

/// <summary>
/// Adds the Tuner client script and stylesheet to jellyfin-web's index.html as it is
/// served.
///
/// WHY middleware instead of editing index.html on disk: Jellyfin 12 serves the web
/// client as static files with no injection hook, the web folder is read-only in the
/// container, and any on-disk edit is wiped by every jellyfin-web update. Rewriting
/// the response leaves nothing behind when the plugin is removed. Same approach as
/// Jellyfin Enhanced, written independently here.
///
/// It is deliberately defensive: only touches the index document, is idempotent, and
/// serves the original bytes untouched on any problem so the web UI never breaks
/// because of this plugin.
/// </summary>
public class ScriptInjectionStartupFilter : IStartupFilter
{
    private const string Marker = "/Tuner/client.js";
    private readonly ILogger<ScriptInjectionStartupFilter> _logger;

    public ScriptInjectionStartupFilter(ILogger<ScriptInjectionStartupFilter> logger)
    {
        _logger = logger;
    }

    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next)
    {
        return app =>
        {
            // Registered ahead of the rest of the pipeline so the request headers we
            // strip below (compression, ranges) are gone before the static handler runs.
            app.Use(InvokeAsync);
            next(app);
        };
    }

    private async Task InvokeAsync(HttpContext context, Func<Task> next)
    {
        if (!HttpMethods.IsGet(context.Request.Method)
            || !IsIndexRequest(context.Request.Path.Value)
            || Plugin.Instance?.Configuration.DisableInjection != false)
        {
            await next().ConfigureAwait(false);
            return;
        }

        // Ask for a plain, complete 200: no gzip/brotli to undo, no 206 partial body.
        context.Request.Headers.Remove("Accept-Encoding");
        context.Request.Headers.Remove("Range");
        context.Request.Headers.Remove("If-Range");

        var original = context.Response.Body;
        using var buffer = new MemoryStream();
        context.Response.Body = buffer;
        try
        {
            await next().ConfigureAwait(false);
        }
        finally
        {
            context.Response.Body = original;
        }

        buffer.Position = 0;
        var isHtml = context.Response.StatusCode == 200
            && (context.Response.ContentType?.Contains("text/html", StringComparison.OrdinalIgnoreCase) ?? false);
        if (!isHtml)
        {
            await buffer.CopyToAsync(original).ConfigureAwait(false);
            return;
        }

        var html = Encoding.UTF8.GetString(buffer.ToArray());
        try
        {
            var bodyClose = html.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);
            if (bodyClose >= 0 && html.IndexOf(Marker, StringComparison.OrdinalIgnoreCase) < 0)
            {
                var v = Uri.EscapeDataString(Plugin.ClientVersion);
                // Relative URLs so a base-url prefix (e.g. /jellyfin/web/) still resolves.
                var tags = $"<link rel=\"stylesheet\" href=\"../Tuner/client.css?v={v}\">"
                    + $"<script src=\"..{Marker}?v={v}\" defer></script>";
                var config = Plugin.Instance?.Configuration;
                if (config?.RotateLatestRows == true)
                {
                    // Settings ride on the tag as data attributes: the script reads them from
                    // document.currentScript, so no extra request before the rows can start.
                    var seconds = Math.Max(20, config.RotateSeconds);
                    var mix = config.MixMusicArtists ? "1" : "0";
                    tags += $"<script src=\"../Tuner/homerows.js?v={v}\" data-seconds=\"{seconds}\" data-mix=\"{mix}\" defer></script>";
                }
                html = html.Substring(0, bodyClose) + tags + html.Substring(bodyClose);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Tuner: script injection failed, serving the original page");
        }

        var bytes = Encoding.UTF8.GetBytes(html);
        context.Response.ContentLength = bytes.Length;
        // The body changed, so the static handler's validators no longer describe it.
        context.Response.Headers.Remove("ETag");
        context.Response.Headers.Remove("Last-Modified");
        context.Response.Headers.Remove("Accept-Ranges");
        await original.WriteAsync(bytes).ConfigureAwait(false);
    }

    private static bool IsIndexRequest(string? path)
    {
        if (string.IsNullOrEmpty(path))
        {
            return false;
        }

        // EndsWith keeps this right when Jellyfin runs under a base-url prefix.
        return path.EndsWith("/web/index.html", StringComparison.OrdinalIgnoreCase)
            || path.EndsWith("/web/", StringComparison.OrdinalIgnoreCase)
            || path.EndsWith("/web", StringComparison.OrdinalIgnoreCase);
    }
}
