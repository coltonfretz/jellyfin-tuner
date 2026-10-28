/*
 * Tuner home rows: makes the home page's "Recently Added in ..." rows feel alive.
 *
 * WHY: Jellyfin loads only the newest 16 items per row (30 for music) and never moves
 * them, so a friend who opens the app sees the same handful of posters every time. Worse,
 * re-tagging one artist's albums makes them all "new" at once, so the music row turns
 * into a wall of the same artist. This script, injected next to tuner.js:
 *
 *   1. Loads a deeper list per row (48 items, 60 for music) from the same endpoint
 *      Jellyfin uses (/Items/Latest), so rows have several screens' worth of posters.
 *   2. For music, spreads artists out: every artist's newest album comes before anyone's
 *      second, and no artist gets more than three slots.
 *   3. Every couple of minutes slides each row over by one screen-width of whole cards,
 *      wrapping back to the start at the end. Rows are staggered so they don't all jump
 *      together.
 *
 * It never fights the viewer: a row stops moving while the pointer is over it and for
 * a while after anyone scrolls, swipes, clicks or keyboard-navigates in it.
 *
 * How it hooks in (jellyfin-web 12, home sections module): each Latest row is a
 * .verticalSection holding a title link (href "#/movies?topParentId=<libraryId>&...")
 * and an emby-itemscontainer whose per-instance fetchData() the row calls to get items.
 * We swap that one function, so Jellyfin's own card rendering, lazy images, context
 * menus and play buttons all keep working. The emby-scroller around it already has
 * scrollToPosition()/getScrollPosition(), used here for the slide. If any of that
 * markup changes in a future jellyfin-web, rows are simply left alone.
 */
(function () {
    'use strict';
    if (window.__tunerHomeRows) return;
    window.__tunerHomeRows = true;

    const me = document.currentScript;
    const STEP_MS = Math.max(20, parseInt((me && me.dataset.seconds) || '120', 10)) * 1000;
    const MIX_ARTISTS = !me || me.dataset.mix !== '0';
    const DEPTH = 48;
    const DEPTH_MUSIC = 60;
    const MAX_PER_ARTIST = 3;
    const QUIET_AFTER_TOUCH_MS = 60000;   // how long a row stays put after someone uses it
    const STAGGER_MS = 15000;             // rows advance 15 s apart, top to bottom
    const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const rows = [];   // {section, items, scroller, hover, touched, nextAt}

    // ---------- data ----------

    function libraryFor(section) {
        const a = section.querySelector('a.sectionTitleTextButton[href*="topParentId="]');
        if (!a) return null;   // TV layout has no link; leave those rows as Jellyfin made them
        const href = a.getAttribute('href') || '';
        const id = /[?&]topParentId=([0-9a-fA-F]{32})/.exec(href);
        const type = /[?&]collectionType=([a-z]+)/.exec(href);
        return id ? { id: id[1], music: !!type && type[1] === 'music' } : null;
    }

    function artistOf(item) {
        const a = item.AlbumArtist
            || (item.AlbumArtists && item.AlbumArtists[0] && item.AlbumArtists[0].Name)
            || (item.Artists && item.Artists[0])
            || item.Id;
        return String(a).trim().toLowerCase();
    }

    // Round-robin by artist, newest first within each. Map keeps first-seen order, which
    // is recency order, so the freshest artist still leads the row.
    function spreadArtists(items) {
        const byArtist = new Map();
        for (const it of items) {
            const k = artistOf(it);
            if (!byArtist.has(k)) byArtist.set(k, []);
            const list = byArtist.get(k);
            if (list.length < MAX_PER_ARTIST) list.push(it);
        }
        const out = [];
        for (let round = 0; round < MAX_PER_ARTIST; round++) {
            for (const list of byArtist.values()) if (list[round]) out.push(list[round]);
        }
        return out;
    }

    function deepFetch(lib, items, original) {
        return function () {
            items.__tunerFetched = true;
            const url = ApiClient.getUrl('Items/Latest', {
                userId: ApiClient.getCurrentUserId(),
                parentId: lib.id,
                limit: lib.music ? DEPTH_MUSIC : DEPTH,
                // Same fields Jellyfin's own row asks for, so the cards render identically.
                fields: 'PrimaryImageAspectRatio,Path',
                imageTypeLimit: 1,
                enableImageTypes: 'Primary,Backdrop,Thumb',
            });
            return ApiClient.getJSON(url)
                .then((items) => (lib.music && MIX_ARTISTS ? spreadArtists(items || []) : (items || [])))
                .catch(() => original());   // on any trouble, fall back to Jellyfin's own fetch
        };
    }

    // ---------- hooking rows ----------

    function adopt(section) {
        const items = section.querySelector('.itemsContainer');
        const scroller = section.querySelector('[is="emby-scroller"]');
        if (!items || !scroller || items.__tunerRow || typeof items.fetchData !== 'function') return;
        const lib = libraryFor(section);
        if (!lib) return;

        items.__tunerRow = true;
        const original = items.fetchData;
        items.fetchData = deepFetch(lib, items, original);

        const row = { section, items, scroller, hover: false, touched: 0, nextAt: 0 };
        const touch = () => { row.touched = Date.now(); };
        section.addEventListener('pointerenter', () => { row.hover = true; });
        section.addEventListener('pointerleave', () => { row.hover = false; });
        for (const ev of ['wheel', 'touchstart', 'pointerdown', 'keydown', 'focusin']) {
            section.addEventListener(ev, touch, { passive: true });
        }
        row.nextAt = Date.now() + STEP_MS + rows.filter((r) => r.section.isConnected).length * STAGGER_MS;
        rows.push(row);

        // The home module may already have fetched with the old function (it sets
        // fetchData and refreshes in the same pass), and that fetch may still be in
        // flight. So: if the first cards to land didn't come from our fetch, refresh
        // once and the deeper list replaces them.
        const refreshIfStale = () => {
            if (!items.__tunerFetched && typeof items.refreshItems === 'function') items.refreshItems();
        };
        if (items.querySelector('.card')) {
            refreshIfStale();
        } else {
            const first = new MutationObserver(() => {
                if (!items.querySelector('.card')) return;
                first.disconnect();
                refreshIfStale();
            });
            first.observe(items, { childList: true });
        }
    }

    function scan(root) {
        const scope = root && root.querySelectorAll ? root : document;
        scope.querySelectorAll('.homeSectionsContainer .verticalSection').forEach(adopt);
    }

    // ---------- sliding ----------

    function onScreen(el) {
        if (!el.isConnected || el.offsetParent === null) return false;
        const r = el.getBoundingClientRect();
        return r.bottom > 0 && r.top < window.innerHeight;
    }

    function advance(row) {
        const cards = row.items.querySelectorAll('.card');
        if (cards.length < 2 || typeof row.scroller.scrollToPosition !== 'function') return;
        const cardW = cards[0].offsetWidth;
        const viewW = row.scroller.clientWidth;
        if (!cardW || !viewW) return;
        const perPage = Math.max(1, Math.floor(viewW / cardW));
        const step = perPage * cardW;
        const max = Math.max(0, cards.length * cardW - viewW);
        if (max < cardW) return;   // everything already fits on screen
        const pos = Number(row.scroller.getScrollPosition()) || 0;
        // Snap to whole cards so a page never starts with half a poster.
        const next = pos >= max - 4 ? 0 : Math.min(Math.round(pos / cardW) * cardW + step, max);
        row.scroller.scrollToPosition(next, reduceMotion);
    }

    function tick() {
        if (document.hidden) return;
        const now = Date.now();
        for (let i = rows.length - 1; i >= 0; i--) {
            const row = rows[i];
            if (!row.section.isConnected) { rows.splice(i, 1); continue; }
            if (now < row.nextAt) continue;
            row.nextAt = now + STEP_MS;
            if (row.hover || now - row.touched < QUIET_AFTER_TOUCH_MS || !onScreen(row.section)) continue;
            try { advance(row); } catch (e) { /* never let a layout surprise break the page */ }
        }
    }

    // ---------- start ----------

    // The home page is rebuilt on every visit, so keep watching for new rows.
    new MutationObserver((muts) => {
        for (const m of muts) {
            for (const n of m.addedNodes) {
                if (n.nodeType === 1 && (n.matches('.verticalSection, .homeSectionsContainer') || n.querySelector('.verticalSection'))) {
                    scan(n.closest && n.closest('.homeSectionsContainer') ? n.closest('.homeSectionsContainer') : n);
                }
            }
        }
    }).observe(document.body, { childList: true, subtree: true });
    scan(document);
    setInterval(tick, 5000);
})();
