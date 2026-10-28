/*
 * Tuner: radio dial and TV surf mode pages for jellyfin-web.
 *
 * Injected into index.html by the plugin's middleware. It adds a "Radio" link to the
 * sidebar and renders its own page into Jellyfin's page container, the same way
 * Jellyfin's own views swap in and out. All playback uses one <audio> element owned
 * by this script, so radio keeps going while the user browses elsewhere.
 *
 * Talks only to the plugin's /Tuner/* endpoints. Those relay station streams (most
 * stations are plain http, which an https page can't play) and read in-stream song
 * titles, which a browser can't do itself.
 */
(function () {
    'use strict';
    if (window.__tunerLoaded) return;
    window.__tunerLoaded = true;

    const ROUTE = '#/tuner/radio';
    const PAGE_ID = 'tnr-radio-page';
    const NOWPLAYING_MS = 20000;
    const FAV_COLOR = '#B8860B';

    const S = {
        loaded: false,
        ticket: '',
        genres: [],          // [{name, color, stations:[{number,name,hasLogo}]}]
        jamGenres: [],       // [{name, color}]
        mode: 'live',        // 'live' | 'jamendo'
        gi: 0, si: 0,        // selected genre / station in the current mode
        playing: null,       // {kind:'live', station, genre} | {kind:'jam', track, genre}
        nowTitle: '',
        jamQueue: [], jamFetching: false,
        search: '',
        active: null,        // which of our pages is showing: 'radio' | 'tv' | null
        revealActive: false, // scroll the playing station into view on the next list render
        pageVisible: false, prevPage: null, locSig: '', locTimer: null,
        nowTimer: null, retried: false,
    };

    // ---------- small helpers ----------

    const $ = (sel, root) => (root || document).querySelector(sel);
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    // An image address as CSS inside a style attribute. esc() alone isn't enough there:
    // the browser decodes &#39; back to ' before reading the CSS, so a quote or bracket in
    // the address (Jamendo's come from a third party) could end url('...') early. Those
    // characters are percent-encoded instead, which URLs allow.
    const bgImage = (u) => `background-image:url('${esc(String(u).replace(/['"()\\\s]/g, (c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')))}')`;
    const userKey = (k) => `tuner.${k}.${(window.ApiClient && ApiClient.getCurrentUserId && ApiClient.getCurrentUserId()) || 'anon'}`;
    function store(k, v) { try { localStorage.setItem(userKey(k), JSON.stringify(v)); } catch (e) { /* private mode */ } }
    function load(k, d) { try { const v = localStorage.getItem(userKey(k)); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }

    function api(path, opts) {
        return ApiClient.ajax(Object.assign({ type: 'GET', url: ApiClient.getUrl(path), dataType: 'json' }, opts || {}));
    }
    // Absolute URL for an <audio>/<img> src: no auth header possible, so a ticket rides along.
    const mediaUrl = (path) => ApiClient.getUrl(path) + '?t=' + encodeURIComponent(S.ticket);
    const logoUrl = (st) => (st && st.hasLogo ? mediaUrl(`Tuner/radio/${st.number}/logo`) : '');
    const initials = (n) => String(n).replace(/[^A-Za-z0-9 ]/g, '').split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

    let toastTimer;
    function toast(msg) {
        let t = $('.tnr-toast');
        if (!t) { t = document.createElement('div'); t.className = 'tnr-toast'; document.body.appendChild(t); }
        t.textContent = msg; t.classList.add('show');
        clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
    }

    // A short burst of filtered noise between stations, so tuning feels like a dial.
    let actx = null;
    function staticBlip() {
        if (!load('static', true)) return;
        try {
            actx = actx || new (window.AudioContext || window.webkitAudioContext)();
            const n = Math.floor(actx.sampleRate * 0.14), buf = actx.createBuffer(1, n, actx.sampleRate), d = buf.getChannelData(0);
            for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n) * 0.12;
            const src = actx.createBufferSource(); src.buffer = buf;
            const f = actx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 2200;
            src.connect(f).connect(actx.destination); src.start();
        } catch (e) { /* audio context blocked: tuning still works, just silently */ }
    }

    // ---------- data ----------

    function favorites() { return load('favs', []); }
    function isFav(number) { return favorites().includes(number); }

    // The dial shows a "Favorites" genre first once anything is starred.
    function liveGenres() {
        const favs = favorites();
        if (!favs.length) return S.genres;
        const all = new Map();
        S.genres.forEach((g) => g.stations.forEach((s) => all.set(s.number, Object.assign({ genre: g.name, color: g.color }, s))));
        const stations = favs.map((n) => all.get(n)).filter(Boolean);
        return stations.length ? [{ name: 'Favorites', color: FAV_COLOR, stations }].concat(S.genres) : S.genres;
    }
    function genresForMode() { return S.mode === 'live' ? liveGenres() : S.jamGenres; }
    function colorOfStation(st, g) { return st.color || (g && g.color) || '#455A64'; }

    async function loadCatalog() {
        const data = await api('Tuner/radio');
        S.ticket = data.ticket;
        S.genres = data.genres || [];
        S.jamGenres = data.jamendo || [];
        S.loaded = true;
        const last = load('last', null);
        if (last && last.mode === 'live') {
            const gs = liveGenres(); const gi = gs.findIndex((g) => g.name === last.genre);
            if (gi >= 0) { S.gi = gi; S.si = Math.max(0, gs[gi].stations.findIndex((s) => s.number === last.number)); }
        }
    }

    // ---------- playback ----------

    function audio() {
        let a = $('#tnr-audio');
        if (!a) {
            a = document.createElement('audio');
            a.id = 'tnr-audio'; a.preload = 'none';
            a.addEventListener('ended', () => { if (S.playing && S.playing.kind === 'jam') nextJam(); });
            a.addEventListener('error', onAudioError);
            a.addEventListener('playing', () => { S.retried = false; renderAll(); });
            a.addEventListener('pause', renderAll);
            document.body.appendChild(a);
        }
        return a;
    }

    async function onAudioError() {
        const p = S.playing;
        if (!p) return;
        if (p.kind === 'live' && !S.retried) {
            // Most likely a stale ticket (Jellyfin restarted). Refresh it once and retry.
            S.retried = true;
            try { await loadCatalog(); playLive(p.station, p.genre, true); return; } catch (e) { /* fall through */ }
        }
        if (p.kind === 'jam') { nextJam(); return; }
        toast(`${p.station.name} isn't answering right now`);
        renderAll();
    }

    function playLive(st, g, quiet) {
        if (!quiet) staticBlip();
        S.playing = { kind: 'live', station: st, genre: g };
        S.nowTitle = '';
        const a = audio();
        a.src = mediaUrl(`Tuner/radio/${st.number}/stream`);
        a.play().catch(() => { /* autoplay refusal: the play button still works */ });
        store('last', { mode: 'live', genre: g.name, number: st.number });
        pollNowPlaying(true);
        renderAll();
    }

    async function startJam(g) {
        staticBlip();
        S.jamQueue = [];
        S.playing = { kind: 'jam', track: null, genre: g };
        renderAll();
        await refillJam(g);
        nextJam(true);
    }

    async function refillJam(g) {
        if (S.jamFetching) return;
        S.jamFetching = true;
        try {
            const batch = await api(`Tuner/jamendo/${encodeURIComponent(g.name)}/tracks?count=20`);
            const seen = new Set(S.jamQueue.map((t) => t.id));
            (batch || []).forEach((t) => { if (!seen.has(t.id)) S.jamQueue.push(t); });
        } catch (e) { toast('Jamendo is not responding'); }
        S.jamFetching = false;
    }

    function nextJam(quiet) {
        const p = S.playing;
        if (!p || p.kind !== 'jam') return;
        const t = S.jamQueue.shift();
        if (!t) { toast(`No ${p.genre.name} tracks right now`); return; }
        if (!quiet) staticBlip();
        p.track = t;
        S.nowTitle = `${t.artist} - ${t.name}`;
        const a = audio(); a.src = t.audio; a.play().catch(() => {});
        if (S.jamQueue.length < 4) refillJam(p.genre).then(renderAll);
        updateMediaSession(); renderAll();
    }

    function togglePlay() {
        const a = audio();
        if (!S.playing) { tuneTo(S.gi, S.si); return; }
        if (a.paused) {
            // Live radio resumed after a pause should be live again, not minutes behind.
            if (S.playing.kind === 'live') playLive(S.playing.station, S.playing.genre, true);
            else a.play().catch(() => {});
        } else a.pause();
        renderAll();
    }

    function stop() { const a = audio(); a.pause(); a.removeAttribute('src'); a.load(); S.playing = null; S.nowTitle = ''; renderAll(); }

    async function pollNowPlaying(immediate) {
        clearTimeout(S.nowTimer);
        const p = S.playing;
        if (!p || p.kind !== 'live') return;
        if (!immediate) {
            try {
                const r = await api(`Tuner/radio/${p.station.number}/nowplaying`);
                if (S.playing === p && r.title !== S.nowTitle) { S.nowTitle = r.title || ''; renderAll(); }
            } catch (e) { /* keep last title */ }
        }
        S.nowTimer = setTimeout(() => pollNowPlaying(false), immediate ? 1500 : NOWPLAYING_MS);
    }

    // Lock screen / Android notification / media keys.
    function updateMediaSession() {
        if (!('mediaSession' in navigator)) return;
        const p = S.playing;
        if (!p) { navigator.mediaSession.metadata = null; return; }
        const art = p.kind === 'live' ? logoUrl(p.station) : (p.track && p.track.image);
        navigator.mediaSession.metadata = new MediaMetadata({
            title: S.nowTitle || (p.kind === 'live' ? p.station.name : (p.track ? p.track.name : p.genre.name)),
            artist: p.kind === 'live' ? p.station.name : (p.track ? p.track.artist : 'Jamendo'),
            album: p.kind === 'live' ? p.genre.name : `Jamendo · ${p.genre.name}`,
            artwork: art ? [{ src: art, sizes: '400x400' }] : [],
        });
        try {
            navigator.mediaSession.setActionHandler('nexttrack', () => (S.playing && S.playing.kind === 'jam' ? nextJam() : step(1)));
            navigator.mediaSession.setActionHandler('previoustrack', () => step(-1));
            navigator.mediaSession.setActionHandler('play', togglePlay);
            navigator.mediaSession.setActionHandler('pause', togglePlay);
        } catch (e) { /* older browsers lack some actions */ }
    }

    // ---------- tuning ----------

    function tuneTo(gi, si) {
        const gs = genresForMode();
        if (!gs.length) return;
        S.revealActive = true;
        S.gi = (gi + gs.length) % gs.length;
        const g = gs[S.gi];
        if (S.mode === 'live') {
            S.si = Math.max(0, Math.min(si, g.stations.length - 1));
            playLive(g.stations[S.si], g);
        } else {
            S.si = 0;
            startJam(g);
        }
    }

    // Up/down: next station, rolling into the next genre at either end, like a dial.
    function step(d) {
        if (S.mode === 'jamendo') { if (d > 0 && S.playing && S.playing.kind === 'jam') nextJam(); return; }
        const gs = genresForMode(); if (!gs.length) return;
        let gi = S.gi, si = S.si + d;
        if (si < 0) { gi = (gi - 1 + gs.length) % gs.length; si = gs[gi].stations.length - 1; }
        else if (si >= gs[gi].stations.length) { gi = (gi + 1) % gs.length; si = 0; }
        tuneTo(gi, si);
    }
    function stepGenre(d) { tuneTo(S.gi + d, 0); }

    function setMode(m) {
        if (S.mode === m) return;
        S.mode = m; S.gi = 0; S.si = 0;
        renderPage();
    }

    function toggleFav() {
        const p = S.playing; if (!p || p.kind !== 'live') return;
        const favs = favorites(), n = p.station.number;
        const next = favs.includes(n) ? favs.filter((x) => x !== n) : favs.concat([n]);
        store('favs', next);
        // Keep the selection on the same station even though "Favorites" shifts the list.
        const gs = liveGenres(); const gi = gs.findIndex((g) => g.name === p.genre.name);
        if (gi >= 0) { S.gi = gi; S.si = Math.max(0, gs[gi].stations.findIndex((s) => s.number === n)); }
        toast(next.includes(n) ? 'Added to favorites' : 'Removed from favorites');
        renderPage();
    }

    async function keepTrack() {
        const p = S.playing; if (!p || p.kind !== 'jam' || !p.track) return;
        try {
            const r = await api(`Tuner/jamendo/keep/${p.track.id}`, { type: 'POST' });
            toast((r && r.message) || 'Saved');
        } catch (e) {
            let msg = "Couldn't save that track";
            try { msg = JSON.parse(e.responseText || '{}').message || msg; } catch (x) { /* keep default */ }
            toast(msg);
        }
    }

    // ---------- rendering ----------

    function tileHtml(st, g, extraClass) {
        const color = colorOfStation(st, g), url = logoUrl(st);
        return url
            ? `<div class="tnr-tile ${extraClass || ''}" style="background-color:${esc(color)};${bgImage(url)}"></div>`
            : `<div class="tnr-tile ${extraClass || ''}" style="background-color:${esc(color)}">${esc(initials(st.name))}</div>`;
    }

    function renderPage() {
        const page = $('#' + PAGE_ID);
        if (!page || !S.loaded) return;
        const root = $('.tnr-wrap', page);
        const hasJam = S.jamGenres.length > 0;
        root.innerHTML = `
            <div class="tnr-head">
                <h1>Radio</h1>
                <input class="tnr-search" type="search" placeholder="Search stations" value="${esc(S.search)}" aria-label="Search stations">
                <button class="tnr-btn tnr-static" title="Tuning sound">${load('static', true) ? 'Static on' : 'Static off'}</button>
            </div>
            ${hasJam ? `<div class="tnr-modes">
                <button class="tnr-mode ${S.mode === 'live' ? 'on' : ''}" data-mode="live">Live radio</button>
                <button class="tnr-mode ${S.mode === 'jamendo' ? 'on' : ''}" data-mode="jamendo">Jamendo</button>
            </div>` : ''}
            <div class="tnr-scale"><div class="tnr-needle"></div></div>
            <div class="tnr-genres"></div>
            <div class="tnr-main">
                <div class="tnr-list"></div>
                <div class="tnr-card"></div>
            </div>`;
        $('.tnr-search', root).addEventListener('input', (e) => { S.search = e.target.value; renderList(); });
        $('.tnr-search', root).addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { const first = $('.tnr-row', root); if (first) first.click(); }
            if (e.key === 'Escape') { e.target.value = ''; S.search = ''; renderList(); e.target.blur(); }
        });
        $('.tnr-static', root).addEventListener('click', (e) => { const v = !load('static', true); store('static', v); e.currentTarget.textContent = v ? 'Static on' : 'Static off'; });
        root.querySelectorAll('.tnr-mode').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
        $('.tnr-scale', root).addEventListener('click', (e) => {
            // Clicking the scale tunes to the genre under the pointer.
            const r = e.currentTarget.getBoundingClientRect(), gs = genresForMode();
            tuneTo(Math.floor(((e.clientX - r.left) / r.width) * gs.length), 0);
        });
        [$('.tnr-scale', root), $('.tnr-genres', root)].forEach((el) => {
            let x0 = null;
            el.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
            el.addEventListener('touchend', (e) => {
                if (x0 == null) return;
                const dx = e.changedTouches[0].clientX - x0; x0 = null;
                if (Math.abs(dx) > 40) stepGenre(dx < 0 ? 1 : -1);
            });
        });
        renderScale(); renderAll();
    }

    function renderScale() {
        const scale = $('.tnr-scale'); if (!scale) return;
        const gs = genresForMode();
        scale.querySelectorAll('.tnr-tick, .tnr-ticklabel').forEach((n) => n.remove());
        const html = [];
        // Thin out the numbers when the dial is narrow (phones) so they don't run together.
        const every = Math.max(1, Math.ceil((gs.length * 40) / Math.max(1, scale.clientWidth)));
        gs.forEach((g, i) => {
            const x = ((i + 0.5) / gs.length) * 100;
            html.push(`<div class="tnr-tick" style="left:${x}%"></div>`);
            // Live genres label with their channel block (1000, 1100...). Jamendo has no
            // numbers, so it gets short names that stay unique (Metalcore vs Metal).
            const label = S.mode === 'live'
                ? (g.name === 'Favorites' ? 'Fav' : (g.stations[0] ? Math.floor(g.stations[0].number / 100) * 100 : ''))
                : shortName(g.name);
            if (i % every === 0) html.push(`<div class="tnr-ticklabel" style="left:${x}%">${esc(label)}</div>`);
            for (let k = 1; k < 5; k++) html.push(`<div class="tnr-tick minor" style="left:${x + (k / 5) * (100 / gs.length)}%"></div>`);
        });
        scale.insertAdjacentHTML('afterbegin', html.join(''));
    }

    const SHORT = { 'Metalcore': 'Core', 'Hard Rock': 'Hard', 'Alternative': 'Alt', 'Punk & Emo': 'Punk', 'Hip-Hop': 'Hip-Hop',
        'Electronic': 'Electro', 'Chill & Lo-Fi': 'Chill', 'Pop & Hits': 'Pop', 'Country & Blues': 'Country',
        'Jazz & Soul': 'Jazz', 'Classical & Soundtrack': 'Classical', 'Reggae & Latin': 'Reggae' };
    const shortName = (n) => SHORT[n] || n.split(' ')[0];

    function renderAll() {
        renderNeedle(); renderGenres(); renderList(); renderCard(); renderMini(); updateMediaSession();
    }

    function renderNeedle() {
        const n = $('.tnr-needle'); if (!n) return;
        const gs = genresForMode(); if (!gs.length) return;
        const count = S.mode === 'live' ? Math.max(1, gs[S.gi].stations.length) : 1;
        const pos = ((S.gi + (S.mode === 'live' ? (S.si + 0.5) / count : 0.5)) / gs.length) * 100;
        n.style.left = `calc(${pos}% - 1px)`;
    }

    function renderGenres() {
        const row = $('.tnr-genres'); if (!row) return;
        const gs = genresForMode(); if (!gs.length) { row.innerHTML = ''; return; }
        // Show the selected genre with two neighbors each side, wrapping like a dial.
        const span = Math.min(2, Math.floor((gs.length - 1) / 2));
        const html = [];
        for (let o = -span; o <= span; o++) {
            const j = (S.gi + o + gs.length) % gs.length, g = gs[j];
            html.push(`<button class="tnr-genre ${o === 0 ? 'on' : ''}" data-gi="${j}" style="background:${esc(g.color)}">${esc(g.name)}</button>`);
        }
        row.innerHTML = html.join('');
        row.querySelectorAll('.tnr-genre').forEach((b) => b.addEventListener('click', () => tuneTo(+b.dataset.gi, 0)));
    }

    function renderList() {
        const list = $('.tnr-list'); if (!list) return;
        const gs = genresForMode(); if (!gs.length) { list.innerHTML = '<div class="tnr-empty">No stations yet.</div>'; return; }
        const p = S.playing, a = audio();
        const live = (n) => p && p.kind === 'live' && p.station.number === n && !a.paused;

        if (S.mode === 'live' && S.search.trim()) {
            // Search across every live station regardless of the selected genre.
            const q = S.search.trim().toLowerCase(), hits = [];
            S.genres.forEach((g, gi) => g.stations.forEach((st, si) => { if (st.name.toLowerCase().includes(q) || g.name.toLowerCase().includes(q)) hits.push({ st, g, gi, si }); }));
            list.innerHTML = hits.length ? hits.slice(0, 60).map((h) => `
                <div class="tnr-row" data-name="${esc(h.g.name)}" data-number="${h.st.number}">
                    ${tileHtml(h.st, h.g)}
                    <div class="tnr-row-text"><div class="tnr-row-name">${esc(h.st.name)}</div><div class="tnr-row-sub">${h.st.number} · ${esc(h.g.name)}</div></div>
                    ${live(h.st.number) ? '<span class="material-icons tnr-live">volume_up</span>' : ''}
                </div>`).join('') : '<div class="tnr-empty">No stations match.</div>';
            list.querySelectorAll('.tnr-row').forEach((r) => r.addEventListener('click', () => {
                const lg = liveGenres(), gi = lg.findIndex((g) => g.name === r.dataset.name);
                const si = lg[gi].stations.findIndex((s) => s.number === +r.dataset.number);
                tuneTo(gi, si);
            }));
            return;
        }

        if (S.mode === 'jamendo') {
            const g = gs[S.gi];
            const cur = p && p.kind === 'jam' && p.genre.name === g.name ? p.track : null;
            const upcoming = cur ? S.jamQueue.slice(0, 8) : [];
            list.innerHTML = cur || upcoming.length
                ? `<div class="tnr-row-sub" style="padding:.2em .6em .5em">Up next on Jamendo ${esc(g.name)}</div>` + upcoming.map((t) => `
                    <div class="tnr-row">
                        <div class="tnr-tile" style="background-color:${esc(g.color)};${bgImage(t.image)}"></div>
                        <div class="tnr-row-text"><div class="tnr-row-name">${esc(t.name)}</div><div class="tnr-row-sub">${esc(t.artist)}</div></div>
                    </div>`).join('')
                : `<div class="tnr-empty">Press play to start Jamendo ${esc(g.name)}: Creative Commons music, one track after another, with skip.</div>`;
            return;
        }

        const g = gs[S.gi];
        list.innerHTML = g.stations.map((st, si) => `
            <div class="tnr-row ${si === S.si ? 'on' : ''}" data-si="${si}">
                ${tileHtml(st, g)}
                <div class="tnr-row-text"><div class="tnr-row-name">${esc(st.name)}</div><div class="tnr-row-sub">${st.number}${st.genre ? ' · ' + esc(st.genre) : ''}</div></div>
                ${isFav(st.number) ? '<span class="material-icons tnr-star">star</span>' : ''}
                ${live(st.number) ? '<span class="material-icons tnr-live">volume_up</span>' : ''}
            </div>`).join('');
        list.querySelectorAll('.tnr-row').forEach((r) => r.addEventListener('click', () => tuneTo(S.gi, +r.dataset.si)));
        // Only after a tune, so a song-title refresh never yanks someone who scrolled away.
        const on = S.revealActive && $('.tnr-row.on', list);
        S.revealActive = false;
        if (on) {
            const r = on.getBoundingClientRect();
            if (r.top < 0 || r.bottom > window.innerHeight) on.scrollIntoView({ block: 'nearest' });
        }
    }

    function renderCard() {
        const card = $('.tnr-card'); if (!card) return;
        const gs = genresForMode(); if (!gs.length) { card.innerHTML = ''; return; }
        const p = S.playing, a = audio(), paused = !p || a.paused;
        const btn = (cls, icon, label, disabled) => `<button class="tnr-btn ${cls}" aria-label="${label}" title="${label}" ${disabled ? 'disabled' : ''}><span class="material-icons">${icon}</span></button>`;
        let tile, name, sub, controls;

        if (S.mode === 'jamendo') {
            const g = gs[S.gi];
            const t = p && p.kind === 'jam' && p.genre.name === g.name ? p.track : null;
            tile = t && t.image
                ? `<div class="tnr-tile" style="background-color:${esc(g.color)};${bgImage(t.image)}"></div>`
                : `<div class="tnr-tile" style="background-color:${esc(g.color)};padding:1em;box-sizing:border-box;line-height:1.3">Jamendo<br>${esc(g.name)}</div>`;
            name = t ? t.name : `Jamendo ${g.name}`;
            sub = t ? `${t.artist}${t.album ? ' · ' + t.album : ''}` : 'Creative Commons music';
            controls = btn('tnr-play', paused ? 'play_arrow' : 'pause', paused ? 'Play' : 'Pause')
                + btn('tnr-skip', 'skip_next', 'Skip', !t)
                + btn('tnr-keep', 'library_add', t && !t.downloadable ? "This artist doesn't allow downloads" : 'Keep in my library', !t || !t.downloadable)
                + btn('tnr-stop', 'stop', 'Stop', !p);
        } else {
            const g = gs[S.gi], st = g.stations[S.si] || g.stations[0];
            const shown = p && p.kind === 'live' ? p.station : st;
            const sg = p && p.kind === 'live' ? p.genre : g;
            tile = tileHtml(shown, sg);
            name = shown.name;
            sub = `${shown.number} · ${shown.genre || sg.name}`;
            controls = btn('tnr-prev', 'skip_previous', 'Previous station')
                + btn('tnr-play', paused ? 'play_arrow' : 'pause', paused ? 'Play' : 'Pause')
                + btn('tnr-next', 'skip_next', 'Next station')
                + btn('tnr-fav', isFav(shown.number) ? 'star' : 'star_border', isFav(shown.number) ? 'Remove from favorites' : 'Add to favorites', !(p && p.kind === 'live'))
                + btn('tnr-stop', 'stop', 'Stop', !p);
        }

        // Live radio: the box shows the song from the stream. Jamendo already shows the
        // song in the card itself, so the box previews what's next instead.
        let npLabel = 'Now playing', title;
        if (S.mode === 'jamendo' && p && p.kind === 'jam' && p.track) {
            const nx = S.jamQueue[0];
            npLabel = 'Up next';
            title = nx ? `${nx.artist} - ${nx.name}` : 'Finding more tracks…';
        } else {
            title = !p ? 'Not playing' : (a.paused ? 'Paused' : (S.nowTitle || (p.kind === 'live' ? "This station doesn't share song titles" : 'Loading…')));
        }
        card.innerHTML = `${tile}
            <p class="tnr-card-name">${esc(name)}</p>
            <p class="tnr-card-sub">${esc(sub)}</p>
            <div class="tnr-np"><p class="tnr-np-label">${npLabel}</p><p class="tnr-np-title">${esc(title)}</p></div>
            <div class="tnr-controls">${controls}</div>
            <div class="tnr-hint">${S.mode === 'jamendo'
                ? 'Left/right changes genre. N skips, K keeps, Space plays or pauses.'
                : 'Arrow keys tune: up/down station, left/right genre. Space plays or pauses.'}</div>`;
        const on = (sel, fn) => { const b = $(sel, card); if (b) b.addEventListener('click', fn); };
        on('.tnr-prev', () => step(-1)); on('.tnr-next', () => step(1)); on('.tnr-play', togglePlay);
        on('.tnr-fav', toggleFav); on('.tnr-stop', stop); on('.tnr-skip', () => nextJam()); on('.tnr-keep', keepTrack);
    }

    function renderMini() {
        let m = $('.tnr-mini');
        if (!m) {
            m = document.createElement('div'); m.className = 'tnr-mini';
            document.body.appendChild(m);
        }
        const p = S.playing;
        if (!p || S.pageVisible) { m.classList.remove('show'); return; }
        const a = audio();
        const name = p.kind === 'live' ? p.station.name : `Jamendo ${p.genre.name}`;
        const title = a.paused ? 'Paused' : (S.nowTitle || p.genre.name);
        const tile = p.kind === 'live' ? tileHtml(p.station, p.genre)
            : `<div class="tnr-tile" style="background-color:${esc(p.genre.color)};${p.track ? bgImage(p.track.image) : ''}"></div>`;
        m.innerHTML = `${tile}<div class="tnr-mini-text"><div class="tnr-mini-name">${esc(name)}</div><div class="tnr-mini-title">${esc(title)}</div></div>
            <button class="tnr-btn tnr-mplay" aria-label="${a.paused ? 'Play' : 'Pause'}"><span class="material-icons">${a.paused ? 'play_arrow' : 'pause'}</span></button>
            <button class="tnr-btn tnr-mstop" aria-label="Stop"><span class="material-icons">close</span></button>`;
        m.classList.add('show');
        m.querySelectorAll('.tnr-tile, .tnr-mini-text').forEach((el) => el.addEventListener('click', () => { location.hash = ROUTE; }));
        $('.tnr-mplay', m).addEventListener('click', togglePlay);
        $('.tnr-mstop', m).addEventListener('click', stop);
    }

    // =====================================================================
    // TV surf mode
    // =====================================================================
    //
    // Plays the free channels straight from their source HLS in the browser (hls.js,
    // or the browser's own HLS on Safari/iOS) instead of through Jellyfin's Live TV,
    // which took 46 s to open a channel. Channels whose CDN refuses cross-origin
    // requests fall back to the plugin's signed relay. Now/next comes from Dispatcharr's
    // guide via the plugin. Antenna channels (HDHomeRun) are broadcast MPEG-2, which no
    // browser plays, so the plugin converts the one being watched to HLS on the server
    // (see AntennaService); they take a few seconds longer to tune.

    const TV_ROUTE = '#/tuner/tv';
    const TV_PAGE_ID = 'tnr-tv-page';
    const TUNE_DELAY_MS = 450;     // surfing past channels only loads the one you stop on
    const BANNER_MS = 5000;
    const GROUP_COLORS = { 'Antenna': '#BA7517', 'News & Business': '#378ADD', 'Sports': '#639922', 'Movies': '#D85A30', 'Shows': '#7F77DD', 'Docs & Lifestyle': '#1D9E75' };
    const GROUP_ORDER = ['Antenna', 'News & Business', 'Sports', 'Movies', 'Shows', 'Docs & Lifestyle'];

    const T = {
        loaded: false, enabled: true, ticket: '', channels: [], guide: {},
        idx: 0, playingIdx: -1, lastIdx: -1, hls: null, usingRelay: false,
        digits: '', digitTimer: null, tuneTimer: null, bannerTimer: null, guideTimer: null,
        hlsLoading: null, antenna: null,
    };

    const groupColor = (g) => GROUP_COLORS[g] || '#888780';
    const tvLogo = (ch) => (ch && ch.hasLogo ? ApiClient.getUrl(ch.logo) + '?t=' + encodeURIComponent(T.ticket) : '');
    // Numbers come as strings ("4.1", "101"); older saved state may hold plain numbers.
    const sameNum = (a, b) => String(a) === String(b);
    const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

    function loadHlsJs() {
        if (window.Hls) return Promise.resolve(window.Hls);
        if (!T.hlsLoading) {
            T.hlsLoading = new Promise((resolve, reject) => {
                const el = document.createElement('script');
                el.src = ApiClient.getUrl('Tuner/hls.js') + '?v=1.7.3';
                el.onload = () => resolve(window.Hls);
                // Forget a failed load, so the next tune tries again instead of
                // failing for the rest of the session.
                el.onerror = (e) => { T.hlsLoading = null; reject(e); };
                document.head.appendChild(el);
            });
        }
        return T.hlsLoading;
    }

    async function loadTv() {
        const data = await api('Tuner/tv');
        T.enabled = !!data.enabled;
        if (!T.enabled) { T.loaded = true; return; }
        T.ticket = data.ticket;
        T.channels = data.channels || [];
        const last = load('tvlast', null);
        const i = T.channels.findIndex((c) => sameNum(c.number, last));
        T.idx = i >= 0 ? i : 0;
        T.loaded = true;
        refreshGuide();
    }

    async function refreshGuide() {
        clearTimeout(T.guideTimer);
        try { T.guide = await api('Tuner/tv/guide'); renderTvInfo(); } catch (e) { /* keep last */ }
        // Programs change on the half hour; five minutes keeps the bar honest without chatter.
        if (S.active === 'tv') T.guideTimer = setTimeout(refreshGuide, 5 * 60 * 1000);
    }

    function nowNext(ch) {
        const g = ch && T.guide[String(ch.number)];
        const now = g && g.now && g.now.title !== ch.name ? g.now : null;
        const next = g && g.next && g.next.title !== ch.name ? g.next : null;
        return { now, next };
    }

    // ---------- tuning ----------

    // Channel up/down move the selection and banner immediately, then tune once the
    // viewer pauses, so flicking through ten channels doesn't open ten streams.
    function surf(d) {
        if (!T.channels.length) return;
        tvSelect((T.idx + d + T.channels.length) % T.channels.length);
    }

    function tvSelect(i, immediate) {
        if (i < 0 || i >= T.channels.length) return;
        if (T.playingIdx >= 0 && i !== T.idx) T.lastIdx = T.playingIdx;
        T.idx = i;
        showBanner();
        renderTvInfo();
        clearTimeout(T.tuneTimer);
        T.tuneTimer = setTimeout(() => tvTune(T.idx), immediate ? 0 : TUNE_DELAY_MS);
    }

    function lastChannel() { if (T.lastIdx >= 0) tvSelect(T.lastIdx, true); }

    function teardownVideo() {
        releaseAntenna();
        if (T.hls) { try { T.hls.destroy(); } catch (e) { /* already gone */ } T.hls = null; }
        const v = $('.tnr-video');
        if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
    }

    // An antenna channel holds one of the HDHomeRun's two tuners until the server hears
    // nobody is watching. Say so right away when tuning away instead of waiting for the
    // server's idle timeout, or surfing through three antenna channels would lock out
    // the third. keepalive lets the request finish even when the page is closing.
    function releaseAntenna() {
        if (!T.antenna) return;
        const n = T.antenna; T.antenna = null;
        try {
            fetch(ApiClient.getUrl(`Tuner/tv/antenna/${n}/release`) + '?t=' + encodeURIComponent(T.ticket), { method: 'POST', keepalive: true }).catch(() => {});
        } catch (e) { /* best effort; the server times it out anyway */ }
    }

    // Closing the tab or the app skips teardown; free the tuner then too.
    window.addEventListener('pagehide', releaseAntenna);

    // Channels whose CDN refused a direct cross-origin load. Remembered per browser so
    // the next visit goes straight to the relay instead of failing first (~0.5 s saved).
    const relayed = () => new Set(load('tvrelay', []));

    async function tvTune(i, viaRelay) {
        const ch = T.channels[i]; const v = $('.tnr-video');
        if (!ch || !v) return;
        const antenna = ch.kind === 'antenna';
        if (!antenna && !viaRelay && relayed().has(String(ch.number))) viaRelay = true;
        // One thing playing at a time: TV takes over from radio.
        if (S.playing) stop();
        teardownVideo();
        T.playingIdx = i; T.usingRelay = !!viaRelay;
        if (antenna) T.antenna = ch.number;
        store('tvlast', ch.number);
        setStatus('Tuning…');
        staticBlip();
        const src = antenna ? ApiClient.getUrl(ch.url) + '?t=' + encodeURIComponent(T.ticket)
            : viaRelay ? ApiClient.getUrl(ch.relay) + '&t=' + encodeURIComponent(T.ticket) : ch.url;
        const nativeHls = v.canPlayType('application/vnd.apple.mpegurl');
        let Hls = null;
        try { Hls = await loadHlsJs(); } catch (e) { /* fall back to native below */ }
        if (T.playingIdx !== i) return;   // viewer moved on while hls.js loaded

        if (Hls && Hls.isSupported()) {
            const hls = new Hls({
                // Start near the top quality instead of ramping up from 240p for 20 s.
                abrEwmaDefaultEstimate: 6e6,
                capLevelToPlayerSize: true,
                backBufferLength: 30,
                // Antenna: the first request waits while the server tunes and encodes
                // the first segment (3-6 s), longer than hls.js's default patience.
                manifestLoadingTimeOut: antenna ? 20000 : 10000,
                liveSyncDurationCount: antenna ? 2 : 3,
            });
            T.hls = hls;
            hls.on(Hls.Events.MANIFEST_PARSED, () => { v.play().catch(() => setStatus('Press play')); });
            hls.on(Hls.Events.ERROR, (_, data) => {
                if (!data.fatal || T.hls !== hls) return;
                if (antenna) {
                    const code = data.response && data.response.code;
                    setStatus(code === 429 ? 'Both antenna tuners are in use' : `${ch.name} isn't coming in right now`);
                } else if (data.type === Hls.ErrorTypes.NETWORK_ERROR && !viaRelay) {
                    // Usually the CDN refusing a cross-origin request: go through the relay.
                    const r = relayed(); r.add(String(ch.number)); store('tvrelay', [...r]);
                    tvTune(i, true);
                } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                    hls.recoverMediaError();
                } else {
                    setStatus(`${ch.name} isn't available right now`);
                }
            });
            hls.loadSource(src);
            hls.attachMedia(v);
        } else if (nativeHls) {
            v.src = src;
            v.onerror = () => { if (!antenna && !viaRelay && T.playingIdx === i) tvTune(i, true); else setStatus(`${ch.name} isn't available right now`); };
            v.play().catch(() => setStatus('Press play'));
        } else {
            setStatus("This browser can't play live TV");
        }
    }

    function setStatus(msg) {
        const el = $('.tnr-tv-status');
        if (!el) return;
        el.textContent = msg || '';
        el.classList.toggle('show', !!msg);
    }

    // ---------- digits ----------

    // Digits and "." (antenna subchannels like 9.5). "12" lands on 12.1, like a real set.
    function typeDigit(d) {
        if (d === '.' && T.digits.includes('.')) return;
        T.digits = (T.digits + d).slice(0, 5);
        const el = $('.tnr-tv-digits');
        if (el) el.textContent = T.digits.includes('.') ? T.digits : T.digits.padEnd(3, '_');
        clearTimeout(T.digitTimer);
        const fire = () => {
            const typed = T.digits; T.digits = '';
            if (el) el.textContent = '';
            const want = parseFloat(typed);
            if (Number.isNaN(want)) return;
            // Exact number, else the next channel up.
            let i = T.channels.findIndex((c) => sameNum(c.number, typed));
            if (i < 0) i = T.channels.findIndex((c) => parseFloat(c.number) >= want);
            if (i < 0) i = T.channels.length - 1;
            tvSelect(i, true);
        };
        const done = T.digits.includes('.') ? /\.\d{2}$/.test(T.digits) : T.digits.length >= 3;
        if (done) fire(); else T.digitTimer = setTimeout(fire, 2000);
    }

    // ---------- rendering ----------

    function showBanner() {
        const b = $('.tnr-banner'); if (!b) return;
        b.classList.add('show');
        clearTimeout(T.bannerTimer);
        T.bannerTimer = setTimeout(() => { if (!$('.tnr-video') || !$('.tnr-video').paused) b.classList.remove('show'); }, BANNER_MS);
    }

    function renderTvPage() {
        const page = document.getElementById(TV_PAGE_ID);
        if (!page || !T.loaded) return;
        const root = $('.tnr-wrap', page);
        if (!T.enabled) {
            root.innerHTML = '<div class="tnr-empty">TV needs Dispatcharr. Add its URL and API key in Dashboard → Plugins → Tuner.</div>';
            return;
        }
        root.innerHTML = `
            <div class="tnr-head"><h1>Surf TV</h1>
                <button class="tnr-btn tnr-static" title="Tuning sound">${load('static', true) ? 'Static on' : 'Static off'}</button></div>
            <div class="tnr-tv-main">
                <div class="tnr-screen" tabindex="-1">
                    <video class="tnr-video" playsinline></video>
                    <div class="tnr-tv-status"></div>
                    <div class="tnr-tv-digits"></div>
                    <div class="tnr-banner show">
                        <div class="tnr-banner-num"></div>
                        <div class="tnr-banner-logo"></div>
                        <div class="tnr-banner-text">
                            <p class="tnr-banner-name"></p>
                            <p class="tnr-banner-now"></p>
                            <div class="tnr-bar"><div class="tnr-bar-fill"></div></div>
                            <p class="tnr-banner-next"></p>
                        </div>
                    </div>
                    <div class="tnr-screen-controls">
                        <button class="tnr-btn tnr-mute" aria-label="Mute"><span class="material-icons">volume_up</span></button>
                        <button class="tnr-btn tnr-full" aria-label="Full screen"><span class="material-icons">fullscreen</span></button>
                    </div>
                </div>
                <div class="tnr-side">
                    <div class="tnr-guide"></div>
                    <div class="tnr-side-btns">
                        <button class="tnr-btn tnr-down" aria-label="Channel down" title="Channel down"><span class="material-icons">keyboard_arrow_down</span></button>
                        <button class="tnr-btn tnr-up" aria-label="Channel up" title="Channel up"><span class="material-icons">keyboard_arrow_up</span></button>
                        <button class="tnr-btn tnr-last" title="Last channel (L)">Last</button>
                    </div>
                </div>
            </div>
            <div class="tnr-cats"></div>
            <div class="tnr-hint">Up/down changes channel, type a number to jump (12 for 12.1, or 9.5), L goes back, M mutes, F full screen.</div>`;

        const v = $('.tnr-video', root);
        v.volume = load('tvvol', 1); v.muted = load('tvmute', false);
        v.addEventListener('playing', () => { setStatus(''); showBanner(); });
        // 'waiting' can fire after 'playing' while the first segments settle; once the
        // picture is actually advancing, the "Tuning…" label has no business being up.
        let lastT = 0;
        v.addEventListener('timeupdate', () => { if (v.currentTime > lastT + 0.5) { lastT = v.currentTime; setStatus(''); } });
        v.addEventListener('emptied', () => { lastT = 0; });
        v.addEventListener('waiting', () => setStatus('Tuning…'));
        v.addEventListener('volumechange', () => { store('tvvol', v.volume); store('tvmute', v.muted); renderMuteIcon(); });
        const screen = $('.tnr-screen', root);
        screen.addEventListener('mousemove', showBanner);
        screen.addEventListener('click', (e) => { if (!e.target.closest('button')) { showBanner(); if (v.paused) v.play().catch(() => {}); } });
        // Phones: swipe up/down on the picture to change channel.
        let y0 = null;
        screen.addEventListener('touchstart', (e) => { y0 = e.touches[0].clientY; }, { passive: true });
        screen.addEventListener('touchend', (e) => {
            if (y0 == null) return; const dy = e.changedTouches[0].clientY - y0; y0 = null;
            if (Math.abs(dy) > 40) surf(dy < 0 ? 1 : -1);
        });
        $('.tnr-up', root).addEventListener('click', () => surf(1));
        $('.tnr-down', root).addEventListener('click', () => surf(-1));
        $('.tnr-last', root).addEventListener('click', lastChannel);
        $('.tnr-mute', root).addEventListener('click', () => { v.muted = !v.muted; });
        $('.tnr-full', root).addEventListener('click', toggleFullscreen);
        $('.tnr-static', root).addEventListener('click', (e) => { const val = !load('static', true); store('static', val); e.currentTarget.textContent = val ? 'Static on' : 'Static off'; });
        renderMuteIcon();
        renderTvInfo();
        tvSelect(T.idx, true);
    }

    function renderMuteIcon() {
        const v = $('.tnr-video'), b = $('.tnr-mute');
        if (v && b) b.innerHTML = `<span class="material-icons">${v.muted ? 'volume_off' : 'volume_up'}</span>`;
    }

    function toggleFullscreen() {
        const screen = $('.tnr-screen'); if (!screen) return;
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else if (screen.requestFullscreen) screen.requestFullscreen().catch(() => {});
        else { const v = $('.tnr-video'); if (v && v.webkitEnterFullscreen) v.webkitEnterFullscreen(); }   // iPhone
    }

    function renderTvInfo() {
        const ch = T.channels[T.idx]; if (!ch) return;
        const color = groupColor(ch.group), { now, next } = nowNext(ch);
        const set = (sel, text) => { const el = $(sel); if (el) el.textContent = text; };
        const num = $('.tnr-banner-num'); if (num) { num.textContent = ch.number; num.style.color = color; }
        const logo = $('.tnr-banner-logo');
        if (logo) logo.innerHTML = ch.hasLogo ? `<img src="${esc(tvLogo(ch))}" alt="">` : '';
        set('.tnr-banner-name', `${ch.name} · ${ch.group}`);
        set('.tnr-banner-now', now ? now.title : 'Live');
        const fill = $('.tnr-bar-fill');
        if (fill) {
            const pct = now ? Math.min(100, Math.max(0, ((Date.now() - new Date(now.start)) / (new Date(now.end) - new Date(now.start))) * 100)) : 0;
            fill.style.width = `${Math.round(pct)}%`; fill.style.background = color;
            fill.parentElement.style.visibility = now ? 'visible' : 'hidden';
        }
        set('.tnr-banner-next', next ? `Next at ${fmtTime(next.start)}: ${next.title}` : (now ? `Until ${fmtTime(now.end)}` : 'No guide for this channel'));
        const screen = $('.tnr-screen'); if (screen) screen.style.setProperty('--tnr-ch', color);

        // Side guide: three channels either side of the current one.
        const guide = $('.tnr-guide');
        if (guide) {
            const rows = [];
            for (let o = -3; o <= 3; o++) {
                const j = (T.idx + o + T.channels.length) % T.channels.length, c = T.channels[j], nn = nowNext(c);
                rows.push(`<div class="tnr-grow ${o === 0 ? 'on' : ''}" data-i="${j}">
                    <span class="tnr-gnum" style="color:${esc(groupColor(c.group))}">${c.number}</span>
                    <span class="tnr-gtext"><span class="tnr-gname">${esc(c.name)}</span><span class="tnr-gnow">${esc(nn.now ? nn.now.title : 'Live')}</span></span>
                </div>`);
            }
            guide.innerHTML = rows.join('');
            guide.querySelectorAll('.tnr-grow').forEach((r) => r.addEventListener('click', () => tvSelect(+r.dataset.i, true)));
        }

        // Category chips: jump to the first channel of a block.
        const cats = $('.tnr-cats');
        if (cats) {
            const present = GROUP_ORDER.filter((g) => T.channels.some((c) => c.group === g))
                .concat([...new Set(T.channels.map((c) => c.group))].filter((g) => !GROUP_ORDER.includes(g)));
            cats.innerHTML = present.map((g) => `<button class="tnr-cat ${g === ch.group ? 'on' : ''}" data-g="${esc(g)}" ${g === ch.group ? `style="background:${esc(groupColor(g))}"` : ''}>${esc(g)}</button>`).join('');
            cats.querySelectorAll('.tnr-cat[data-g]').forEach((b) => b.addEventListener('click', () => {
                tvSelect(T.channels.findIndex((c) => c.group === b.dataset.g), true);
            }));
        }
    }

    // =====================================================================
    // Page lifecycle (mirrors how jellyfin-web swaps its own views)
    // =====================================================================

    const PAGES = {
        radio: { route: ROUTE, id: PAGE_ID, title: 'Radio', loading: 'Loading stations…' },
        tv: { route: TV_ROUTE, id: TV_PAGE_ID, title: 'Surf TV', loading: 'Loading channels…' },
    };

    function pageEl(kind) {
        const def = PAGES[kind];
        let page = document.getElementById(def.id);
        if (!page) {
            page = document.createElement('div');
            page.id = def.id;
            page.className = 'page type-interior mainAnimatedPage hide tnr-page';
            page.setAttribute('data-title', def.title);
            page.setAttribute('data-backbutton', 'true');
            page.innerHTML = `<div data-role="content"><div class="content-primary"><div class="tnr-wrap"><div class="tnr-empty">${def.loading}</div></div></div></div>`;
            (document.querySelector('.mainAnimatedPages') || document.body).appendChild(page);
        }
        return page;
    }

    function leave(kind) {
        const page = document.getElementById(PAGES[kind].id);
        if (page) {
            page.classList.add('hide');
            page.dispatchEvent(new CustomEvent('viewhide', { bubbles: true, detail: { type: 'custom' } }));
        }
        if (kind === 'tv') {
            // TV doesn't keep playing in the background the way radio does.
            clearTimeout(T.tuneTimer); clearTimeout(T.guideTimer);
            teardownVideo(); T.playingIdx = -1;
            if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        }
    }

    async function showPage(kind) {
        kind = kind || 'radio';
        if (S.active === kind) return;
        if (S.active) leave(S.active);
        else {
            // Remember Jellyfin's own page so leaving ours puts it back.
            const own = document.querySelector('.mainAnimatedPage:not(.hide):not(.tnr-page)');
            if (own) {
                S.prevPage = own;
                own.classList.add('hide');
                own.dispatchEvent(new CustomEvent('viewhide', { bubbles: true, detail: { type: 'interior' } }));
            }
        }
        S.active = kind;
        S.pageVisible = kind === 'radio';
        startLocationWatcher();
        const page = pageEl(kind);
        page.classList.remove('hide');
        // Lets the stylesheet hide the previous library page's toolbar and move the top-bar
        // highlight to our link (Jellyfin's React bar doesn't know about our pages).
        document.body.classList.add('tnr-page-active');
        document.body.dataset.tnrPage = kind;
        page.dispatchEvent(new CustomEvent('viewshow', { bubbles: true, detail: { type: 'custom', isRestored: false, options: {} } }));
        document.title = PAGES[kind].title;
        renderMini();
        try {
            if (kind === 'radio') { if (!S.loaded) await loadCatalog(); renderPage(); }
            else { if (!T.loaded) await loadTv(); else refreshGuide(); renderTvPage(); }
        } catch (e) {
            $('.tnr-wrap', page).innerHTML = `<div class="tnr-empty">Couldn't load ${kind === 'radio' ? 'the station list' : 'the channel list'}. Check the Tuner plugin settings.</div>`;
        }
    }

    function hidePage() {
        if (!S.active) return;
        leave(S.active);
        if (S.prevPage && !document.querySelector('.mainAnimatedPage:not(.hide):not(.tnr-page)')) {
            S.prevPage.classList.remove('hide');
            S.prevPage.dispatchEvent(new CustomEvent('viewshow', { bubbles: true, detail: { type: 'interior', isRestored: true } }));
        }
        document.body.classList.remove('tnr-page-active');
        delete document.body.dataset.tnrPage;
        S.active = null; S.pageVisible = false; S.prevPage = null;
        stopLocationWatcher();
        renderMini();
    }

    // jellyfin-web navigates with pushState, which fires no event, so poll the URL
    // while one of our pages is up to notice when the user goes somewhere else.
    function startLocationWatcher() {
        if (S.locTimer) return;
        S.locSig = location.pathname + location.hash;
        S.locTimer = setInterval(() => {
            const sig = location.pathname + location.hash;
            if (sig !== S.locSig) { S.locSig = sig; route(); }
        }, 150);
    }
    function stopLocationWatcher() { clearInterval(S.locTimer); S.locTimer = null; }

    function route() {
        if (location.hash.startsWith(ROUTE)) showPage('radio');
        else if (location.hash.startsWith(TV_ROUTE)) showPage('tv');
        else if (S.active) hidePage();
    }

    function go(kind) {
        return (e) => {
            if (e) e.preventDefault();
            const r = PAGES[kind].route;
            if (location.hash !== r) history.pushState({ page: 'tuner-' + kind }, PAGES[kind].title, r);
            showPage(kind);
        };
    }

    // =====================================================================
    // Entry points: side menu and top bar
    // =====================================================================

    // MUI icon paths, so our buttons match Jellyfin's own SVG icons.
    const ICONS = {
        radio: 'M3.24 6.15C2.51 6.43 2 7.17 2 8v12c0 1.1.89 2 2 2h16c1.11 0 2-.9 2-2V8c0-1.11-.89-2-2-2H8.3l8.26-3.34L15.88 1zM7 20c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3m13-8h-2v-2h-2v2H4V8h16z',
        tv: 'M21 3H3c-1.11 0-2 .89-2 2v12c0 1.1.89 2 2 2h5v2h8v-2h5c1.1 0 1.99-.9 1.99-2L23 5c0-1.11-.9-2-2-2m0 14H3V5h18zM16 11l-7 4V7z',
    };
    const ENTRIES = [
        { kind: 'radio', label: 'Radio', material: 'radio' },
        { kind: 'tv', label: 'Surf TV', material: 'live_tv' },
    ];

    // Jellyfin 12 ships two web layouts. The classic one has .mainDrawer-scrollContainer;
    // the newer one keeps that element in the DOM but hidden, and shows an MUI drawer
    // instead. Put the links in whichever is actually visible (same rule Jellyfin
    // Enhanced uses), and never in the admin dashboard's drawer.
    function sidebarTarget() {
        const legacy = document.querySelector('.mainDrawer-scrollContainer');
        if (legacy && legacy.offsetParent !== null) return { el: legacy, kind: 'legacy' };
        if (document.body.classList.contains('dashboardDocument')) return null;
        const paper = document.querySelector('.MuiDrawer-paper');
        if (!paper) return legacy ? { el: legacy, kind: 'legacy' } : null;
        return { el: paper.querySelector('[role="presentation"]') || paper, kind: 'mui' };
    }

    function closeDrawer(kind) {
        if (kind === 'mui') {
            const bd = document.querySelector('.MuiDrawer-root .MuiBackdrop-root');
            if (bd) bd.click();
        } else if (document.body.classList.contains('drawer-open')) {
            document.body.classList.remove('drawer-open');
        }
    }

    function injectNav() {
        const t = sidebarTarget();
        if (!t || t.el.querySelector('.tnr-nav[data-v="2"]')) return;
        document.querySelectorAll('.tnr-nav').forEach((n) => n.remove());
        const section = document.createElement('div');
        section.className = 'tnr-nav' + (t.kind === 'mui' ? ' tnr-nav-mui' : '');
        section.dataset.v = '2';
        section.innerHTML = (t.kind === 'mui' ? '<div class="tnr-nav-head">Tuner</div>' : '<h3 class="sidebarHeader">Tuner</h3>')
            + ENTRIES.map((en) => (t.kind === 'mui'
                ? `<a class="tnr-nav-link" data-kind="${en.kind}" href="${PAGES[en.kind].route}"><span class="material-icons" aria-hidden="true">${en.material}</span><span>${en.label}</span></a>`
                : `<a is="emby-linkbutton" data-kind="${en.kind}" class="navMenuOption lnkMediaFolder emby-button" href="${PAGES[en.kind].route}">
                       <span class="material-icons navMenuOptionIcon" aria-hidden="true">${en.material}</span>
                       <span class="sectionName navMenuOptionText">${en.label}</span></a>`)).join('');
        section.querySelectorAll('a').forEach((a) => a.addEventListener('click', (e) => { go(a.dataset.kind)(e); closeDrawer(t.kind); }));
        if (t.kind === 'legacy') {
            const media = t.el.querySelector('.libraryMenuOptions');
            if (media) t.el.insertBefore(section, media); else t.el.appendChild(section);
        } else {
            const firstList = t.el.querySelector('ul');
            if (firstList && firstList.parentNode === t.el) firstList.after(section); else t.el.appendChild(section);
        }
    }

    const svgIcon = (kind) => `<svg class="MuiSvgIcon-root MuiSvgIcon-fontSizeMedium" focusable="false" aria-hidden="true" viewBox="0 0 24 24" style="width:1em;height:1em;font-size:1.5rem;fill:currentColor"><path d="${ICONS[kind]}"></path></svg>`;

    // How should the top bar look: our text links (and which of Jellyfin's links move into
    // "More" to make room), or our icons next to Search?
    //
    // WHY: Jellyfin decides "wide enough for text links" from the window size alone and
    // shows a fixed number of library links for that size. Two more labels on top made
    // every label wrap onto two cramped lines ("the top options were all squished"). The goal:
    // Radio and Surf TV as text right after Live TV, with the libraries after Live TV
    // (the classics, by the library order every account now has) giving up their spot
    // first. So: try 0, then 1, then 2... of those trailing libraries tucked into "More"
    // until everything fits on one line; only if it still doesn't fit do ours fall back
    // to icons, the same as on narrow screens.
    //
    // Widths come from the label text (canvas measureText) plus a link's padding and icon,
    // not from the links as rendered: a wrapped link reports a smaller width, a link we've
    // hidden reports none, and our own elements are left out of the room. So the answer is
    // the same whichever layout is showing, and switching can't make it flip back and forth.
    const measureCtx = document.createElement('canvas').getContext('2d');
    function oneLineWidth(a, label) {
        const cs = getComputedStyle(a);
        measureCtx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        // measureText ignores letter-spacing, which MUI buttons set, so add it per character.
        let w = measureCtx.measureText(label).width + (parseFloat(cs.letterSpacing) || 0) * label.length
            + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)
            + parseFloat(cs.marginLeft) + parseFloat(cs.marginRight);
        const icon = a.querySelector('.MuiButton-startIcon');
        if (icon) {
            const ics = getComputedStyle(icon);
            w += icon.getBoundingClientRect().width + parseFloat(ics.marginLeft) + parseFloat(ics.marginRight);
        }
        return w;
    }
    const hrefOf = (a) => a.getAttribute('href') || '';
    const jellyfinMore = (stack) => stack.querySelector(':scope > button[aria-controls="user-view-overflow-menu"]');
    function planTopNav(bar, stack, links, model) {
        const gap = parseFloat(getComputedStyle(stack).columnGap) || 0;
        const live = links.findIndex((a) => hrefOf(a).startsWith('#/livetv'));
        const movable = live >= 0 ? links.length - live - 1 : 0;   // libraries after Live TV
        const jfMore = jellyfinMore(stack);
        const others = Array.from(stack.children).filter((c) => c.tagName !== 'A' && c !== jfMore && !c.classList.contains('tnr-more'));
        const w = (label) => oneLineWidth(model, label);   // every bar link has the same padding and icon
        const ours = ENTRIES.reduce((sum, en) => sum + w(en.label), 0);
        const moreW = jfMore ? jfMore.getBoundingClientRect().width : w('More');   // label + arrow ~ label + icon
        const othersW = others.reduce((sum, c) => sum + c.getBoundingClientRect().width, 0);
        // Space the stack can have: the bar minus its padding and what everything else in it
        // (the icon cluster on the right, the user button) actually holds. Measured by
        // contents, not box: the icon cluster stretches to fill whatever the links leave
        // (507 px wide holding 278 px of icons at 1366), so its box would make the answer
        // depend on the current layout. Our own icons are left out.
        const bcs = getComputedStyle(bar);
        let room = bar.clientWidth - parseFloat(bcs.paddingLeft) - parseFloat(bcs.paddingRight);
        Array.from(bar.children).forEach((c) => {
            if (c === stack) return;
            const kids = Array.from(c.children).filter((k) => !k.classList.contains('tnr-topicon'));
            if (!kids.length) { room -= c.getBoundingClientRect().width; return; }
            const ccs = getComputedStyle(c);
            room -= kids.reduce((sum, k) => sum + k.getBoundingClientRect().width, 0)
                + (parseFloat(ccs.columnGap) || 0) * (kids.length - 1)
                + parseFloat(ccs.paddingLeft) + parseFloat(ccs.paddingRight)
                + parseFloat(ccs.marginLeft) + parseFloat(ccs.marginRight);
        });
        for (let k = 0; k <= movable; k++) {
            const shown = links.slice(0, links.length - k);
            const withMore = !!jfMore || k > 0;
            const count = shown.length + ENTRIES.length + others.length + (withMore ? 1 : 0);
            const need = shown.reduce((sum, a) => sum + w(a.textContent.trim()), 0) + ours + othersW
                + (withMore ? moreW : 0) + gap * (count - 1);
            // A few px of slack for rounding. Measured on the live bar: at 1366 px everything
            // fits with ~8 px to spare and nothing wraps, so more slack would switch too early.
            if (need + 4 <= room) return { text: true, tucked: links.slice(links.length - k) };
        }
        // Ours go in as icons next to Search. That normally leaves enough room, but on pages
        // Jellyfin doesn't know (ours) it shows its wide bar at ANY width, without the menu
        // button, so on a narrow window its links ran under the icons (seen going Dashboard ->
        // Radio at ~550 px). So tuck Jellyfin's links from the end, all of them if needed
        // (never the logo/home link), and as a last resort shrink the logo to its icon.
        const search = bar.querySelector('a[aria-label="Search"], button[aria-label="Search"]');
        const iconRoom = room - (search ? search.getBoundingClientRect().width : 46) * ENTRIES.length;
        const keep = hrefOf(links[0]) === '#/' ? 1 : 0;
        const width = (a) => (hrefOf(a) === '#/' ? a.getBoundingClientRect().width : w(a.textContent.trim()));
        for (let k = 0; k <= links.length - keep; k++) {
            const shown = links.slice(0, links.length - k);
            const withMore = !!jfMore || k > 0;
            const count = shown.length + others.length + (withMore ? 1 : 0);
            const need = shown.reduce((sum, a) => sum + width(a), 0) + othersW
                + (withMore ? moreW : 0) + gap * (count - 1);
            if (need + 4 <= iconRoom) return { text: false, tucked: links.slice(links.length - k) };
        }
        return { text: false, tucked: links.slice(keep), compact: true };
    }

    // Links we've tucked away, offered in "More": Jellyfin's own menu if it's showing one
    // (we add them to it each time it opens), otherwise our own "More" button + menu built
    // from Jellyfin's button so it looks the same.
    function tuckedItems() {
        const jf = Array.from(document.querySelectorAll('.MuiAppBar-root a[data-tnr-tucked]'))
            .map((a) => ({ href: hrefOf(a), label: a.textContent.trim(), svg: a.querySelector('svg') }));
        // Our icons when a crowded phone bar hid them (see injectTopBar). They open with go(),
        // not the href: a plain hash change makes Jellyfin render its "Page not found".
        const ours = Array.from(document.querySelectorAll('.MuiAppBar-root .tnr-topicon[data-tnr-hidden]'))
            .map((b) => ({ href: PAGES[b.dataset.kind].route, label: b.getAttribute('aria-label'), svg: b.querySelector('svg'), kind: b.dataset.kind }));
        return jf.concat(ours);
    }
    function fillJellyfinMore() {
        const list = document.querySelector('#user-view-overflow-menu ul[role="menu"]');
        if (!list) return false;
        list.querySelectorAll('.tnr-moreitem').forEach((n) => n.remove());
        const proto = list.querySelector('a[role="menuitem"]:not(.tnr-moreitem)');
        // Tucked links come before everything Jellyfin already put in its More (they sat
        // left of it in the bar), so they go at the top, in bar order.
        const first = list.firstChild;
        tuckedItems().forEach((it) => {
            let li;
            if (proto) {
                li = proto.cloneNode(true);
                const text = li.querySelector('.MuiListItemText-primary');
                if (text) text.textContent = it.label;
                const svg = li.querySelector('svg');
                if (svg && it.svg) svg.replaceWith(it.svg.cloneNode(true));
            } else {
                li = document.createElement('a');
                li.className = 'tnr-more-item';
                li.textContent = it.label;
            }
            li.classList.add('tnr-moreitem');
            li.setAttribute('href', it.href);
            if (it.kind) {
                li.addEventListener('click', (e) => {
                    go(it.kind)(e);
                    // close Jellyfin's menu the way a click outside it would
                    const bd = document.querySelector('#user-view-overflow-menu .MuiBackdrop-root');
                    if (bd) bd.click();
                });
            }
            list.insertBefore(li, first);
        });
        return true;
    }
    function hookJellyfinMore(btn) {
        if (btn.dataset.tnrHooked) return;
        btn.dataset.tnrHooked = '1';
        // The menu is rendered by React after the click; try for a few frames.
        btn.addEventListener('click', () => {
            let tries = 0;
            const attempt = () => { if (!fillJellyfinMore() && ++tries < 20) requestAnimationFrame(attempt); };
            requestAnimationFrame(attempt);
        });
    }

    function closeOurMore() {
        document.querySelectorAll('.tnr-more-menu').forEach((n) => n.remove());
        document.querySelectorAll('.tnr-more[aria-expanded="true"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
    }
    function openOurMore(btn) {
        closeOurMore();
        const menu = document.createElement('div');
        menu.className = 'tnr-more-menu';
        menu.setAttribute('role', 'menu');
        tuckedItems().forEach((it) => {
            const a = document.createElement('a');
            a.className = 'tnr-more-item';
            a.setAttribute('role', 'menuitem');
            a.setAttribute('href', it.href);
            if (it.svg) a.appendChild(it.svg.cloneNode(true));
            a.appendChild(document.createTextNode(it.label));
            if (it.kind) a.addEventListener('click', go(it.kind));
            a.addEventListener('click', closeOurMore);
            menu.appendChild(a);
        });
        const r = btn.getBoundingClientRect();
        menu.style.top = `${Math.round(r.bottom + 4)}px`;
        menu.style.left = `${Math.round(Math.min(r.left, window.innerWidth - 240))}px`;
        document.body.appendChild(menu);
        btn.setAttribute('aria-expanded', 'true');
        const away = (e) => {
            if (e.type === 'keydown' && e.key !== 'Escape') return;
            if (e.type === 'pointerdown' && (menu.contains(e.target) || btn.contains(e.target))) return;
            closeOurMore();
            ['pointerdown', 'keydown', 'scroll', 'resize'].forEach((t) => window.removeEventListener(t, away, true));
        };
        ['pointerdown', 'keydown', 'scroll', 'resize'].forEach((t) => window.addEventListener(t, away, true));
    }
    function ourMoreButton(model) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = model.className;
        b.classList.remove('MuiButton-textPrimary', 'MuiButton-colorPrimary');
        b.classList.add('tnr-more');
        b.setAttribute('aria-haspopup', 'true');
        b.setAttribute('aria-expanded', 'false');
        b.textContent = 'More';
        const end = document.createElement('span');
        end.className = 'MuiButton-icon MuiButton-endIcon MuiButton-iconSizeMedium tnr-more-arrow';
        const svg = model.querySelector('svg') ? model.querySelector('svg').cloneNode(true) : null;
        if (svg) {
            svg.removeAttribute('data-testid');
            svg.querySelectorAll('path').forEach((p, i) => (i === 0 ? p.setAttribute('d', 'm7 10 5 5 5-5z') : p.remove()));
            end.appendChild(svg);
        }
        b.appendChild(end);
        b.addEventListener('click', (e) => {
            e.preventDefault();
            if (document.querySelector('.tnr-more-menu')) closeOurMore(); else openOurMore(b);
        });
        return b;
    }

    // Jellyfin 12's newer layout shows library links across the top bar when the window
    // is wide and only icons when it's narrow, with the side menu hidden at full width.
    // So the entries go in the top bar either way: text links right after Live TV when
    // wide and there's room (see planTopNav), icons next to Search otherwise. They're
    // clones of Jellyfin's own elements so they get its exact styling; React may re-render
    // the bar and drop them, and the body observer puts them back.
    // True when some group in the bar holds more than its box: the right-hand icon cluster
    // keeps its width and lets the icons spill left over whatever is beside it.
    function barCrowded(bar) {
        if (bar.scrollWidth > bar.clientWidth + 1) return true;
        return Array.from(bar.children).some((c) => {
            const kids = Array.from(c.children).filter((k) => k.offsetParent !== null);
            if (!kids.length) return false;
            const need = kids.reduce((sum, k) => sum + k.getBoundingClientRect().width, 0);
            return need > c.getBoundingClientRect().width + 1;
        });
    }

    function injectTopBar() {
        const bar = document.querySelector('.MuiAppBar-root .MuiToolbar-root');
        if (bar) {
            const stack = bar.querySelector(':scope > .MuiStack-root');
            const links = stack ? Array.from(stack.querySelectorAll(':scope > a:not(.tnr-topnav)')) : [];
            const model = links.find((a) => hrefOf(a).startsWith('#/livetv')) || links[1];
            const jfWide = links.some((a) => hrefOf(a).startsWith('#/home?tab') || hrefOf(a).startsWith('#/livetv'));
            const plan = jfWide && model ? planTopNav(bar, stack, links, model) : { text: false, tucked: [] };
            // Tuck (or un-tuck) Jellyfin's trailing links. A data attribute, not a class:
            // React rewrites className on re-render but leaves attributes it doesn't own.
            links.forEach((a) => a.toggleAttribute('data-tnr-tucked', plan.tucked.includes(a)));
            if (links[0] && hrefOf(links[0]) === '#/') links[0].toggleAttribute('data-tnr-compact', !!plan.compact);
            const jfMore = stack ? jellyfinMore(stack) : null;
            let ourMore = stack ? stack.querySelector(':scope > .tnr-more') : null;
            if (plan.tucked.length && !jfMore) {
                if (!ourMore) { ourMore = ourMoreButton(model); stack.appendChild(ourMore); }
            } else if (ourMore) {
                ourMore.remove();
                closeOurMore();
            }
            // hooked whenever it shows: it may carry hidden icons even with nothing tucked
            if (jfMore) hookJellyfinMore(jfMore);
            if (plan.text) {
                document.querySelectorAll('.tnr-topicon').forEach((n) => n.remove());
                let anchor = model;
                ENTRIES.forEach((en) => {
                    let a = stack.querySelector(`.tnr-topnav[data-kind="${en.kind}"]`);
                    if (!a) {
                        a = model.cloneNode(true);
                        a.classList.remove('MuiButton-textPrimary', 'MuiButton-colorPrimary');
                        a.classList.add('tnr-topnav');
                        a.dataset.kind = en.kind;
                        a.setAttribute('href', PAGES[en.kind].route);
                        const icon = a.querySelector('.MuiButton-startIcon');
                        if (icon) icon.innerHTML = svgIcon(en.kind);
                        Array.from(a.childNodes).filter((n) => n.nodeType === 3).forEach((n) => n.remove());
                        a.appendChild(document.createTextNode(en.label));
                        a.addEventListener('click', go(en.kind));
                        anchor.after(a);
                    }
                    anchor = a;
                });
            } else {
                document.querySelectorAll('.tnr-topnav').forEach((n) => n.remove());
                const search = bar.querySelector('a[aria-label="Search"], button[aria-label="Search"]');
                if (search) {
                    ENTRIES.forEach((en) => {
                        if (bar.querySelector(`.tnr-topicon[data-kind="${en.kind}"]`)) return;
                        const b = search.cloneNode(true);
                        b.classList.add('tnr-topicon');
                        b.dataset.kind = en.kind;
                        b.setAttribute('aria-label', en.label);
                        b.setAttribute('title', en.label);
                        if (b.tagName === 'A') b.setAttribute('href', PAGES[en.kind].route);
                        const path = b.querySelector('path');
                        if (path) path.setAttribute('d', ICONS[en.kind]);
                        const svg = b.querySelector('svg');
                        if (svg) svg.removeAttribute('data-testid');
                        b.addEventListener('click', go(en.kind));
                        search.before(b);
                    });
                }
                // Phones: Jellyfin Enhanced's button plus our two icons don't fit beside the
                // menu button (at 375 px the icon row ran 14 px under it, even on Home). Hide our
                // icons then: with the menu button there, Radio and Surf TV are in the side menu;
                // on our own pages (no side menu) they're offered in More instead (tuckedItems).
                // An attribute, so the body observer doesn't loop on it.
                const icons = bar.querySelectorAll('.tnr-topicon');
                icons.forEach((b) => b.removeAttribute('data-tnr-hidden'));
                const carrier = bar.querySelector('button[aria-label="Open Menu"]')
                    || (stack && (jellyfinMore(stack) || stack.querySelector(':scope > .tnr-more')));
                if (icons.length && carrier && barCrowded(bar)) {
                    icons.forEach((b) => b.setAttribute('data-tnr-hidden', ''));
                }
            }
            return;
        }
        // Classic layout: header icons next to Jellyfin's own header buttons.
        const right = document.querySelector('.skinHeader .headerRight');
        if (right && right.offsetParent !== null) {
            ENTRIES.slice().reverse().forEach((en) => {
                if (right.querySelector(`.tnr-topicon[data-kind="${en.kind}"]`)) return;
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'headerButton headerButtonRight paper-icon-button-light tnr-topicon';
                b.dataset.kind = en.kind;
                b.title = en.label;
                b.setAttribute('aria-label', en.label);
                b.innerHTML = `<span class="material-icons" aria-hidden="true">${en.material}</span>`;
                b.addEventListener('click', go(en.kind));
                right.insertBefore(b, right.firstChild);
            });
        }
    }

    // =====================================================================
    // Keyboard
    // =====================================================================

    document.addEventListener('keydown', (e) => {
        if (!S.active || e.ctrlKey || e.metaKey || e.altKey) return;
        const tag = (e.target && e.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;
        let fn;
        if (S.active === 'radio') {
            fn = {
                ArrowDown: () => step(1), ArrowUp: () => step(-1),
                ArrowRight: () => stepGenre(1), ArrowLeft: () => stepGenre(-1),
                ' ': togglePlay, f: toggleFav, n: () => nextJam(), k: keepTrack,
                '/': () => { const s = $('.tnr-search'); if (s) s.focus(); },
            }[e.key];
        } else {
            const v = $('.tnr-video');
            if (/^[0-9.]$/.test(e.key)) fn = () => typeDigit(e.key);
            else {
                fn = {
                    // Channel up goes to the higher number, like a remote.
                    ArrowUp: () => surf(1), ArrowDown: () => surf(-1), PageUp: () => surf(1), PageDown: () => surf(-1),
                    l: lastChannel, m: () => { if (v) v.muted = !v.muted; }, f: toggleFullscreen,
                    ' ': () => { if (v) { if (v.paused) v.play().catch(() => {}); else v.pause(); } },
                    i: showBanner, Enter: showBanner,
                }[e.key];
            }
        }
        if (fn) { e.preventDefault(); fn(); }
    });

    // =====================================================================
    // Seasonal tiles in My Media (e.g. Halloween in October)
    // =====================================================================
    //
    // A season is a normal Jellyfin collection plus dates in the plugin settings; the server
    // says which are in season today (/Tuner/seasons, usually an empty list). Jellyfin builds
    // My Media from the libraries alone, so the tile is a copy of a library card pointed at the
    // collection: same size, same hover and focus, and its click goes through Jellyfin's own
    // card handling to the collection page. Out of season the list is empty and nothing is
    // drawn. The native TV apps draw their own home screen and won't show it.

    const SEASON_TTL_MS = 30 * 60 * 1000;   // a tab left open overnight picks up a new season
    const SEASON = { tiles: null, at: 0, loading: false };

    function seasonTiles() {
        if (!SEASON.loading && Date.now() - SEASON.at > SEASON_TTL_MS) {
            SEASON.loading = true;
            api('Tuner/seasons').then(
                (t) => { SEASON.tiles = Array.isArray(t) ? t : []; },
                () => { SEASON.tiles = SEASON.tiles || []; },   // plugin older than the page, or offline
            ).then(() => { SEASON.at = Date.now(); SEASON.loading = false; injectSeasonal(); });
        }
        return SEASON.tiles;   // null until the first answer
    }

    function seasonImageUrl(t, protoSrc) {
        // Same size and quality the library cards ask for, so the tile matches them exactly.
        const q = new URLSearchParams((protoSrc || '').split('?')[1] || 'fillHeight=203&fillWidth=360&quality=96');
        q.delete('tag');
        if (t.imageTag) q.set('tag', t.imageTag);
        return ApiClient.getUrl(`Items/${t.id}/Images/${t.imageType}`) + '?' + q.toString();
    }

    function seasonCard(proto, t) {
        const card = proto.cloneNode(true);
        const href = `#/details?id=${t.id}&serverId=${encodeURIComponent(proto.dataset.serverid || ApiClient.serverId())}`;
        card.classList.add('tnr-season');
        // data-index points into the library list Jellyfin rendered; this card isn't in it.
        ['index', 'collectiontype', 'path', 'prefix'].forEach((k) => card.removeAttribute('data-' + k));
        Object.assign(card.dataset, { id: t.id, type: 'BoxSet', isfolder: 'true' });
        const img = card.querySelector('.cardImageContainer');
        if (img) {
            const protoImg = proto.querySelector('.cardImageContainer');
            const protoSrc = protoImg && (protoImg.getAttribute('data-src') || (/url\("?([^")]+)"?\)/.exec(protoImg.style.backgroundImage) || [])[1]);
            img.setAttribute('href', href);
            img.setAttribute('aria-label', t.name);
            ['data-src', 'data-blurhash'].forEach((a) => img.removeAttribute(a));
            img.classList.remove('lazy');
            img.style.backgroundImage = `url("${seasonImageUrl(t, protoSrc)}")`;
        }
        const icon = card.querySelector('.cardImageIcon');
        if (icon) icon.className = 'cardImageIcon material-icons collections';
        card.querySelectorAll('.cardText a').forEach((a) => {
            a.setAttribute('href', href);
            a.removeAttribute('data-collectiontype');
            Object.assign(a.dataset, { id: t.id, type: 'BoxSet' });
            a.title = t.name;
            a.textContent = t.name;
        });
        return card;
    }

    // Users who picked "My media (small)" get buttons instead of tiles.
    function seasonButton(proto, t) {
        const b = proto.cloneNode(true);
        b.classList.add('tnr-season');
        b.dataset.id = t.id;
        b.setAttribute('href', `#/details?id=${t.id}&serverId=${encodeURIComponent(ApiClient.serverId())}`);
        const icon = b.querySelector('.homeLibraryIcon');
        if (icon) icon.className = 'material-icons homeLibraryIcon collections';
        const text = b.querySelector('.homeLibraryText');
        if (text) text.textContent = t.name;
        return b;
    }

    function injectSeasonal() {
        const lists = new Map();   // container -> prototype element to copy
        document.querySelectorAll('.homeSectionsContainer .card[data-type="CollectionFolder"]:not(.tnr-season)').forEach((c) => {
            if (!lists.has(c.parentElement)) lists.set(c.parentElement, { proto: c, make: seasonCard });
        });
        document.querySelectorAll('.homeSectionsContainer .homeLibraryButtonContainer').forEach((c) => {
            const proto = c.querySelector('a.homeLibraryButton:not(.tnr-season)');
            if (proto) lists.set(c, { proto, make: seasonButton });
        });
        if (!lists.size) return;
        const tiles = seasonTiles();
        if (!tiles) return;
        lists.forEach(({ proto, make }, list) => {
            list.querySelectorAll(':scope > .tnr-season').forEach((el) => {
                if (!tiles.some((t) => t.id === el.dataset.id)) el.remove();
            });
            // In front of the libraries: it's only there a few weeks a year, so it leads.
            const first = list.querySelector(':scope > :not(.tnr-season)');
            tiles.forEach((t) => {
                if (!list.querySelector(`:scope > .tnr-season[data-id="${t.id}"]`)) list.insertBefore(make(proto, t), first);
            });
        });
    }

    // A collection page puts anything that isn't a movie, show, episode, video, album or book
    // under "Other Items". For a seasonal collection that's its playlist (e.g. Halloween Mix),
    // so call the section what it is when it holds only playlists.
    function relabelCollectionPlaylists() {
        document.querySelectorAll('.collectionItems .verticalSection').forEach((sec) => {
            const cards = sec.querySelectorAll('.card');
            const title = sec.querySelector('.sectionTitle');
            if (!title || !cards.length || title.dataset.tnrRelabeled) return;
            if (Array.from(cards).every((c) => c.dataset.type === 'Playlist')) {
                title.textContent = cards.length > 1 ? 'Playlists' : 'Playlist';
                title.dataset.tnrRelabeled = '1';
            }
        });
    }

    // =====================================================================
    // Boot
    // =====================================================================

    function boot() {
        if (!window.ApiClient || !ApiClient.getCurrentUserId || !ApiClient.getCurrentUserId()) {
            setTimeout(boot, 500);
            return;
        }
        injectNav();
        injectTopBar();
        injectSeasonal();
        // The drawer and top bar are rebuilt on navigation, login and resize; put the links back.
        // Same for the home page's My Media row and a collection page's sections.
        let pending = false;
        new MutationObserver(() => {
            if (pending) return; pending = true;
            requestAnimationFrame(() => { pending = false; injectNav(); injectTopBar(); injectSeasonal(); relabelCollectionPlaylists(); });
        }).observe(document.body, { childList: true, subtree: true });
        // Rotating a phone or resizing the window changes how many dial numbers fit.
        let rz;
        // It also changes whether our top bar links fit, and resizing within Jellyfin's
        // wide layout doesn't always re-render the bar, so re-check that too.
        window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { injectTopBar(); if (S.active === 'radio') { renderScale(); renderNeedle(); } }, 150); });
        window.addEventListener('popstate', route);
        window.addEventListener('hashchange', route);
        route();
    }
    boot();
})();
