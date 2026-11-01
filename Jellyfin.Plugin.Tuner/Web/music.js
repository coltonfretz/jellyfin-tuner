/*
 * Tuner Music: a simpler front page for the music library in jellyfin-web, in the spirit of
 * Apple Music. Tabs: Search (genre tiles and a search box, the first thing you see),
 * Catalog (a daily Spotlight, playlists, a row per decade, a few genre-and-decade shelves
 * that change every day, and everything A to Z), Now Playing, and Radio (Tuner's radio page).
 *
 * WHY its own page instead of restyling Jellyfin's: Jellyfin's music library opens on a wall
 * of tabs (Albums, Album Artists, Artists, Playlists, Songs, Genres, Suggestions...) and
 * every one of them is a flat grid of everything, singles from compilations included. CSS
 * can't regroup that. Jellyfin's own page stays one click away ("Classic view").
 *
 * Loaded only when "Music page" is on in the plugin settings (its own script tag, read by
 * tuner.js to know it's coming). tuner.js still owns page switching, the top bar and the
 * radio; this file draws the music page and answers through window.TunerMusic.
 *
 * Playback goes through Jellyfin's own player, by asking the server to send a "play these"
 * command to this very browser session (the same thing "Play on" from another device does).
 * WHY: jellyfin-web 12 exposes no player object to outside scripts, and a second player of
 * our own would mean no bottom now-playing bar, no queue, no lock screen controls and two
 * things fighting over the speakers. The command takes well under a second to arrive.
 *
 * Privacy: everything here is built from what the library already knows about each album
 * (name, year, genre, song count). No play history is read, and nothing new is stored on
 * the server. The only things kept are in this browser: the Albums/Artists choice.
 */
(function () {
    'use strict';
    if (window.__tunerMusicLoaded) return;
    window.__tunerMusicLoaded = true;

    const me = document.currentScript;
    // Fewer songs than this and it's a single, or one track from someone's compilation. Those
    // stay findable (Search, the artist's page, the genre page) but aren't shown as albums.
    const MIN_SONGS = Math.max(1, parseInt(me && me.dataset.minSongs, 10) || 4);
    const ROUTE = '#/tuner/music';
    const SHELF_MIN = 8;          // a shelf needs this many albums, or it looks broken
    const DECADE_ALONE = 16;      // a decade needs this many to get its own row (see buckets())
    const GENRE_TILE_MIN = 8;     // smaller genres share the "More genres" tile
    const DAILY_SHELVES = 6;      // genre-and-decade shelves shown per day
    const ROW_CARDS = 30;         // cards per Catalog row before "See all"
    const MAX_QUEUE = 200;        // ids per play command (they ride in the URL; Kestrel caps it ~8 KB)
    const INDEX_TTL = 30 * 60 * 1000;
    const NP_POLL_MS = 2000;
    const LETTERS = '#ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    // Genre tile colors: the same colors as the Radio dial's genres in the station list this
    // was built with, so a genre looks the same on both pages, and picked for how the genre
    // feels rather than at random (random colors repeated and clashed). Keys are the genre name
    // in lower case with everything but letters and digits removed ("R&B" -> "rb").
    const RADIO_COLORS = ['#8B1E2D', '#2F2F2F', '#4A2C6F', '#9C4A1A', '#1F4E79', '#00695C', '#AD1457', '#8D6E00',
        '#0277BD', '#4E6A78', '#E64A19', '#6D4C41', '#556B2F', '#283593', '#006064', '#2E7D32'];
    const GENRE_FEEL = {
        alternative: '#00695C', indie: '#00695C', electronic: '#0277BD', dance: '#0277BD', edm: '#0277BD', house: '#0277BD',
        emo: '#AD1457', folk: '#556B2F', hiphop: '#8D6E00', rap: '#8D6E00', jazz: '#283593', metal: '#2F2F2F',
        metalcore: '#8B1E2D', heavymetal: '#4A2C6F', hardrock: '#9C4A1A', pop: '#E64A19', punk: '#8B1E2D',
        rb: '#4A2C6F', rnb: '#4A2C6F', soulfunk: '#6D4C41', soul: '#6D4C41', funk: '#6D4C41', rock: '#1F4E79',
        blues: '#4E6A78', chill: '#4E6A78', lofi: '#4E6A78', ambient: '#4E6A78', classical: '#006064',
        reggae: '#2E7D32', latin: '#2E7D32', country: '#9C4A1A', soundtrack: '#2F2F2F', christiangospel: '#4A2C6F',
        gospel: '#4A2C6F', christian: '#4A2C6F', comedy: '#E64A19', jpopkpop: '#AD1457', kpop: '#AD1457', jpop: '#AD1457',
        world: '#00695C',
    };
    const COLORS = ['#7a2a3e', '#5b2a86', '#22506b', '#8a6d2a', '#2a6b5e', '#6b2238', '#46306b', '#6b4a22',
        '#2d4f7a', '#3d5a2a', '#6b2a5e', '#4f4f2d', '#2a5e3d', '#7a3e2a', '#2d2d4f', '#5e2a2a'];

    const M = {
        index: null, loading: null,
        page: null, renderId: 0, hash: '', pushed: false, scroll: {}, tab: 'search',
        lists: {},            // song lists on the current view, for "play from this song"
        sid: null,            // this browser's Jellyfin session id
        np: null, npTimer: null, tickTimer: null, queueIds: [],
        searchTimer: null, searchQ: '',
        azMode: 'albums',
    };

    // ---------- small helpers ----------

    const $ = (sel, root) => (root || document).querySelector(sel);
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const uid = () => ApiClient.getCurrentUserId();
    const get = (path, params) => ApiClient.getJSON(ApiClient.getUrl(path, params));
    const post = (path, params, body) => ApiClient.ajax({
        type: 'POST', url: ApiClient.getUrl(path, params),
        data: body ? JSON.stringify(body) : undefined, contentType: body ? 'application/json' : undefined,
    });
    const store = (k, v) => { try { localStorage.setItem('tuner.music.' + k, JSON.stringify(v)); } catch (e) { /* private mode */ } };
    const load = (k, d) => { try { const v = localStorage.getItem('tuner.music.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
    const hashOf = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0; return h >>> 0; };
    const colorOf = (s) => COLORS[hashOf(String(s)) % COLORS.length];
    // Colors for a set of genres shown together, never the same color twice in one set: a
    // genre whose own color is taken gets the first radio color nobody in the set uses yet.
    function genreColors(genres) {
        const used = new Set();
        const want = (g) => GENRE_FEEL[fold(g.name).replace(/[^a-z0-9]/g, '')];
        genres.forEach((g) => { const c = want(g); if (c && !used.has(c)) { g.color = c; used.add(c); } else g.color = null; });
        genres.forEach((g) => {
            if (g.color) return;
            g.color = RADIO_COLORS.find((c) => !used.has(c)) || colorOf(g.name);
            used.add(g.color);
        });
    }
    const initials = (n) => String(n || '?').replace(/[^\p{L}\p{N} ]/gu, '').split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
    const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
    const time = (ticks) => {
        const s = Math.max(0, Math.round((ticks || 0) / 1e7));
        const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
        return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
    };
    const imgUrl = (id, tag, h, type) => (id && tag
        ? ApiClient.getUrl(`Items/${id}/Images/${type || 'Primary'}`, { tag, maxHeight: h || 300, quality: 90 }) : '');

    // Same picks for everyone on the same day, different tomorrow. No server state needed.
    function today() { const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; }
    function rng(seed) {
        let a = hashOf(seed) || 1;
        return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    }
    function shuffle(arr, rnd) {
        const a = arr.slice(); rnd = rnd || Math.random;
        for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
        return a;
    }

    // Song tags spelled in lower case ("country", "r&b") show as "Country" and "R&B".
    // Anything with a capital letter was spelled on purpose and is left alone.
    function genreLabel(n) {
        if (n !== n.toLowerCase()) return n;
        return n.split(/(\s+|-)/).map((w) => (w.includes('&') && w.length <= 3 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))).join('');
    }
    const letterOf = (sort) => { const c = fold(sort).charAt(0).toUpperCase(); return c >= 'A' && c <= 'Z' ? c : '#'; };

    // ---------- the library index ----------
    //
    // One pass over every album, album artist and playlist when the page first opens (1,600
    // albums is a few hundred KB), then everything is sorted and grouped here. WHY not ask
    // Jellyfin per shelf: it can't filter by song count, and its album genres mix the song
    // tags with whatever its online lookups attach ("zolo", "acid house"). Only the genres
    // that songs actually carry count here, the same rule as Fretzpod's Genres.

    async function loadIndex() {
        if (M.index && Date.now() - M.index.at < INDEX_TTL) return M.index;
        if (M.loading) return M.loading;
        M.loading = (async () => {
            const u = uid();
            const [genres, albums, artists, playlists, views] = await Promise.all([
                get('MusicGenres', { UserId: u, IncludeItemTypes: 'Audio', Recursive: true, Limit: 2000 }),
                get(`Users/${u}/Items`, { IncludeItemTypes: 'MusicAlbum', Recursive: true, Fields: 'ProductionYear,Genres,ChildCount,SortName', Limit: 20000 }),
                get('Artists/AlbumArtists', { UserId: u, Fields: 'SortName', Limit: 20000 }),
                get(`Users/${u}/Items`, { IncludeItemTypes: 'Playlist', Recursive: true, Fields: 'ChildCount,MediaType', SortBy: 'SortName' }),
                get(`Users/${u}/Views`),
            ]);
            const byName = new Map();
            (genres.Items || []).forEach((g) => byName.set(g.Name.toLowerCase(), { id: g.Id, name: genreLabel(g.Name), albums: [] }));
            const all = (albums.Items || []).map((a) => {
                const artists = a.AlbumArtists || [];
                const album = {
                    id: a.Id, name: a.Name, sort: a.SortName || a.Name,
                    artist: a.AlbumArtist || (artists[0] && artists[0].Name) || 'Unknown artist',
                    artistIds: artists.map((x) => x.Id),
                    // Some files carry a broken date that Jellyfin reads as year 1.
                    year: a.ProductionYear >= 1000 ? a.ProductionYear : null,
                    tag: a.ImageTags && a.ImageTags.Primary, songs: a.ChildCount || 0, genres: [],
                };
                album.real = album.songs >= MIN_SONGS;
                const seen = new Set();
                (a.Genres || []).forEach((n) => {
                    const g = byName.get(String(n).toLowerCase());
                    if (!g || seen.has(g.name)) return;
                    seen.add(g.name); album.genres.push(g.name);
                    if (album.real) g.albums.push(album);
                });
                return album;
            });
            const real = all.filter((a) => a.real);
            const idx = {
                at: Date.now(), all, real,
                byId: new Map(all.map((a) => [a.id, a])),
                genres: Array.from(byName.values()),
                artists: (artists.Items || []).map((x) => ({ id: x.Id, name: x.Name, sort: x.SortName || x.Name, tag: x.ImageTags && x.ImageTags.Primary })),
                playlists: (playlists.Items || []).filter((p) => p.MediaType === 'Audio' || !p.MediaType)
                    .map((p) => ({ id: p.Id, name: p.Name, tag: p.ImageTags && p.ImageTags.Primary, songs: p.ChildCount || 0 })),
                libId: ((views.Items || []).find((v) => v.CollectionType === 'music') || {}).Id || null,
            };
            buckets(idx);
            const byNameSort = (a, b) => a.name.localeCompare(b.name);
            idx.bigGenres = idx.genres.filter((g) => g.albums.length >= GENRE_TILE_MIN).sort(byNameSort);
            idx.smallGenres = idx.genres.filter((g) => g.albums.length < GENRE_TILE_MIN).sort(byNameSort);
            genreColors(idx.bigGenres);
            genreColors(idx.smallGenres);
            M.index = idx;
            return idx;
        })().finally(() => { M.loading = null; });
        return M.loading;
    }

    // Decade rows. Newest decades first; as soon as a decade is too thin to stand alone,
    // it and everything older share one "Before <year>" row. WHY: most libraries lean recent
    // (three albums from the 80s is common), and a row of three covers looks broken.
    function buckets(idx) {
        const counts = {};
        idx.real.forEach((a) => { if (a.year) { const d = Math.floor(a.year / 10) * 10; counts[d] = (counts[d] || 0) + 1; } });
        const decades = Object.keys(counts).map(Number).sort((a, b) => b - a);
        let cut = null;
        for (const d of decades) { if (counts[d] < DECADE_ALONE) { cut = d; break; } }
        if (cut === decades[0]) cut = null;   // even the newest is thin: no merging, just skip thin rows
        idx.bucketOf = (y) => (!y ? null : (cut !== null && y < cut + 10 ? 'before' : Math.floor(y / 10) * 10));
        idx.beforeLabel = cut !== null ? `Before ${cut + 10}` : '';
        idx.real.forEach((a) => { a.bucket = idx.bucketOf(a.year); });
        const keys = decades.filter((d) => cut === null || d > cut);
        if (cut !== null) keys.push('before');
        idx.decades = keys.map((k) => ({
            key: 'd:' + k, title: k === 'before' ? idx.beforeLabel : (k >= 2000 ? `The ${k}s` : `The ${String(k).slice(2)}s`),
            albums: idx.real.filter((a) => a.bucket === k),
        })).filter((s) => s.albums.length >= SHELF_MIN);
        // Genre-and-decade shelves: "2010s Hip Hop", "Classic Jazz" (for the "before" row).
        idx.mixed = [];
        idx.genres.forEach((g) => {
            const by = {};
            g.albums.forEach((a) => { if (a.bucket != null) (by[a.bucket] = by[a.bucket] || []).push(a); });
            Object.keys(by).forEach((k) => {
                if (by[k].length < SHELF_MIN) return;
                const title = k === 'before' ? `Classic ${g.name}` : `${Number(k) >= 2000 ? k : String(k).slice(2)}s ${g.name}`;
                idx.mixed.push({ key: `m:${k}:${g.name}`, title, albums: by[k] });
            });
        });
    }

    function shelfByKey(idx, key) {
        if (key === 'playlists') return { key, title: 'Playlists', playlists: idx.playlists };
        return idx.decades.find((s) => s.key === key) || idx.mixed.find((s) => s.key === key) || null;
    }

    // ---------- playback (through Jellyfin's own player) ----------

    async function sessionId(fresh) {
        if (M.sid && !fresh) return M.sid;
        const list = await get('Sessions', { deviceId: ApiClient.deviceId() });
        const mine = (list || []).find((s) => s.UserId === uid()) || (list || [])[0];
        M.sid = mine ? mine.Id : null;
        return M.sid;
    }

    async function command(path, params) {
        for (const fresh of [false, true]) {
            const sid = await sessionId(fresh);
            if (!sid) continue;
            try { await post(`Sessions/${sid}/${path}`, params); return true; } catch (e) { /* session changed: look it up again */ }
        }
        toast("Couldn't reach the player. Try reloading the page.");
        return false;
    }

    async function playIds(ids, start) {
        ids = (ids || []).filter(Boolean);
        if (!ids.length) { toast('Nothing to play'); return; }
        start = Math.max(0, start || 0);
        // Keep the chosen song inside the window that fits in one command.
        const from = Math.max(0, Math.min(start, ids.length - MAX_QUEUE));
        const slice = ids.slice(from, from + MAX_QUEUE);
        if (window.Tuner && window.Tuner.stopRadio) window.Tuner.stopRadio();
        M.queueIds = slice;
        const ok = await command('Playing', { playCommand: 'PlayNow', itemIds: slice.join(','), startIndex: start - from });
        if (ok && M.tab === 'nowplaying') setTimeout(pollNp, 700);
    }

    const songsOf = (r) => (r.Items || []).map((s) => s.Id);
    const albumTracks = (id) => get(`Users/${uid()}/Items`, { ParentId: id, IncludeItemTypes: 'Audio', Recursive: true, SortBy: 'ParentIndexNumber,IndexNumber,SortName', Fields: 'ParentIndexNumber' });
    const playlistTracks = (id) => get(`Playlists/${id}/Items`, { UserId: uid() });
    const randomSongs = (params) => get(`Users/${uid()}/Items`, Object.assign({ IncludeItemTypes: 'Audio', Recursive: true, SortBy: 'Random', Limit: 150 }, params || {}));

    async function playAlbum(id, shuffled) { const ids = songsOf(await albumTracks(id)); playIds(shuffled ? shuffle(ids) : ids, 0); }
    async function playPlaylist(id, shuffled) { const ids = songsOf(await playlistTracks(id)); playIds(shuffled ? shuffle(ids) : ids, 0); }

    // Tuner's radio started: pause the library song so the two don't play over each other.
    function pauseJellyfin() { if (M.sid) command('Playing/Pause'); }

    function toast(msg) {
        if (window.Tuner && window.Tuner.toast) window.Tuner.toast(msg);
    }

    // ---------- routing ----------

    function parse(hash) {
        const m = /^#\/tuner\/music(?:\/([a-z]+))?\/?(?:\?(.*))?$/.exec(hash || '');
        return { view: (m && m[1]) || 'search', params: new URLSearchParams((m && m[2]) || '') };
    }

    // pushState, never a plain hash change: jellyfin-web answers a hash change to a route it
    // doesn't know with its "page not found" view. tuner.js notices the new address.
    function nav(href) {
        if (href === location.hash) return;
        M.pushed = true;
        history.pushState({ page: 'tuner-music' }, 'Music', href);
        if (window.Tuner) window.Tuner.route();
    }

    const TABS = [
        { tab: 'search', label: 'Search', href: ROUTE + '/search' },
        { tab: 'catalog', label: 'Catalog', href: ROUTE + '/catalog' },
        { tab: 'nowplaying', label: 'Now Playing', href: ROUTE + '/nowplaying' },
        { tab: 'radio', label: 'Radio', href: '#/tuner/radio' },
    ];
    const TAB_OF = { search: 'search', genre: 'search', genres: 'search', catalog: 'catalog', shelf: 'catalog', nowplaying: 'nowplaying' };

    function tabsHtml(active) {
        return `<nav class="tnm-tabs" aria-label="Music">${TABS.map((t) => `<a class="tnm-tab${t.tab === active ? ' on' : ''}" href="${t.href}" data-href="${t.href}"${t.tab === active ? ' aria-current="page"' : ''}>${t.label}</a>`).join('')}
            <span class="tnm-gap"></span><button type="button" class="tnm-classic" data-act="classic" title="Jellyfin's own music page">Classic view</button></nav>`;
    }

    // "Classic view" sticks until a Music link is clicked again (tuner.js clears it), so going
    // into an album on Jellyfin's page and pressing Back lands on Jellyfin's page again.
    const CLASSIC_KEY = 'tuner.music.classic';
    const classicOn = () => { try { return sessionStorage.getItem(CLASSIC_KEY) === '1'; } catch (e) { return false; } };
    const classicOff = () => { try { sessionStorage.removeItem(CLASSIC_KEY); } catch (e) { /* ignore */ } };
    async function openClassic() {
        try { sessionStorage.setItem(CLASSIC_KEY, '1'); } catch (e) { /* ignore */ }
        let lib = M.index && M.index.libId;
        if (!lib) { try { lib = (((await get(`Users/${uid()}/Views`)).Items || []).find((v) => v.CollectionType === 'music') || {}).Id; } catch (e) { /* ignore */ } }
        // A real hash change on purpose: this one should be handled by Jellyfin's router.
        location.hash = lib ? `#/music?topParentId=${lib}&collectionType=music` : '#/music';
    }

    async function show(page, hash) {
        // The same address twice (our own call, then tuner.js's address watcher): draw once.
        if (M.active && hash === M.hash && M.page === page) return;
        M.active = true;
        const r = parse(hash);
        // Remember where we were on the old view, so Back returns to the same spot.
        if (M.hash) M.scroll[M.hash] = window.scrollY;
        const restore = !M.pushed && M.scroll[hash] != null ? M.scroll[hash] : 0;
        M.pushed = false;
        M.hash = hash;
        M.page = page;
        if (TAB_OF[r.view]) M.tab = TAB_OF[r.view];
        stopNp();
        const id = ++M.renderId;
        const wrap = $('.tnr-wrap', page);
        wrap.classList.add('tnm-wrap');
        bind(page);
        wrap.innerHTML = tabsHtml(M.tab) + '<div class="tnm-body"><div class="tnm-empty">Loading your music…</div></div>';
        const body = $('.tnm-body', wrap);
        let idx;
        try { idx = await loadIndex(); } catch (e) {
            if (id === M.renderId) body.innerHTML = '<div class="tnm-empty">Couldn\'t load your music library.</div>';
            return;
        }
        if (id !== M.renderId) return;
        M.lists = {};
        const view = VIEWS[r.view] || VIEWS.search;
        try {
            await view(body, idx, r.params, () => id === M.renderId);
        } catch (e) {
            if (id === M.renderId) body.innerHTML = '<div class="tnm-empty">Couldn\'t load this page.</div>';
            return;
        }
        if (id !== M.renderId) return;
        document.title = 'Music';
        window.scrollTo(0, restore);
    }

    function leave() {
        stopNp();
        M.active = false;
        M.renderId++;
        if (M.hash) M.scroll[M.hash] = window.scrollY;
    }

    // ---------- shared pieces ----------

    function art(id, tag, name, cls, h) {
        const u = imgUrl(id, tag, h);
        return u
            ? `<div class="tnm-art ${cls || ''}"><img src="${esc(u)}" alt="" loading="lazy" decoding="async"></div>`
            : `<div class="tnm-art tnm-noart ${cls || ''}" style="background:${colorOf(name)}"><span>${esc(initials(name))}</span></div>`;
    }

    function albumCard(a, sub) {
        const href = `${ROUTE}/album?id=${a.id}`;
        return `<a class="tnm-card" href="${href}" data-href="${href}" title="${esc(a.name)}">
            <div class="tnm-artbox">${art(a.id, a.tag, a.name)}<button type="button" class="tnm-hoverplay" data-act="play-album" data-id="${a.id}" aria-label="Play ${esc(a.name)}"><span class="material-icons" aria-hidden="true">play_arrow</span></button></div>
            <div class="tnm-card-title">${esc(a.name)}</div><div class="tnm-card-sub">${esc(sub != null ? sub : a.artist)}</div></a>`;
    }

    function playlistCard(p) {
        const href = `${ROUTE}/playlist?id=${p.id}`;
        return `<a class="tnm-card" href="${href}" data-href="${href}" title="${esc(p.name)}">
            <div class="tnm-artbox">${art(p.id, p.tag, p.name)}<button type="button" class="tnm-hoverplay" data-act="play-playlist" data-id="${p.id}" aria-label="Play ${esc(p.name)}"><span class="material-icons" aria-hidden="true">play_arrow</span></button></div>
            <div class="tnm-card-title">${esc(p.name)}</div><div class="tnm-card-sub">${esc(plural(p.songs, 'song'))}</div></a>`;
    }

    function artistCard(x) {
        const href = `${ROUTE}/artist?id=${x.id}`;
        return `<a class="tnm-card tnm-artist" href="${href}" data-href="${href}" title="${esc(x.name)}">
            <div class="tnm-artbox">${art(x.id, x.tag, x.name, 'tnm-round')}</div><div class="tnm-card-title">${esc(x.name)}</div></a>`;
    }

    function shelf(title, cardsHtml, opts) {
        opts = opts || {};
        const more = opts.more ? `<a class="tnm-more" href="${opts.more}" data-href="${opts.more}">See all</a>` : '';
        return `<section class="tnm-shelf"${opts.id ? ` id="${opts.id}"` : ''}>
            <div class="tnm-shelf-head"><h2>${esc(title)}</h2>${more}
                <button type="button" class="tnm-arrow" data-act="row" data-d="-1" aria-label="Scroll back"><span class="material-icons" aria-hidden="true">chevron_left</span></button>
                <button type="button" class="tnm-arrow" data-act="row" data-d="1" aria-label="Scroll on"><span class="material-icons" aria-hidden="true">chevron_right</span></button></div>
            <div class="tnm-row">${cardsHtml}</div></section>`;
    }

    // A song list that plays from whichever song is clicked, the rest of the list queued after it.
    function songList(key, songs, opts) {
        opts = opts || {};
        M.lists[key] = songs.map((s) => s.Id);
        return `<ol class="tnm-songs">${songs.map((s, i) => {
            const artists = (s.Artists && s.Artists.length ? s.Artists.join(', ') : s.AlbumArtist) || '';
            const sub = opts.album ? (artists !== opts.album.artist ? artists : '') : [artists, s.Album].filter(Boolean).join(' · ');
            const num = opts.numbers ? `<span class="tnm-num">${s.IndexNumber || i + 1}</span>`
                : `<span class="tnm-num">${art(s.AlbumId, s.AlbumPrimaryImageTag, s.Album || s.Name, 'tnm-mini', 80)}</span>`;
            return `<li class="tnm-song" data-act="play-song" data-list="${key}" data-i="${i}" tabindex="0">${num}
                <span class="tnm-song-text"><span class="tnm-song-name">${esc(s.Name)}</span>${sub ? `<span class="tnm-song-sub">${esc(sub)}</span>` : ''}</span>
                <span class="tnm-song-time">${time(s.RunTimeTicks)}</span></li>`;
        }).join('')}</ol>`;
    }

    function header(opts) {
        return `<header class="tnm-head">${opts.art || ''}<div class="tnm-head-text">
            ${opts.kicker ? `<div class="tnm-kicker">${esc(opts.kicker)}</div>` : ''}<h1>${esc(opts.title)}</h1>
            ${opts.sub ? `<div class="tnm-head-sub">${opts.sub}</div>` : ''}
            <div class="tnm-buttons">${opts.buttons || ''}</div></div></header>`;
    }
    const button = (act, label, icon, extra) => `<button type="button" class="tnm-btn${extra && extra.primary ? ' tnm-primary' : ''}" data-act="${act}"${extra && extra.id ? ` data-id="${esc(extra.id)}"` : ''}><span class="material-icons" aria-hidden="true">${icon}</span>${label}</button>`;

    // ---------- views ----------

    const VIEWS = {};

    // Search: the landing tab. Genre tiles until something is typed, then results.
    VIEWS.search = async (body, idx) => {
        const rnd = rng('genres' + today());
        const big = idx.bigGenres, small = idx.smallGenres;
        const tile = (g) => {
            // One of the genre's covers peeks out of the corner, a different one each day.
            const a = g.albums.length ? g.albums[Math.floor(rnd() * g.albums.length)] : null;
            const href = `${ROUTE}/genre?name=${encodeURIComponent(g.name)}`;
            return `<a class="tnm-genre" href="${href}" data-href="${href}" style="background:${g.color}"><span>${esc(g.name)}</span>
                ${a && a.tag ? `<img src="${esc(imgUrl(a.id, a.tag, 200))}" alt="" loading="lazy">` : ''}</a>`;
        };
        body.innerHTML = `<div class="tnm-searchbox"><span class="material-icons" aria-hidden="true">search</span>
                <input type="search" class="tnm-search" placeholder="Artists, albums, songs" aria-label="Search music" value="${esc(M.searchQ)}" autocomplete="off"></div>
            <div class="tnm-results"></div>
            <div class="tnm-browse"><h2 class="tnm-h2">Browse genres</h2><div class="tnm-genres">
                ${big.map(tile).join('')}
                ${small.length ? `<a class="tnm-genre tnm-genre-more" href="${ROUTE}/genres" data-href="${ROUTE}/genres"><span>More genres</span><small>${esc(small.map((g) => g.name).join(', '))}</small></a>` : ''}
            </div></div>`;
        const input = $('.tnm-search', body);
        input.addEventListener('input', () => { clearTimeout(M.searchTimer); M.searchTimer = setTimeout(() => runSearch(body, idx, input.value), 200); });
        input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { input.value = ''; runSearch(body, idx, ''); } });
        if (M.searchQ) runSearch(body, idx, M.searchQ);
        // Desktop: ready to type. Touch screens: don't pop the keyboard over the tiles.
        if (!matchMedia('(pointer: coarse)').matches) setTimeout(() => input.focus({ preventScroll: true }), 0);
    };

    async function runSearch(body, idx, q) {
        M.searchQ = q;
        const out = $('.tnm-results', body), browse = $('.tnm-browse', body);
        const f = fold(q.trim());
        if (!f) { out.innerHTML = ''; browse.hidden = false; return; }
        browse.hidden = true;
        // Artists and albums from the index (instant); songs from the server.
        const artists = idx.artists.filter((x) => fold(x.name).includes(f)).slice(0, 18);
        const albums = idx.all.filter((a) => fold(a.name).includes(f) || fold(a.artist).includes(f))
            .sort((a, b) => (b.real - a.real) || a.sort.localeCompare(b.sort)).slice(0, 24);
        const draw = (songs) => {
            if (M.searchQ !== q) return;
            const parts = [];
            if (artists.length) parts.push(shelf('Artists', artists.map(artistCard).join('')));
            if (albums.length) parts.push(shelf('Albums', albums.map((a) => albumCard(a)).join('')));
            if (songs && songs.length) parts.push(`<section class="tnm-shelf"><h2 class="tnm-h2">Songs</h2>${songList('search', songs)}</section>`);
            if (!parts.length) parts.push(songs ? `<div class="tnm-empty">Nothing matches "${esc(q)}".</div>` : '');
            out.innerHTML = parts.join('');
        };
        draw(null);
        try {
            const r = await get(`Users/${uid()}/Items`, { IncludeItemTypes: 'Audio', Recursive: true, SearchTerm: q.trim(), Limit: 30 });
            draw(r.Items || []);
        } catch (e) { draw([]); }
    }

    VIEWS.genres = async (body, idx) => {
        // A dark card back to all the genres, matching the "More genres" card that led here.
        body.innerHTML = `<h1 class="tnm-h1">More genres</h1><div class="tnm-genres">
            <a class="tnm-genre tnm-genre-more" href="${ROUTE}/search" data-href="${ROUTE}/search"><span><span class="material-icons" aria-hidden="true">arrow_back</span>All genres</span></a>
            ${idx.smallGenres.map((g) => {
                const href = `${ROUTE}/genre?name=${encodeURIComponent(g.name)}`;
                return `<a class="tnm-genre" href="${href}" data-href="${href}" style="background:${g.color}"><span>${esc(g.name)}</span></a>`;
            }).join('')}</div>`;
    };

    // A genre: its albums, then songs in it that aren't on those albums (singles, one-offs).
    VIEWS.genre = async (body, idx, params, current) => {
        const name = params.get('name') || '';
        const g = idx.genres.find((x) => x.name === name);
        if (!g) { body.innerHTML = '<div class="tnm-empty">That genre isn\'t in the library anymore.</div>'; return; }
        const albums = g.albums.slice().sort((a, b) => a.artist.localeCompare(b.artist) || (a.year || 0) - (b.year || 0));
        const shown = new Set(albums.map((a) => a.id));
        const songs = await get(`Users/${uid()}/Items`, { IncludeItemTypes: 'Audio', Recursive: true, GenreIds: g.id, SortBy: 'AlbumArtist,Album,SortName', Limit: 1500 });
        if (!current()) return;
        const loose = (songs.Items || []).filter((s) => !shown.has(s.AlbumId)).slice(0, 200);
        body.innerHTML = `<div class="tnm-genre-head" style="background:${g.color}">${header({
            kicker: 'Genre', title: g.name, sub: esc([albums.length ? plural(albums.length, 'album') : '', loose.length ? plural(loose.length, 'more song') : ''].filter(Boolean).join(' · ')),
            buttons: button('shuffle-genre', 'Shuffle', 'shuffle', { primary: true, id: g.id }),
        })}</div>
            ${albums.length ? `<div class="tnm-grid">${albums.map((a) => albumCard(a)).join('')}</div>` : ''}
            ${loose.length ? `<h2 class="tnm-h2">More songs</h2>${songList('genre', loose)}` : ''}`;
    };

    VIEWS.catalog = async (body, idx) => {
        const day = today();
        const parts = [];
        const spot = spotlightPick(idx, day);
        if (spot) parts.push(spotlightHtml(spot));
        if (idx.playlists.length) parts.push(shelf('Playlists', idx.playlists.slice(0, ROW_CARDS).map(playlistCard).join(''), { more: idx.playlists.length > ROW_CARDS ? `${ROUTE}/shelf?key=playlists` : '' }));
        const row = (s) => {
            const albums = shuffle(s.albums, rng(s.key + day));
            return shelf(s.title, albums.slice(0, ROW_CARDS).map((a) => albumCard(a)).join(''), { more: s.albums.length > ROW_CARDS ? `${ROUTE}/shelf?key=${encodeURIComponent(s.key)}` : '' });
        };
        idx.decades.forEach((s) => parts.push(row(s)));
        shuffle(idx.mixed, rng('mixed' + day)).slice(0, DAILY_SHELVES).forEach((s) => parts.push(row(s)));
        // The Albums / Artists switch is the section's heading: an "A to Z" title said nothing
        // the letter bar under it doesn't already say.
        parts.push(`<section class="tnm-az" id="tnm-az"><div class="tnm-az-head" role="group" aria-label="All music by">
                <button type="button" data-act="az" data-mode="albums" class="${M.azMode === 'albums' ? 'on' : ''}" aria-pressed="${M.azMode === 'albums'}">Albums</button>
                <button type="button" data-act="az" data-mode="artists" class="${M.azMode === 'artists' ? 'on' : ''}" aria-pressed="${M.azMode === 'artists'}">Artists</button></div>
            <div class="tnm-az-body"></div></section>`);
        body.innerHTML = parts.join('');
        renderAz(idx);
        if (spot) spotlightBackdrop(spot, body);
    };

    function renderAz(idx) {
        const host = $('.tnm-az-body');
        if (!host) return;
        const albums = M.azMode === 'albums';
        const items = albums ? idx.real : idx.artists;
        const by = {};
        items.forEach((x) => { (by[letterOf(x.sort)] = by[letterOf(x.sort)] || []).push(x); });
        const letters = LETTERS.filter((l) => by[l]);
        host.innerHTML = `<div class="tnm-letters">${LETTERS.map((l) => (by[l]
            ? `<button type="button" data-act="jump" data-l="${l}">${l}</button>` : `<span>${l}</span>`)).join('')}</div>
            ${letters.map((l) => shelf(l, by[l].sort((a, b) => fold(a.sort).localeCompare(fold(b.sort)))
                .map((x) => (albums ? albumCard(x) : artistCard(x))).join(''), { id: 'tnm-l-' + (l === '#' ? 'num' : l) })).join('')}`;
    }

    // Spotlight: one album a day, picked the same way for everyone, shown over its artist's
    // backdrop picture when Jellyfin has one (otherwise a blurred copy of the cover).
    function spotlightPick(idx, day) {
        const pool = idx.real.filter((a) => a.tag);
        return pool.length ? pool[Math.floor(rng('spot' + day)() * pool.length)] : null;
    }
    function spotlightHtml(a) {
        const href = `${ROUTE}/album?id=${a.id}`;
        return `<section class="tnm-spot" data-href="${href}">
            <div class="tnm-spot-bg" style="background-image:url('${esc(imgUrl(a.id, a.tag, 400))}')"></div><div class="tnm-spot-shade"></div>
            ${art(a.id, a.tag, a.name, 'tnm-spot-art', 500)}
            <div class="tnm-spot-text"><div class="tnm-kicker">Spotlight</div><h2>${esc(a.name)}</h2>
                <div class="tnm-head-sub">${esc([a.artist, a.year].filter(Boolean).join(' · '))}</div>
                <div class="tnm-buttons">${button('play-album', 'Play', 'play_arrow', { primary: true, id: a.id })}${button('shuffle-album', 'Shuffle', 'shuffle', { id: a.id })}</div></div></section>`;
    }
    async function spotlightBackdrop(a, body) {
        if (!a.artistIds[0]) return;
        try {
            const artist = await get(`Users/${uid()}/Items/${a.artistIds[0]}`);
            const tag = (artist.BackdropImageTags || [])[0];
            const bg = $('.tnm-spot-bg', body);
            if (!tag || !bg) return;
            const u = ApiClient.getUrl(`Items/${artist.Id}/Images/Backdrop/0`, { tag, maxWidth: 1600, quality: 80 });
            const pre = new Image();
            pre.onload = () => { bg.style.backgroundImage = `url('${u.replace(/'/g, '%27')}')`; bg.classList.add('tnm-backdrop'); };
            pre.src = u;
        } catch (e) { /* the blurred cover stays */ }
    }

    VIEWS.shelf = async (body, idx, params) => {
        const s = shelfByKey(idx, params.get('key') || '');
        if (!s) { body.innerHTML = '<div class="tnm-empty">That shelf isn\'t here today.</div>'; return; }
        const cards = s.playlists ? s.playlists.map(playlistCard)
            : s.albums.slice().sort((a, b) => a.artist.localeCompare(b.artist) || (a.year || 0) - (b.year || 0)).map((a) => albumCard(a));
        body.innerHTML = `<h1 class="tnm-h1">${esc(s.title)}</h1><div class="tnm-grid">${cards.join('')}</div>`;
    };

    VIEWS.album = async (body, idx, params, current) => {
        const id = params.get('id');
        const [item, tracks] = await Promise.all([get(`Users/${uid()}/Items/${id}`), albumTracks(id)]);
        if (!current()) return;
        const songs = tracks.Items || [];
        const a = idx.byId.get(id) || { id, name: item.Name, artist: item.AlbumArtist || '', artistIds: (item.AlbumArtists || []).map((x) => x.Id), genres: [] };
        const year = item.ProductionYear >= 1000 ? item.ProductionYear : null;
        const total = songs.reduce((n, s) => n + (s.RunTimeTicks || 0), 0);
        const artistLink = a.artistIds[0] ? `<a href="${ROUTE}/artist?id=${a.artistIds[0]}" data-href="${ROUTE}/artist?id=${a.artistIds[0]}">${esc(a.artist)}</a>` : esc(a.artist);
        const discs = new Set(songs.map((s) => s.ParentIndexNumber || 1)).size > 1;
        const others = idx.real.filter((x) => x.id !== id && a.artistIds.length && x.artistIds.includes(a.artistIds[0]))
            .sort((x, y) => (y.year || 0) - (x.year || 0));
        M.lists.album = songs.map((s) => s.Id);
        body.innerHTML = header({
            art: art(id, item.ImageTags && item.ImageTags.Primary, item.Name, 'tnm-head-art', 500),
            kicker: a.real === false ? 'Single' : 'Album', title: item.Name,
            sub: [artistLink, esc([a.genres[0], year].filter(Boolean).join(' · '))].filter(Boolean).join('<br>')
                + `<div class="tnm-meta">${esc(plural(songs.length, 'song'))}, ${esc(time(total))}</div>`,
            buttons: button('play-album', 'Play', 'play_arrow', { primary: true, id }) + button('shuffle-album', 'Shuffle', 'shuffle', { id }),
        }) + (discs ? discList(songs, a) : songList('album', songs, { numbers: true, album: a }))
            + (others.length ? shelf(`More by ${a.artist}`, others.map((x) => albumCard(x, x.year || '')).join('')) : '');
    };

    // Albums with more than one disc get a small heading per disc; one list underneath so
    // "play from here" still runs to the end of the album.
    function discList(songs, a) {
        let html = songList('album', songs, { numbers: true, album: a });
        let disc = null, i = 0;
        html = html.replace(/<li class="tnm-song"/g, (m) => {
            const d = songs[i++].ParentIndexNumber || 1;
            if (d === disc) return m;
            disc = d;
            return `<li class="tnm-disc">Disc ${d}</li>${m}`;
        });
        return html;
    }

    VIEWS.playlist = async (body, idx, params, current) => {
        const id = params.get('id');
        const [item, tracks] = await Promise.all([get(`Users/${uid()}/Items/${id}`), playlistTracks(id)]);
        if (!current()) return;
        const songs = tracks.Items || [];
        const total = songs.reduce((n, s) => n + (s.RunTimeTicks || 0), 0);
        body.innerHTML = header({
            art: art(id, item.ImageTags && item.ImageTags.Primary, item.Name, 'tnm-head-art', 500),
            kicker: 'Playlist', title: item.Name, sub: `<div class="tnm-meta">${esc(plural(songs.length, 'song'))}, ${esc(time(total))}</div>`,
            buttons: button('play-playlist', 'Play', 'play_arrow', { primary: true, id }) + button('shuffle-playlist', 'Shuffle', 'shuffle', { id }),
        }) + songList('playlist', songs);
    };

    VIEWS.artist = async (body, idx, params, current) => {
        const id = params.get('id');
        const item = await get(`Users/${uid()}/Items/${id}`);
        if (!current()) return;
        const mine = idx.all.filter((a) => a.artistIds.includes(id)).sort((x, y) => (y.year || 0) - (x.year || 0));
        const albums = mine.filter((a) => a.real), singles = mine.filter((a) => !a.real);
        let songsHtml = '';
        if (!mine.length) {
            // Only on other people's albums (a featured artist, a compilation track).
            const r = await get(`Users/${uid()}/Items`, { IncludeItemTypes: 'Audio', Recursive: true, ArtistIds: id, SortBy: 'Album,SortName', Limit: 300 });
            if (!current()) return;
            songsHtml = `<h2 class="tnm-h2">Songs</h2>${songList('artist', r.Items || [])}`;
        }
        const bgTag = (item.BackdropImageTags || [])[0];
        const bg = bgTag ? ApiClient.getUrl(`Items/${id}/Images/Backdrop/0`, { tag: bgTag, maxWidth: 1600, quality: 80 }) : '';
        body.innerHTML = `<div class="tnm-artist-head${bg ? ' tnm-has-bg' : ''}"${bg ? ` style="background-image:url('${esc(bg.replace(/'/g, '%27'))}')"` : ''}>${header({
            art: art(id, item.ImageTags && item.ImageTags.Primary, item.Name, 'tnm-head-art tnm-round', 400),
            kicker: 'Artist', title: item.Name,
            sub: esc([albums.length ? plural(albums.length, 'album') : '', singles.length ? plural(singles.length, 'single') : ''].filter(Boolean).join(' · ')),
            buttons: button('shuffle-artist', 'Shuffle', 'shuffle', { primary: true, id }),
        })}</div>
            ${albums.length ? shelf('Albums', albums.map((a) => albumCard(a, a.year || '')).join('')) : ''}
            ${singles.length ? shelf('Singles and other songs', singles.map((a) => albumCard(a, a.year || '')).join('')) : ''}
            ${songsHtml}`;
    };

    // Now Playing: what Jellyfin's player in this browser is playing, or Tuner's radio.
    VIEWS.nowplaying = async (body) => {
        body.innerHTML = '<div class="tnm-np"></div>';
        await pollNp();
        M.npTimer = setInterval(() => { if (!document.hidden) pollNp(); }, NP_POLL_MS);
        M.tickTimer = setInterval(tickNp, 500);
    };

    async function pollNp() {
        let s = null;
        try {
            const list = await get('Sessions', { deviceId: ApiClient.deviceId() });
            s = (list || []).find((x) => x.UserId === uid()) || null;
            if (s) M.sid = s.Id;
        } catch (e) { /* drawn as idle */ }
        const host = $('.tnm-np');
        if (!host) return;
        const item = s && s.NowPlayingItem && s.NowPlayingItem.MediaType === 'Audio' ? s.NowPlayingItem : null;
        const prev = M.np;
        M.np = item ? { item, pos: s.PlayState.PositionTicks || 0, paused: !!s.PlayState.IsPaused, at: Date.now(), queue: (s.NowPlayingQueue || []).map((q) => q.Id) } : null;
        if (!item) { drawNpIdle(host); return; }
        if (prev && prev.item.Id === item.Id && host.dataset.id === item.Id) { tickNp(); updateNpButtons(); return; }
        host.dataset.id = item.Id;
        const artists = (item.Artists && item.Artists.length ? item.Artists.join(', ') : item.AlbumArtist) || '';
        const albumHref = item.AlbumId ? `${ROUTE}/album?id=${item.AlbumId}` : '';
        host.innerHTML = `<div class="tnm-np-main">
                ${art(item.AlbumId, item.AlbumPrimaryImageTag, item.Album || item.Name, 'tnm-np-art', 700)}
                <div class="tnm-np-info">
                    <div class="tnm-np-title">${esc(item.Name)}</div>
                    <div class="tnm-np-sub">${esc(artists)}${item.Album ? ` · ${albumHref ? `<a href="${albumHref}" data-href="${albumHref}">${esc(item.Album)}</a>` : esc(item.Album)}` : ''}</div>
                    <div class="tnm-np-bar" data-act="seek" role="slider" aria-label="Position" tabindex="0"><div class="tnm-np-fill"></div></div>
                    <div class="tnm-np-times"><span class="tnm-np-pos"></span><span class="tnm-np-left"></span></div>
                    <div class="tnm-np-controls">
                        <button type="button" data-act="np" data-cmd="PreviousTrack" aria-label="Previous"><span class="material-icons" aria-hidden="true">skip_previous</span></button>
                        <button type="button" class="tnm-np-play" data-act="np" data-cmd="PlayPause" aria-label="Pause"><span class="material-icons" aria-hidden="true">pause</span></button>
                        <button type="button" data-act="np" data-cmd="NextTrack" aria-label="Next"><span class="material-icons" aria-hidden="true">skip_next</span></button>
                    </div></div></div>
            <div class="tnm-np-next"></div>`;
        tickNp(); updateNpButtons();
        drawUpNext(item.Id);
    }

    async function drawUpNext(currentId) {
        const np = M.np;
        // The queue we sent wins: jellyfin-web only reports a short window of its queue
        // (3 songs, not always including the current one). The reported one is for music
        // started elsewhere, e.g. from Jellyfin's own pages.
        let ids = M.queueIds.includes(currentId) ? M.queueIds : np.queue;
        const at = ids.indexOf(currentId);
        ids = at >= 0 ? ids.slice(at + 1) : [];
        const host = $('.tnm-np-next');
        if (!host) return;
        if (!ids.length) { host.innerHTML = ''; return; }
        try {
            const r = await get(`Users/${uid()}/Items`, { Ids: ids.slice(0, 25).join(',') });
            if (!M.np || M.np.item.Id !== currentId) return;
            const byId = new Map((r.Items || []).map((s) => [s.Id, s]));
            const songs = ids.slice(0, 25).map((x) => byId.get(x)).filter(Boolean);
            // Clicking an upcoming song plays from it, keeping the rest of the queue after it.
            host.innerHTML = `<h2 class="tnm-h2">Up next</h2>${songList('upnext', songs)}`;
            // Only 25 are shown, but the whole rest of the queue should come along.
            if (songs.length === Math.min(25, ids.length)) M.lists.upnext = ids;
        } catch (e) { host.innerHTML = ''; }
    }

    function drawNpIdle(host) {
        delete host.dataset.id;
        const radio = window.Tuner && window.Tuner.radio ? window.Tuner.radio() : null;
        if (radio) {
            host.innerHTML = `<div class="tnm-np-main tnm-np-radio">
                <div class="tnm-art tnm-np-art tnm-noart" style="background:${esc(radio.color || '#455A64')}">${radio.logo ? `<img src="${esc(radio.logo)}" alt="">` : '<span class="material-icons" aria-hidden="true">radio</span>'}</div>
                <div class="tnm-np-info"><div class="tnm-kicker">Radio</div><div class="tnm-np-title">${esc(radio.name)}</div>
                    <div class="tnm-np-sub">${esc(radio.paused ? 'Paused' : (radio.title || radio.genre || ''))}</div>
                    <div class="tnm-buttons">${button('radio-toggle', radio.paused ? 'Play' : 'Pause', radio.paused ? 'play_arrow' : 'pause', { primary: true })}
                        <a class="tnm-btn" href="#/tuner/radio" data-href="#/tuner/radio"><span class="material-icons" aria-hidden="true">tune</span>Open Radio</a></div></div></div>`;
            return;
        }
        host.innerHTML = `<div class="tnm-np-idle"><span class="material-icons" aria-hidden="true">music_note</span>
            <h2>Nothing playing</h2><p>Pick something in Search or Catalog, or let the library choose.</p>
            <div class="tnm-buttons">${button('shuffle-all', 'Shuffle all music', 'shuffle', { primary: true })}
                <a class="tnm-btn" href="${ROUTE}/catalog" data-href="${ROUTE}/catalog"><span class="material-icons" aria-hidden="true">library_music</span>Catalog</a></div></div>`;
    }

    // Between polls the bar moves on its own, so it doesn't jump once every two seconds.
    function tickNp() {
        const np = M.np;
        if (!np) return;
        const len = np.item.RunTimeTicks || 0;
        const pos = Math.min(len || Infinity, np.pos + (np.paused ? 0 : (Date.now() - np.at) * 1e4));
        const fill = $('.tnm-np-fill'), p = $('.tnm-np-pos'), l = $('.tnm-np-left');
        if (fill) fill.style.width = len ? `${(pos / len) * 100}%` : '0';
        if (p) p.textContent = time(pos);
        if (l) l.textContent = len ? '-' + time(len - pos) : '';
    }
    function updateNpButtons() {
        const b = $('.tnm-np-play');
        if (!b || !M.np) return;
        b.setAttribute('aria-label', M.np.paused ? 'Play' : 'Pause');
        $('.material-icons', b).textContent = M.np.paused ? 'play_arrow' : 'pause';
    }
    function stopNp() { clearInterval(M.npTimer); clearInterval(M.tickTimer); M.npTimer = M.tickTimer = null; }

    // ---------- clicks ----------

    function bind(root) {
        if (root.dataset.tnmBound) return;
        root.dataset.tnmBound = '1';
        root.addEventListener('click', onClick);
        root.addEventListener('keydown', (e) => {
            if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.tnm-song')) { e.preventDefault(); onClick(e); }
            if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && e.target.matches('.tnm-np-bar') && M.np) {
                e.preventDefault();
                seekTo(Math.max(0, M.np.pos + (e.key === 'ArrowRight' ? 1 : -1) * 10 * 1e7));
            }
        });
    }

    async function onClick(e) {
        if (e.button > 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;   // new tab etc. still works on links
        const act = e.target.closest('[data-act]');
        const link = e.target.closest('[data-href]');
        if (act && (!link || link.contains(act))) {
            e.preventDefault(); e.stopPropagation();
            runAct(act, e).catch(() => toast('Something went wrong'));
            return;
        }
        if (!link) return;
        e.preventDefault();
        const href = link.dataset.href;
        if (href.startsWith('#/tuner/radio')) { if (window.Tuner) window.Tuner.go('radio'); return; }
        nav(href);
    }

    async function runAct(el, e) {
        const d = el.dataset;
        switch (d.act) {
            case 'play-album': return playAlbum(d.id, false);
            case 'shuffle-album': return playAlbum(d.id, true);
            case 'play-playlist': return playPlaylist(d.id, false);
            case 'shuffle-playlist': return playPlaylist(d.id, true);
            case 'play-song': return playIds(M.lists[d.list] || [], Number(d.i));
            case 'shuffle-genre': return playIds(songsOf(await randomSongs({ GenreIds: d.id })), 0);
            case 'shuffle-artist': return playIds(songsOf(await randomSongs({ ArtistIds: d.id })), 0);
            case 'shuffle-all': return playIds(songsOf(await randomSongs()), 0);
            case 'radio-toggle': if (window.Tuner) window.Tuner.toggleRadio(); return setTimeout(pollNp, 300);
            case 'np':
                if (d.cmd === 'PlayPause' && M.np) { M.np.pos += M.np.paused ? 0 : (Date.now() - M.np.at) * 1e4; M.np.at = Date.now(); M.np.paused = !M.np.paused; updateNpButtons(); }
                await command('Playing/' + d.cmd);
                return setTimeout(pollNp, 600);
            case 'seek': {
                if (!M.np || !M.np.item.RunTimeTicks) return;
                const r = el.getBoundingClientRect();
                return seekTo(Math.round(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * M.np.item.RunTimeTicks));
            }
            case 'row': {
                const row = $('.tnm-row', el.closest('.tnm-shelf'));
                return row && row.scrollBy({ left: Number(d.d) * row.clientWidth * 0.9, behavior: 'smooth' });
            }
            case 'az':
                M.azMode = d.mode; store('az', d.mode);
                el.parentNode.querySelectorAll('button').forEach((b) => { b.classList.toggle('on', b === el); b.setAttribute('aria-pressed', b === el); });
                return renderAz(M.index);
            case 'jump': {
                const t = document.getElementById('tnm-l-' + (d.l === '#' ? 'num' : d.l));
                return t && t.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
            case 'classic': return openClassic();
        }
    }

    async function seekTo(ticks) {
        if (M.np) { M.np.pos = ticks; M.np.at = Date.now(); tickNp(); }
        await command('Playing/Seek', { seekPositionTicks: ticks });
    }

    M.azMode = load('az', 'albums') === 'artists' ? 'artists' : 'albums';

    window.TunerMusic = { route: ROUTE, show, leave, tabsHtml, bind, classicOn, classicOff, pauseJellyfin };
})();
