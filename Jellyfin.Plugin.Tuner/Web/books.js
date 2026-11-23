/*
 * Tuner Books (2026-11-23): a store-like page for books. Search Hardcover's catalog (millions
 * of books, with covers, ratings and series), open a book, press "Get it", and the server hands
 * it to Bookshelf, which finds a copy and downloads it into the library, the way Radarr does
 * for movies. The book's page then follows it: looking for a copy, downloading (with the file's
 * name, so a wrong match is easy to spot and turn down), and in the library, with Read.
 *
 * Views of one page, by address:
 *   #/tuner/books          shelves: In the library, Popular new books, Most read
 *   #/tuner/books?q=dune   search results
 *   #/tuner/books/427578   one book (Hardcover's id)
 *
 * tuner.js owns page switching, the top bar and the side menu, and calls show() whenever the
 * address changes while Books is open. This file only draws the page.
 *
 * Runs in Jellyfin Desktop's Chromium 83 too: no ??=, no CSS aspect-ratio or flex gap.
 */
(function () {
    'use strict';
    if (window.__tunerBooksLoaded) return;
    window.__tunerBooksLoaded = true;

    const ROUTE = '#/tuner/books';
    const POLL_BOOK_MS = 4000;     // a book's own page, while it's on its way
    const POLL_SHELF_MS = 10000;   // covers with a badge on their way
    const SEARCH_WAIT_MS = 650;    // typing pause before searching (Hardcover allows ~60 calls a minute)
    const OPEN = { searching: 1, downloading: 1, importing: 1 };

    const B = {
        page: null,
        sig: '',            // the view on screen, so repeated show() calls for it do nothing
        home: null,         // { at, data } the shelves, kept for coming back
        scroll: {},         // scroll position per view, restored on Back
        states: {},         // Hardcover id -> state, for everything on screen
        book: null,         // the open book's data
        poll: null,
        typing: null,
    };

    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const get = (path, params) => ApiClient.getJSON(ApiClient.getUrl(path, params));
    const post = (path) => ApiClient.ajax({ type: 'POST', url: ApiClient.getUrl(path), dataType: 'json' });
    const toast = (msg) => (window.Tuner && window.Tuner.toast ? window.Tuner.toast(msg) : null);
    const num = (n) => Number(n || 0).toLocaleString();
    const $ = (sel, root) => (root || document).querySelector(sel);

    // A failed ApiClient call rejects with the Response; our endpoints put a readable
    // "message" in the body.
    async function errorText(e, fallback) {
        try {
            if (e && typeof e.json === 'function') {
                const body = await e.json();
                if (body && body.message) return body.message;
            }
        } catch (x) { /* not JSON */ }
        return fallback;
    }

    function parse(hash) {
        const rest = hash.slice(ROUTE.length);
        const m = /^\/(\d+)/.exec(rest);
        if (m) return { view: 'book', id: parseInt(m[1], 10) };
        const q = /[?&]q=([^&]*)/.exec(rest);
        if (q && decodeURIComponent(q[1]).trim()) return { view: 'search', q: decodeURIComponent(q[1]).trim() };
        return { view: 'home' };
    }

    // In-page moves use pushState: a plain hash change makes Jellyfin's router draw its
    // "Page not found" over ours.
    function goTo(hash, replace) {
        if (location.hash === hash) return;
        B.scroll[B.sig] = window.scrollY;
        // inner: this step was taken inside Books, so Back can simply go back to it.
        if (replace) history.replaceState({ page: 'tuner-books', inner: !!(history.state && history.state.inner) }, 'Books', hash);
        else history.pushState({ page: 'tuner-books', inner: true }, 'Books', hash);
        show(B.page, hash);
    }

    // =====================================================================
    // The page
    // =====================================================================

    async function show(page, hash) {
        B.page = page;
        const wrap = $('.tnr-wrap', page);
        if (!$('.tnr-books', wrap)) {
            wrap.innerHTML = `<div class="tnr-books">
                <form class="tnr-bk-search" role="search" autocomplete="off">
                    <span class="material-icons" aria-hidden="true">search</span>
                    <input type="search" placeholder="Search for a book, author or series" aria-label="Search books" maxlength="120">
                    <button type="button" class="tnr-bk-clear" aria-label="Clear search" hidden><span class="material-icons" aria-hidden="true">close</span></button>
                </form>
                <div class="tnr-bk-body"></div>
            </div>`;
            bindSearch(wrap);
        }
        const r = parse(hash || ROUTE);
        const sig = JSON.stringify(r);
        if (sig === B.sig) return;
        const from = B.sig;
        B.sig = sig;
        stopPoll();
        const input = $('.tnr-bk-search input', wrap);
        if (document.activeElement !== input) input.value = r.q || '';
        $('.tnr-bk-clear', wrap).hidden = !input.value;
        const body = $('.tnr-bk-body', wrap);
        try {
            if (r.view === 'book') await renderBook(body, r.id);
            else if (r.view === 'search') await renderSearch(body, r.q);
            else await renderHome(body);
        } catch (e) {
            if (B.sig !== sig) return;
            body.innerHTML = `<div class="tnr-empty">${esc(await errorText(e, 'Couldn’t load books right now. Try again in a minute.'))}</div>`;
            return;
        }
        if (B.sig !== sig) return;
        // Back to a list: where you were. A new view: the top.
        const back = B.scroll[sig];
        window.scrollTo(0, r.view !== 'book' && back != null && from && JSON.parse(from).view === 'book' ? back : 0);
        startPoll();
    }

    function leave() {
        stopPoll();
        B.sig = '';
    }

    function bindSearch(wrap) {
        const form = $('.tnr-bk-search', wrap);
        const input = $('input', form);
        const clear = $('.tnr-bk-clear', form);
        const run = () => {
            clearTimeout(B.typing);
            const q = input.value.trim();
            const hash = q ? `${ROUTE}?q=${encodeURIComponent(q)}` : ROUTE;
            // Typing refines the same search (replace); starting one from elsewhere is a new step.
            goTo(hash, parse(location.hash).view === 'search');
        };
        form.addEventListener('submit', (e) => { e.preventDefault(); run(); });
        input.addEventListener('input', () => {
            clear.hidden = !input.value;
            clearTimeout(B.typing);
            if (input.value.trim().length >= 3) B.typing = setTimeout(run, SEARCH_WAIT_MS);
        });
        clear.addEventListener('click', () => { input.value = ''; clear.hidden = true; input.focus(); goTo(ROUTE); });
    }

    // =====================================================================
    // Shelves and results
    // =====================================================================

    async function renderHome(body) {
        const sig = B.sig;
        // Shelves come back from Back without a wait; refreshed after two minutes.
        if (!B.home || Date.now() - B.home.at > 120000) {
            if (!B.home) body.innerHTML = '<div class="tnr-empty">Loading books…</div>';
            B.home = { at: Date.now(), data: await get('Tuner/books/home') };
        }
        if (B.sig !== sig) return;
        const data = B.home.data;
        if (!data.enabled) { body.innerHTML = '<div class="tnr-empty">Books isn’t set up on this server.</div>'; return; }
        Object.assign(B.states, data.states || {});
        const shelves = (data.shelves || []).filter((s) => s.books && s.books.length);
        body.innerHTML = shelves.length
            ? shelves.map((s) => `<section class="tnr-bk-shelf">
                    <h2>${esc(s.title)}</h2>
                    <div class="tnr-bk-row">${s.books.map(cardHtml).join('')}</div>
                </section>`).join('')
            : '<div class="tnr-empty">Search for a book above to get started.</div>';
        bindCards(body);
    }

    async function renderSearch(body, q) {
        const sig = B.sig;
        body.innerHTML = '<div class="tnr-empty">Searching…</div>';
        const data = await get('Tuner/books/search', { q });
        if (B.sig !== sig) return;
        if (data.enabled === false) { body.innerHTML = '<div class="tnr-empty">Books isn’t set up on this server.</div>'; return; }
        Object.assign(B.states, data.states || {});
        const list = data.books || [];
        body.innerHTML = list.length
            ? `<h2 class="tnr-bk-head">Results for “${esc(q)}”</h2><div class="tnr-bk-grid">${list.map(cardHtml).join('')}</div>`
            : `<div class="tnr-empty">No books found for “${esc(q)}”. Try the title alone, or the author’s last name.</div>`;
        bindCards(body);
    }

    function coverHtml(book, big) {
        // The title on a plain cover stands in when Hardcover has no picture (or it fails).
        const plain = `<div class="tnr-bk-plain"><span>${esc(book.title)}</span><small>${esc(book.authors)}</small></div>`;
        return book.cover
            ? `<img src="${esc(book.cover)}" alt="" loading="${big ? 'eager' : 'lazy'}" referrerpolicy="no-referrer">${plain}`
            : plain;
    }

    function cardHtml(b) {
        const series = b.series ? `${b.series}${b.seriesPosition ? ` #${b.seriesPosition}` : ''}` : '';
        return `<a class="tnr-bk-card" href="${ROUTE}/${b.id}" data-id="${b.id}" title="${esc(b.title)}${b.authors ? ` by ${esc(b.authors)}` : ''}">
            <div class="tnr-bk-cover${b.cover ? '' : ' none'}">${coverHtml(b)}${badgeHtml(B.states[b.id])}</div>
            <div class="tnr-bk-title">${esc(b.title)}</div>
            <div class="tnr-bk-author">${esc(b.authors || series)}</div>
        </a>`;
    }

    function badgeHtml(st) {
        if (!st) return '';
        if (st.state === 'have') return '<span class="tnr-bk-badge have" title="In the library"><span class="material-icons" aria-hidden="true">check</span></span>';
        if (st.state === 'downloading') return `<span class="tnr-bk-badge" title="Downloading">${Math.round((st.progress || 0) * 100)}%</span>`;
        if (st.state === 'problem') return '<span class="tnr-bk-badge bad" title="Stuck">!</span>';
        return '<span class="tnr-bk-badge" title="On its way"><span class="material-icons" aria-hidden="true">schedule</span></span>';
    }

    function bindCards(root) {
        root.querySelectorAll('.tnr-bk-card').forEach((a) => {
            a.addEventListener('click', (e) => {
                if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
                e.preventDefault();
                goTo(a.getAttribute('href'));
            });
        });
        bindCovers(root);
    }

    // A cover that fails to load shows the plain title cover under it instead.
    function bindCovers(root) {
        root.querySelectorAll('.tnr-bk-cover img, .tnr-bk-bigcover img').forEach((img) => {
            const fail = () => { img.parentNode.classList.add('none'); img.remove(); };
            if (img.complete && !img.naturalWidth) fail();
            else img.addEventListener('error', fail);
        });
    }

    // =====================================================================
    // One book
    // =====================================================================

    async function renderBook(body, id) {
        const sig = B.sig;
        body.innerHTML = '<div class="tnr-empty">Loading…</div>';
        const data = await get(`Tuner/books/${id}`);
        if (B.sig !== sig) return;
        if (data.enabled === false) { body.innerHTML = '<div class="tnr-empty">Books isn’t set up on this server.</div>'; return; }
        const b = data.book;
        B.book = { id, read: data.read, title: b.title };
        if (data.state) B.states[id] = data.state; else delete B.states[id];
        const meta = [b.year, b.pages ? `${num(b.pages)} pages` : '',
            b.rating ? `<span class="tnr-bk-stars" aria-label="Rated ${b.rating} out of 5">★ ${b.rating}</span> <span class="tnr-bk-dim">(${num(b.ratings)} ratings)</span>` : '']
            .filter(Boolean).join('<span class="tnr-bk-dot">·</span>');
        const paras = String(b.description || '').split(/\n\s*\n|\n/).map((p) => p.trim()).filter(Boolean);
        body.innerHTML = `<div class="tnr-bk-detail">
            <button type="button" class="tnr-bk-back"><span class="material-icons" aria-hidden="true">arrow_back</span>Back</button>
            <div class="tnr-bk-hero">
                <div class="tnr-bk-bigcover${b.cover ? '' : ' none'}">${coverHtml(b, true)}</div>
                <div class="tnr-bk-info">
                    <h1>${esc(b.title)}</h1>
                    ${b.subtitle ? `<div class="tnr-bk-sub">${esc(b.subtitle)}</div>` : ''}
                    ${b.authors ? `<div class="tnr-bk-by">by <a href="#" data-find="${esc(b.authors.split(' and ')[0].split(',')[0])}">${esc(b.authors)}</a></div>` : ''}
                    ${b.series ? `<div class="tnr-bk-series">${b.seriesPosition ? `Book ${esc(b.seriesPosition)} of ` : 'Part of '}<a href="#" data-find="${esc(b.series)}">${esc(b.series)}</a></div>` : ''}
                    ${meta ? `<div class="tnr-bk-meta">${meta}</div>` : ''}
                    <div class="tnr-bk-action" aria-live="polite"></div>
                    ${b.genres && b.genres.length ? `<div class="tnr-bk-genres">${b.genres.map((g) => `<span>${esc(g)}</span>`).join('')}</div>` : ''}
                    ${paras.length ? `<div class="tnr-bk-desc">${paras.map((p) => `<p>${esc(p)}</p>`).join('')}</div>
                        <button type="button" class="tnr-bk-more" hidden>More</button>` : ''}
                </div>
            </div>
        </div>`;
        bindCovers(body);
        $('.tnr-bk-back', body).addEventListener('click', () => {
            // Back where you came from if that was Books; otherwise the shelves.
            if (history.state && history.state.inner) history.back();
            else goTo(ROUTE);
        });
        body.querySelectorAll('[data-find]').forEach((a) => a.addEventListener('click', (e) => {
            e.preventDefault();
            goTo(`${ROUTE}?q=${encodeURIComponent(a.dataset.find)}`);
        }));
        const desc = $('.tnr-bk-desc', body);
        const more = $('.tnr-bk-more', body);
        if (desc && more) {
            // Only offer "More" when the text is actually cut off.
            requestAnimationFrame(() => {
                if (desc.scrollHeight > desc.clientHeight + 4) { more.hidden = false; desc.classList.add('cut'); }
            });
            more.addEventListener('click', () => { desc.classList.add('open'); more.hidden = true; });
        }
        renderAction();
    }

    // The button area under the title, from the book's state.
    function renderAction() {
        const box = B.page && $('.tnr-bk-action', B.page);
        if (!box || !B.book) return;
        const st = B.states[B.book.id];
        const state = st ? st.state : 'none';
        let html;
        if (state === 'have') {
            html = (B.book.read
                ? `<a class="tnr-bk-btn primary" href="${esc(B.book.read)}" target="_blank" rel="noopener"><span class="material-icons" aria-hidden="true">auto_stories</span>Read</a>`
                : '')
                + `<div class="tnr-bk-status have"><span class="material-icons" aria-hidden="true">check_circle</span>In the library</div>`
                + (B.book.read ? '<div class="tnr-bk-hint">A new book can take a few minutes to show up in the reader.</div>' : '');
        } else if (state === 'downloading' || state === 'problem') {
            const pct = Math.round((st.progress || 0) * 100);
            html = state === 'problem'
                ? `<div class="tnr-bk-status bad"><span class="material-icons" aria-hidden="true">error_outline</span>Stuck: ${esc(st.message || 'the download has a problem')}</div>`
                : `<div class="tnr-bk-status"><span class="material-icons tnr-bk-spin" aria-hidden="true">downloading</span>Downloading, ${pct}%</div>
                   <div class="tnr-bk-bar"><span style="width:${pct}%"></span></div>`;
            html += `${st.release ? `<div class="tnr-bk-hint">File: ${esc(st.release)}</div>` : ''}
                <button type="button" class="tnr-bk-link" data-do="retry">Wrong book? Try another copy</button>`;
        } else if (state === 'importing') {
            html = '<div class="tnr-bk-status"><span class="material-icons tnr-bk-spin" aria-hidden="true">autorenew</span>Adding it to the library…</div>';
        } else if (state === 'searching') {
            html = '<div class="tnr-bk-status"><span class="material-icons tnr-bk-spin" aria-hidden="true">autorenew</span>Looking for a copy…</div>';
        } else if (state === 'missing') {
            html = `<div class="tnr-bk-status"><span class="material-icons" aria-hidden="true">hourglass_empty</span>No copy found yet</div>
                <div class="tnr-bk-hint">It keeps checking and grabs one when it turns up.</div>
                <button type="button" class="tnr-bk-btn" data-do="get">Look again</button>`;
        } else {
            html = `<button type="button" class="tnr-bk-btn primary" data-do="get"><span class="material-icons" aria-hidden="true">add</span>Get it</button>
                <div class="tnr-bk-hint">Adds it to the library. Usually takes a few minutes.</div>`;
        }
        box.innerHTML = html;
        const read = $('a.tnr-bk-btn', box);
        // The desktop and phone apps can't open new windows: hand the address to the system browser.
        if (read) {
            read.addEventListener('click', (e) => {
                if (window.NativeShell && typeof window.NativeShell.openUrl === 'function') {
                    e.preventDefault();
                    window.NativeShell.openUrl(read.href, '_blank');
                }
            });
        }
        box.querySelectorAll('[data-do]').forEach((btn) => btn.addEventListener('click', () => act(btn, btn.dataset.do)));
    }

    async function act(btn, what) {
        if (!B.book || btn.disabled) return;
        const id = B.book.id;
        btn.disabled = true;
        try {
            const res = await post(`Tuner/books/${id}/${what === 'retry' ? 'retry' : 'get'}`);
            if (res && res.state) B.states[id] = res.state;
            else if (what === 'retry') B.states[id] = { state: 'searching' };
            if (res && res.message) toast(res.message);
            // The shelves' badges are stale now; the next visit fetches them again.
            B.home = null;
        } catch (e) {
            toast(await errorText(e, 'That didn’t work. Try again in a minute.'));
        }
        btn.disabled = false;
        if (B.book && B.book.id === id) renderAction();
        startPoll();
    }

    // =====================================================================
    // Following books on their way
    // =====================================================================

    function onScreen() {
        if (!B.page) return [];
        if (parse(location.hash).view === 'book' && B.book) return [B.book.id];
        return Array.from(B.page.querySelectorAll('.tnr-bk-card')).map((a) => parseInt(a.dataset.id, 10));
    }

    function startPoll() {
        stopPoll();
        const ids = onScreen();
        if (!ids.some((id) => B.states[id] && OPEN[B.states[id].state])) return;
        const isBook = parse(location.hash).view === 'book';
        B.poll = setTimeout(async () => {
            B.poll = null;
            const sig = B.sig;
            try {
                const states = await get('Tuner/books/states', { ids: ids.join(',') });
                if (B.sig !== sig) return;
                ids.forEach((id) => { if (states[id]) B.states[id] = states[id]; else delete B.states[id]; });
                if (isBook) renderAction();
                else {
                    B.page.querySelectorAll('.tnr-bk-card').forEach((a) => {
                        const cover = $('.tnr-bk-cover', a);
                        const old = $('.tnr-bk-badge', cover);
                        if (old) old.remove();
                        cover.insertAdjacentHTML('beforeend', badgeHtml(B.states[a.dataset.id]));
                    });
                }
            } catch (e) { /* try again next round */ }
            if (B.sig === sig) startPoll();
        }, isBook ? POLL_BOOK_MS : POLL_SHELF_MS);
    }

    function stopPoll() {
        clearTimeout(B.poll);
        B.poll = null;
    }

    window.TunerBooks = { route: ROUTE, show, leave };
})();
