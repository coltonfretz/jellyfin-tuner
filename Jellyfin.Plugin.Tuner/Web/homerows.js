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
 *   4. Movie libraries' rows become a carousel (data-carousel): five or so posters with
 *      the middle one bigger, stepping one poster at a time, so the next one slides into
 *      the middle and the first slides off the left. WHY (Fretzflix, 2026-11-24): a
 *      whole-screen jump every two minutes was easy to miss and felt abrupt.
 *   5. Rows take turns by shape (data-arrange): the home page used to open with four
 *      rows of wide pictures in a row (My Media, Continue Watching, On Now, Next Up),
 *      then a run of posters. CSS order only: the rows stay where Jellyfin put them.
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
    const CAROUSEL = !!me && me.dataset.carousel === '1';
    const ARRANGE = !!me && me.dataset.arrange === '1';
    const CAROUSEL_MS = 8000;             // one step every 8 s while nobody is using it
    const CAROUSEL_QUIET_MS = 30000;      // and not for 30 s after someone does
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
        return id ? { id: id[1], music: !!type && type[1] === 'music', movies: !!type && type[1] === 'movies' } : null;
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

    function deepFetch(lib, items, original, onItems) {
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
                .then((items) => { if (onItems) onItems(items); return items; })
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
        const carousel = CAROUSEL && lib.movies ? makeCarousel(section) : null;
        items.fetchData = deepFetch(lib, items, original, carousel && carousel.setItems);

        const row = { section, items, scroller, carousel, hover: false, touched: 0, nextAt: 0 };
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
        if (row.carousel) return;   // it steps on its own clock
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
            if (row.carousel && row.carousel.tick) { try { row.carousel.tick(now); } catch (e) { /* as below */ } continue; }
            if (now < row.nextAt) continue;
            row.nextAt = now + STEP_MS;
            if (row.hover || now - row.touched < QUIET_AFTER_TOUCH_MS || !onScreen(row.section)) continue;
            try { advance(row); } catch (e) { /* never let a layout surprise break the page */ }
        }
    }

    // ---------- carousel (movie libraries) ----------
    //
    // Our own posters over Jellyfin's row, which stays in the page (hidden) so its refreshes
    // keep feeding us items. Every poster sits at the same spot and is moved with transform
    // only (cheap to animate): slot 0 is the big one in the middle, slots -1/+1 beside it,
    // and so on out to however many fit. Moving one step changes each poster's slot by one
    // and the CSS transition slides them. Posters past the edges wait just off-screen,
    // invisible, so the next one slides in from the right.

    const SIDE = [1, 0.74, 0.6];          // size by distance from the middle (then stays 0.6)
    const GAP = 16;

    function makeCarousel(section) {
        const c = { items: [], center: 0, els: [], slots: [], hover: false, touched: 0, nextAt: 0, k: 2, geo: null };
        const box = document.createElement('div');
        box.className = 'tnr-cf';
        box.tabIndex = 0;
        box.setAttribute('role', 'region');
        box.setAttribute('aria-roledescription', 'carousel');
        const title = section.querySelector('.sectionTitle');
        box.setAttribute('aria-label', title ? title.textContent.trim() : 'Recently added');
        box.innerHTML = '<div class="tnr-cf-stage"></div>'
            + '<button type="button" class="tnr-cf-arrow tnr-cf-prev" aria-label="Previous"><span class="material-icons" aria-hidden="true">chevron_left</span></button>'
            + '<button type="button" class="tnr-cf-arrow tnr-cf-next" aria-label="Next"><span class="material-icons" aria-hidden="true">chevron_right</span></button>'
            + '<div class="tnr-cf-caption" aria-live="polite"><a class="tnr-cf-title"></a><div class="tnr-cf-sub"></div></div>';
        const stage = box.querySelector('.tnr-cf-stage');
        const scroller = section.querySelector('[is="emby-scroller"]');
        section.classList.add('tnr-cf-row');
        section.insertBefore(box, scroller);

        const href = (it) => `#/details?id=${it.Id}&serverId=${it.ServerId || ApiClient.serverId()}`;
        const img = (it) => (it.ImageTags && it.ImageTags.Primary
            ? ApiClient.getUrl(`Items/${it.Id}/Images/Primary`, { tag: it.ImageTags.Primary, maxHeight: 640, quality: 90 }) : '');
        const slotOf = (i) => {
            const n = c.items.length;
            let d = ((i - c.center) % n + n) % n;
            if (d > n / 2) d -= n;
            return d;
        };

        function measure() {
            const w = stage.clientWidth;
            if (!w) return false;
            // Five across if the middle poster can be at least 150 px wide, else three.
            let cw = (w - 4 * GAP) / (SIDE[0] + 2 * SIDE[1] + 2 * SIDE[2]);
            if (cw < 150) cw = (w - 2 * GAP) / (SIDE[0] + 2 * SIDE[1]);
            cw = Math.min(cw, 250);
            const size = (d) => SIDE[Math.min(Math.abs(d), SIDE.length - 1)];
            // Center x of each slot, out until a poster would hang off the edge.
            const xs = { 0: 0 };
            let k = 0;
            for (let d = 1; d < 12; d++) {
                xs[d] = xs[d - 1] + (cw * size(d - 1) + cw * size(d)) / 2 + GAP;
                xs[-d] = -xs[d];
                if (xs[d] + cw * size(d) / 2 <= w / 2 + 1) k = d;
                else break;
            }
            k = Math.max(1, k);
            // One more slot each side for posters waiting off-screen.
            xs[k + 1] = Math.max(xs[k + 1] || 0, w / 2 + cw * size(k + 1) / 2 + GAP);
            xs[-(k + 1)] = -xs[k + 1];
            c.k = k;
            c.geo = { w, cw, xs, size };
            stage.style.height = Math.round(cw * 1.5) + 'px';
            box.querySelectorAll('.tnr-cf-arrow').forEach((b) => { b.style.top = Math.round(cw * 0.75) + 'px'; });
            return true;
        }

        function place(jumpAll) {
            if (!c.items.length || (!c.geo && !measure())) return;
            const { w, cw, xs, size } = c.geo;
            c.els.forEach((el, i) => {
                const d = slotOf(i);
                const far = Math.abs(d) > c.k + 1;
                const dd = far ? Math.sign(d) * (c.k + 1) : d;
                const prev = c.slots[i];
                // A poster coming round from the far side is invisible: no slide across.
                const jump = jumpAll || prev == null || Math.abs(prev - dd) > 1;
                el.classList.toggle('tnr-cf-jump', jump);
                const sc = size(dd);
                el.style.transform = `translate3d(${(w / 2 + xs[dd] - cw / 2).toFixed(1)}px,0,0) scale(${sc})`;
                el.style.opacity = Math.abs(dd) > c.k ? '0' : String(dd === 0 ? 1 : Math.abs(dd) === 1 ? 0.8 : 0.5);
                el.style.zIndex = String(20 - Math.abs(dd));
                el.classList.toggle('tnr-cf-mid', dd === 0);
                el.tabIndex = dd === 0 ? 0 : -1;
                el.setAttribute('aria-hidden', Math.abs(dd) > c.k ? 'true' : 'false');
                // Load pictures only for posters that are, or are about to be, on screen.
                const im = el.firstChild;
                if (Math.abs(dd) <= c.k + 1 && !far && !im.src && im.dataset.src) im.src = im.dataset.src;
                el.style.width = cw + 'px';
                el.style.height = Math.round(cw * 1.5) + 'px';
                c.slots[i] = dd;
            });
            // Let the jumps land without a transition, then allow slides again.
            stage.offsetWidth;   // eslint-disable-line no-unused-expressions
            c.els.forEach((el) => el.classList.remove('tnr-cf-jump'));
            const it = c.items[c.center];
            const t = box.querySelector('.tnr-cf-title');
            t.textContent = it.Name || '';
            t.href = href(it);
            const mins = it.RunTimeTicks ? Math.round(it.RunTimeTicks / 6e8) : 0;
            box.querySelector('.tnr-cf-sub').textContent = [it.ProductionYear, it.OfficialRating,
                mins ? (mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`) : ''].filter(Boolean).join(' · ');
        }

        function step(n) {
            if (!c.items.length) return;
            c.center = ((c.center + n) % c.items.length + c.items.length) % c.items.length;
            place(false);
        }

        c.setItems = (items) => {
            items = (items || []).filter((it) => it && it.Id);
            const keep = c.items[c.center] && items.findIndex((it) => it.Id === c.items[c.center].Id);
            c.items = items;
            c.center = keep > 0 ? keep : 0;
            c.slots = [];
            stage.innerHTML = '';
            c.els = items.map((it) => {
                const a = document.createElement('a');
                a.className = 'tnr-cf-item';
                a.href = href(it);
                a.title = it.Name || '';
                a.draggable = false;
                const im = document.createElement('img');
                im.alt = it.Name || '';
                im.decoding = 'async';
                im.draggable = false;
                im.dataset.src = img(it);
                im.addEventListener('load', () => a.classList.add('tnr-cf-loaded'));
                a.appendChild(im);
                stage.appendChild(a);
                return a;
            });
            // Too few for a carousel: Jellyfin's own row instead.
            section.classList.toggle('tnr-cf-row', items.length >= 5);
            c.geo = null;
            c.nextAt = Date.now() + CAROUSEL_MS;
            place(true);
        };

        const touch = () => { c.touched = Date.now(); };
        box.querySelector('.tnr-cf-prev').addEventListener('click', () => { touch(); step(-1); });
        box.querySelector('.tnr-cf-next').addEventListener('click', () => { touch(); step(1); });
        stage.addEventListener('click', (e) => {
            const a = e.target.closest('.tnr-cf-item');
            if (!a) return;
            touch();
            // A side poster comes to the middle; the middle one opens.
            if (c.swiped || !a.classList.contains('tnr-cf-mid')) {
                e.preventDefault();
                if (!c.swiped) step(slotOf(c.els.indexOf(a)));
            }
            c.swiped = false;
        });
        box.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                e.preventDefault();
                e.stopPropagation();
                touch();
                step(e.key === 'ArrowRight' ? 1 : -1);
            }
        });
        // Swipe: a sideways drag of 40 px or more steps once per poster width.
        let down = null;
        stage.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; c.swiped = false; });
        stage.addEventListener('pointerup', (e) => {
            if (!down || !c.geo) return;
            const dx = e.clientX - down.x;
            down = null;
            if (Math.abs(dx) < 40) return;
            touch();
            c.swiped = true;
            step(-Math.sign(dx) * Math.max(1, Math.round(Math.abs(dx) / (c.geo.cw * 0.8))));
        });
        box.addEventListener('pointerenter', () => { c.hover = true; });
        box.addEventListener('pointerleave', () => { c.hover = false; });
        box.addEventListener('focusin', touch);
        if (window.ResizeObserver) new ResizeObserver(() => { c.geo = null; place(true); }).observe(stage);

        c.tick = (now) => {
            if (now < c.nextAt) return;
            c.nextAt = now + CAROUSEL_MS;
            if (c.hover || now - c.touched < CAROUSEL_QUIET_MS || !onScreen(box) || box.contains(document.activeElement)) return;
            step(1);
        };
        return c;
    }

    // ---------- rows take turns by shape ----------
    //
    // The order is picked again whenever a row fills in or empties (Continue Watching comes
    // and goes). The first row stays first; after that, the next row is the first one in
    // Jellyfin's order whose shape differs from the row above it, if there is one.

    function shapeOf(row) {
        if (row.classList.contains('hide') || row.offsetHeight === 0) return null;
        if (row.classList.contains('tnr-cf-row') || row.querySelector('.tnr-cf-row')) return 'carousel';
        const card = row.querySelector('.card');
        if (!card) return null;
        const k = card.className;
        if (/backdrop|thumb|banner/i.test(k)) return 'wide';
        if (/square/i.test(k)) return 'square';
        if (/portrait/i.test(k)) return 'portrait';
        return 'other';
    }

    function arrange(container) {
        if (document.documentElement.classList.contains('layout-tv')) return;
        // Latest rows live together in one wrapper; flatten it so each can move on its own.
        const units = [];
        Array.from(container.children).forEach((sec) => {
            const latest = Array.from(sec.children).filter((r) => r.classList.contains('verticalSection')
                && r.querySelector('a.sectionTitleTextButton[href*="topParentId="]'));
            if (!sec.classList.contains('verticalSection') && latest.length && latest.length === sec.children.length) {
                sec.classList.add('tnr-flat');
                latest.forEach((r) => units.push(r));
            } else {
                units.push(sec);
            }
        });
        const shown = units.map((u) => ({ u, shape: shapeOf(u) })).filter((x) => x.shape);
        const out = shown.length ? [shown.shift()] : [];
        while (shown.length) {
            const prev = out[out.length - 1].shape;
            let i = shown.findIndex((x) => x.shape !== prev);
            if (i < 0) i = 0;
            out.push(shown.splice(i, 1)[0]);
        }
        const pos = new Map(out.map((x, i) => [x.u, i]));
        // Hidden rows keep Jellyfin's order after the shown ones; they take no space.
        units.forEach((u, i) => { u.style.order = String(pos.has(u) ? pos.get(u) : 100 + i); });
        container.classList.add('tnr-arranged');
    }

    let arrangeTimer = null;
    function arrangeSoon() {
        if (!ARRANGE) return;
        clearTimeout(arrangeTimer);
        arrangeTimer = setTimeout(() => {
            document.querySelectorAll('.homeSectionsContainer').forEach((c) => { try { arrange(c); } catch (e) { /* leave Jellyfin's order */ } });
        }, 150);
    }

    // ---------- start ----------

    // The home page is rebuilt on every visit, so keep watching for new rows.
    new MutationObserver((muts) => {
        if (ARRANGE && muts.some((m) => m.target.closest && m.target.closest('.homeSectionsContainer') && !m.target.closest('.tnr-cf'))) arrangeSoon();
        for (const m of muts) {
            for (const n of m.addedNodes) {
                if (n.nodeType === 1 && (n.matches('.verticalSection, .homeSectionsContainer') || n.querySelector('.verticalSection'))) {
                    scan(n.closest && n.closest('.homeSectionsContainer') ? n.closest('.homeSectionsContainer') : n);
                }
            }
        }
    }).observe(document.body, { childList: true, subtree: true, attributes: ARRANGE, attributeFilter: ARRANGE ? ['class'] : undefined });
    scan(document);
    arrangeSoon();
    setInterval(tick, 1000);
})();
