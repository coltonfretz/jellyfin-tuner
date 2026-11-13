# Jellyfin-Tuned (Jellyfin plugin)

Radio and live TV pages for the Jellyfin web UI, plus a simpler Music page, tidier TV and Movies sections, a Request link, a Get apps page and a few home page touches. Called Tuner before 1.0; the code and URLs still use that name.

> Built with Claude for my own server and shared as is. Tested on Jellyfin 12.4 (web UI, Jellyfin Desktop, Jellyfin Media Player, Android app). Issues and pull requests are welcome.

![The Radio page: a tuning dial, genre buttons, the station list and the player with the song playing](screenshots/radio.webp)

## Contents

- [What it adds](#what-it-adds)
- [Screenshots](#screenshots)
- [Install](#install)
- [Settings](#settings)
- [Station list format](#station-list-format)
- [Details](#details)
- [How it works](#how-it-works)
- [Build and release](#build-and-release)

## What it adds

Every part is off until you set it up.

**Pages**

- **Radio:** your own internet radio stations on a tuning dial, grouped by genre. Favorites, search, song titles, a mini player and media keys.
- **Jamendo:** Creative Commons music by genre, with **Keep** to save a track to your library (when the artist allows it).
- **Surf TV:** flip channels like cable. Free channels from Dispatcharr and antenna channels from an HDHomeRun.
- **Music (optional):** Search, Catalog, Now Playing (with lyrics) and Radio tabs. Jellyfin's own music page stays under **Classic view**.

**Sections**

- **TV:** one link with **Surf**, **Guide** and **Classics** tabs (Classics is a TV library you pick).
- **Movies:** **Library** and **Classics** tabs for a second movie library.
- **Request:** a link to your Seerr or Jellyseerr site. Opens inside Jellyfin when both share a site (`requests.example.com` and `example.com`, https), otherwise in a new tab. Searches that find nothing offer **Can't find it? Request it**.

- **Get apps:** a row in the settings menu (avatar -> Profile, Display ...) opening the apps you list, the ones for the device you're on first. GitHub projects get their newest release's file for that device.

**Watch together**

- **SyncPlay chat:** people in the same SyncPlay group get a chat in a column beside the video (the player shrinks to make room). Full screen turns it into a bubble; elsewhere in Jellyfin it floats in the bottom right with an unread count. Its group button opens SyncPlay's menu to get back to the video.

**Home and everywhere**

- Recently Added rows rotate to the next posters every couple of minutes.
- Seasonal tiles in My Media (a collection that shows only between two dates).
- Library tiles get a new picture every few days.
- The player's controls stay up while the mouse rests on them.

**Works in** web-based apps: browsers, Jellyfin Desktop (and the older Jellyfin Media Player), and the official Android and iPhone apps. Native TV apps (Android TV, Roku, Apple TV) draw their own screens and won't show it.

## Screenshots

Taken on my own server, which also runs a custom theme ([Fretzflix Night](https://github.com/coltonfretz/fretzflix-theme)), so the colors and logo are mine. The plugin's pages pick up whatever theme you use.

**Surf TV:** flip through channels with up and down, grouped by genre.

![Surf TV: a channel playing, the channel list beside it and genre buttons below](screenshots/surf.webp)

**TV section:** Surf, Guide and Classics as tabs under one TV link.

![The TV section's Guide tab: programs on now and coming up](screenshots/guide.webp)

![The TV section's Classics tab: a library of old cartoons and shorts](screenshots/classics.webp)

**Music:** Search, Catalog, Now Playing and Radio tabs, with a Spotlight album up top.

![The Music page's Catalog tab: a Spotlight album, playlists and albums by decade](screenshots/music.webp)

**Jamendo:** Creative Commons music by genre, one track after another.

![Jamendo on the Radio page: genre buttons and the player](screenshots/jamendo.webp)

**Request:** a search that finds nothing offers a way to ask for it.

![A search with no results and a "Can't find it? Request it" button](screenshots/request-search.webp)

## Install

Needs Jellyfin 12.2 or newer.

**From the catalog (gets update notices)**

1. Dashboard -> Plugins -> **Repositories** -> add `https://raw.githubusercontent.com/coltonfretz/jellyfin-tuner/main/manifest.json` (name it `Jellyfin-Tuned`).
2. Dashboard -> Plugins -> **Catalog** -> Jellyfin-Tuned -> Install.
3. Restart Jellyfin.

**By hand:** unzip `Jellyfin.Plugin.Tuner.dll` from [Releases](https://github.com/coltonfretz/jellyfin-tuner/releases) into `<plugins>/Jellyfin-Tuned_<version>/` (`/config/plugins` in the Docker image) and restart.

Then set it up in Dashboard -> Plugins -> Jellyfin-Tuned and reload the web UI.

## Settings

Four tabs. **Turn off the pages** (below them) hides everything without uninstalling.

**Radio & TV**

| Setting | What it does |
|---|---|
| Station list URL | Your stations as an M3U file ([format](#station-list-format)). Empty: no radio. |
| Jamendo client ID | Free from [devportal.jamendo.com](https://devportal.jamendo.com). Client ID only, never the secret. Empty: no Jamendo. |
| Keep folder | A writable folder inside a Music library, e.g. `/media/Music/Jamendo`. Empty: no Keep. |
| Dispatcharr URL + API key | Surf TV's free channels and guide. The key never reaches browsers. |
| HDHomeRun address | Surf TV's antenna channels, e.g. `http://192.168.1.50`. |
| Antenna hide / rename | Hide by number (`7.3,23.3`); rename (`7.1=PBS;12.1=NBC`). |

**Layout**

| Setting | What it does |
|---|---|
| Music page | On/off, plus the fewest songs that count as an album (default 4). |
| TV section | On/off, plus the TV library for the Classics tab. |
| Movies section | On/off, plus the movie library for the Classics tab. |
| Request site address | Your Seerr or Jellyseerr address. Empty: no Request link. |

**Home**

| Setting | What it does |
|---|---|
| Rotate Recently Added | On/off and how often (20 s minimum); optionally spread music artists out. |
| Seasons | `Name=MM-DD..MM-DD;...`, both days included (`Holidays=12-01..01-05`). Name is a collection. |
| Hide the Collections library | Keeps the all-year Collections tile out of My Media. |
| Library tile pictures | Days between new pictures; 0 = never (use 0 if you uploaded your own). |

## Station list format

An M3U file the server can reach:

```
#EXTM3U
#EXTINF:-1 tvg-chno="1100" tvg-logo="http://example.com/logos/soma-metal.png" x-genre-color="#8E24AA",Metal · SomaFM Metal Detector
https://ice1.somafm.com/metal-128-mp3
```

- **Name** is `Genre · Station`; the part before ` · ` is the genre.
- **`tvg-chno`** (required): the dial number. Keep it stable; favorites use it.
- **`tvg-logo`** (optional): the station's picture (PNG, JPEG, GIF, WebP and the like; SVG isn't shown).
- **`x-genre-color`** (optional): the genre's `#RRGGBB` color, on any one of its stations.

[radio-browser.info](https://www.radio-browser.info) has a free API to build a list from.

**Apps**

| Setting | What it does |
|---|---|
| Get apps | On/off: the Get apps row in everyone's settings menu. |
| Apps | Name, a one-line note, a link, and the devices it's for (Android, iPhone and iPad, Windows, Mac, Linux, TV). **Web app** adds the add-to-home-screen steps on phones. For a GitHub project: **Count test versions as the newest**, and **Always use this exact link** to hand out one specific download. Starts with Jellyfin's own apps. |

**Watch together**

| Setting | What it does |
|---|---|
| Chat for SyncPlay groups | On/off: the chat for everyone in a SyncPlay group. Each person also needs SyncPlay access (Dashboard -> Users -> the person). |

## Details

**Music page**

- Genres come from the songs' own tags. Genres under 8 albums share a **More genres** tile.
- Decades with under 16 albums fold into one "Before ..." row.
- Daily picks (Spotlight, shelf order) are the same for everyone and change each day. Nothing is stored.
- Plays through Jellyfin's own player, so the queue, casting and lock screen work. No play history is used.

**Seasonal tiles**

- In season, the collection's tile leads My Media (its Thumb image is the tile). Out of season it's gone.
- Playlists in a season's collection are public in season and private out of it.
- The task Dashboard -> Scheduled Tasks -> Jellyfin-Tuned -> **Seasons and library tiles** runs daily at 04:10. Run it by hand after changing dates.

**Top bar and side menu**

- Tuner measures what fits. In order, it moves libraries into **More**, switches its own links to icons, then tucks Jellyfin's links and shrinks the logo.
- On a crowded phone bar its icons hide one at a time, Request last.
- The side menu always has every entry in Libraries: TV after Music, Request at the end.

**Get apps**

- The device comes from the browser's user agent: Android, iPhone and iPad (an iPad that asks for desktop sites is spotted by its touch screen), Windows, Mac, Linux, TV. Every other device's apps sit under **Other devices**, since the guess is sometimes wrong.
- A GitHub project's file is picked by name: the Windows installer over a portable zip, a Linux AppImage over a .deb, an Android .apk. The release list is fetched by the server, cached 6 hours (GitHub allows 60 lookups an hour without a key), and kept if GitHub is down. With no matching file, the link goes to the newest release's page.
- Inside Jellyfin Desktop and the phone app, links go to the system browser (`NativeShell.openUrl`), where downloads and stores work. Those apps also get **You're using this**, and the old Jellyfin Media Player gets **Replaces the app you're using** on Jellyfin Desktop.

**SyncPlay chat**

- Only members of a group can read or write its chat; the server checks with Jellyfin's SyncPlay on every request. Jellyfin tracks members by user, not device, so the chat shows in all of a member's open Jellyfin windows.
- Messages are kept in memory only (the last 200 per group) and are gone as soon as the group ends, or when Jellyfin restarts. Nothing is written to disk.
- **–** shrinks it to the bubble; **×** hides it until you join another group (a chat button in the top bar brings it back). Enter sends.
- The group button and **Back to the group's video** open Jellyfin's SyncPlay menu (Resume playback, Settings, Leave) over the chat. Esc or its added **Close** row closes it, from the top bar too.
- The column needs a window at least 760 px wide; narrower windows and phones get a floating chat instead.

**For other clients:** `GET /Tuner/sections` (signed in) returns the Classics library names, so a TV app can match them.

## How it works

```
jellyfin-web --(script added to index.html)--> tuner.js + tuner.css
     |  signed-in session
     v
/Tuner/radio, /Tuner/tv, /Tuner/jamendo/*, /Tuner/sections,
/Tuner/apps, /Tuner/party (SyncPlay chat, long poll)          [sign-in]
/Tuner/radio/{n}/stream, .../logo?t=<ticket>                  [ticket]
     +--> station list and streams (relayed), Dispatcharr, HDHomeRun, Jamendo,
          GitHub releases (Get apps)
```

- **Script injected as the page is served,** not edited on disk (read-only in Docker, wiped by updates). On any error the original page is served.
- **Radio is relayed by the server** so https pages can play http streams and read song titles. Only your own stations, so it's not an open proxy.
- **Tickets, not tokens, in URLs:** audio and image tags can't send headers. 12-hour tickets, signed with a key that changes each restart.
- **Free channels play straight from their source** (faster than Live TV), relayed only when a source refuses web pages.
- **Relays only reach the public internet, and only pass on media.** Station and channel streams can't be pointed (by a playlist or a redirect) at a home or cluster address. Whatever an upstream claims, a relayed stream goes out as audio or video and a logo as a picture (never SVG), marked so browsers never treat it as a page. Playlists are capped at 1 MB and 15 seconds.
- **Keep has limits:** 25 tracks per person per day, 50 MB per file, and none while the library's disk has under 5 GB free.
- **Antenna channels are converted on the server** (MPEG-TS) and shared by everyone on the same channel. About one CPU core each; stops after the last viewer.
- **Music plays through the browser's own session** ("play these", like casting from a phone), since jellyfin-web doesn't expose its player.

## Build and release

```bash
./build.sh
```

Builds `dist/Jellyfin.Plugin.Tuner.dll` in the .NET 10 SDK container (Docker only). `BUILD_HOST=user@host ./build.sh` builds over SSH.

To release: bump `<AssemblyVersion>` in the `.csproj` (browsers only fetch the new script after a bump), then `./release.sh "what changed"`.

**Testing a script change without installing:** in a tab at `/web/manifest.json`, fetch `/web/index.html`, `/Tuner/client.js` and `/Tuner/client.css`, apply your edits, point the tags at `blob:` URLs, `history.replaceState(null, '', '/web/#/home')`, then `document.write` the page. No `<base>` tag. Close it after Surf TV (it tunes a channel).

## License

MIT, see [LICENSE](LICENSE). hls.js (Surf TV) is Apache 2.0: `Jellyfin.Plugin.Tuner/Web/hls.LICENSE`.
