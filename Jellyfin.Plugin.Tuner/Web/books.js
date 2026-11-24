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
 *   #/tuner/books/author/123645   one author's books, most read first
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
        const a = /^\/author\/(\d+)/.exec(rest);
        if (a) return { view: 'author', id: parseInt(a[1], 10) };
        const m = /^\/(\d+)/.exec(rest);
        if (m) return { view: 'book', id: parseInt(m[1], 10) };
        const q = /[?&]q=([^&]*)/.exec(rest);
        const text = q ? decodeURIComponent(q[1]).trim() : '';
        // One or two letters: too short to search (and old results would just sit there).
        if (text) return { view: text.length < 3 ? 'short' : 'search', q: text };
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
                    <input type="search" placeholder="Search books or authors" aria-label="Search books, authors or series" maxlength="120">
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
            else if (r.view === 'author') await renderAuthor(body, r.id);
            else if (r.view === 'search') await renderSearch(body, r.q);
            else if (r.view === 'short') body.innerHTML = '<div class="tnr-empty">Keep typing: at least 3 letters to search.</div>';
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
        bindRows(body);
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
            const v = parse(location.hash).view;
            goTo(hash, v === 'search' || v === 'short');
        };
        form.addEventListener('submit', (e) => { e.preventDefault(); run(); });
        input.addEventListener('input', () => {
            clear.hidden = !input.value;
            clearTimeout(B.typing);
            // Emptying the box brings the shelves back, and a letter or two says "keep typing",
            // instead of old results staying on screen (new-user test, 2026-11-23).
            const n = input.value.trim().length;
            if (n >= 3) B.typing = setTimeout(run, SEARCH_WAIT_MS);
            else if (n > 0 || parse(location.hash).view !== 'home') B.typing = setTimeout(run, 300);
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
        // One line for newcomers: what these are and what the check mark means.
        const intro = '<p class="tnr-bk-intro">Ebooks to read in your browser. Books with a <span class="material-icons" aria-hidden="true">check_circle</span> are in the library; open any other book to add it.</p>';
        body.innerHTML = intro + (shelves.length
            ? shelves.map((s) => `<section class="tnr-bk-shelf">
                    <h2>${esc(s.title)}</h2>
                    <div class="tnr-bk-rowwrap">
                        <button type="button" class="tnr-bk-arrow prev" aria-label="Scroll left" hidden><span class="material-icons" aria-hidden="true">chevron_left</span></button>
                        <div class="tnr-bk-row">${s.books.map(cardHtml).join('')}</div>
                        <button type="button" class="tnr-bk-arrow next" aria-label="Scroll right" hidden><span class="material-icons" aria-hidden="true">chevron_right</span></button>
                    </div>
                </section>`).join('')
            : '<div class="tnr-empty">Search for a book above to get started.</div>');
        bindCards(body);
    }

    // Shelf arrows. WHY: a mouse wheel scrolls the page, not the shelf, and the scrollbar is
    // thin, so on a laptop 23 of a shelf's 30 books were out of reach (new-user test,
    // 2026-11-23). Each arrow shows only when there's more that way; touch still swipes.
    function bindRows(root) {
        root.querySelectorAll('.tnr-bk-rowwrap').forEach((wrap) => {
            const row = $('.tnr-bk-row', wrap);
            const prev = $('.tnr-bk-arrow.prev', wrap);
            const next = $('.tnr-bk-arrow.next', wrap);
            const update = () => {
                prev.hidden = row.scrollLeft < 8;
                next.hidden = row.scrollLeft + row.clientWidth >= row.scrollWidth - 8;
            };
            const step = (dir) => row.scrollBy({ left: dir * Math.max(200, row.clientWidth * 0.85), behavior: 'smooth' });
            prev.addEventListener('click', () => step(-1));
            next.addEventListener('click', () => step(1));
            row.addEventListener('scroll', update, { passive: true });
            wrap.tnrUpdate = update;
            update();
        });
    }
    // One listener for every shelf on screen, rather than one more per shelf each time it's drawn.
    window.addEventListener('resize', () => {
        if (B.page) B.page.querySelectorAll('.tnr-bk-rowwrap').forEach((w) => w.tnrUpdate && w.tnrUpdate());
    });

    async function renderAuthor(body, id) {
        const sig = B.sig;
        body.innerHTML = '<div class="tnr-empty">Loading…</div>';
        const data = await get(`Tuner/books/author/${id}`);
        if (B.sig !== sig) return;
        if (data.enabled === false) { body.innerHTML = '<div class="tnr-empty">Books isn’t set up on this server.</div>'; return; }
        Object.assign(B.states, data.states || {});
        const list = data.books || [];
        body.innerHTML = `<button type="button" class="tnr-bk-back"><span class="material-icons" aria-hidden="true">arrow_back</span>Back</button>`
            + (list.length
                ? `<h2 class="tnr-bk-head">Books by ${esc(data.name || 'this author')}</h2><div class="tnr-bk-grid">${list.map(cardHtml).join('')}</div>`
                : '<div class="tnr-empty">No books found for this author.</div>');
        bindBack(body);
        bindCards(body);
    }

    function bindBack(body) {
        $('.tnr-bk-back', body).addEventListener('click', () => {
            // Back where you came from if that was Books; otherwise the shelves.
            if (history.state && history.state.inner) history.back();
            else goTo(ROUTE);
        });
    }

    // Hardcover's subtitle comes from whichever edition it shows, so Dune said "Teacher's Book"
    // and Pride and Prejudice "6-Volume Set" (new-user test, 2026-11-23). Edition and format
    // words are dropped; real subtitles ("A Novel", "Or, the Modern Prometheus") stay.
    const EDITION_WORDS = /\b(edition|volumes?|vol\.|set|teacher'?s|student'?s|workbook|study guide|annotated|illustrated|unabridged|abridged|box(ed)?|collector'?s|deluxe|anniversary|classics?|paperback|hardcover|large print|graphic novel|book \d+|\d+-volume|movie tie-in|tie-in|reprint|penguin|signet|bantam|vintage|oxford|norton|wordsworth)\b/i;
    const goodSubtitle = (sub, title) => sub && !EDITION_WORDS.test(sub) && sub.toLowerCase() !== String(title).toLowerCase();

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
        const series = b.series ? `${b.series}${b.seriesPosition && b.seriesPosition !== '0' ? ` #${b.seriesPosition}` : ''}` : '';   // #0 is a prequel: no number
        return `<a class="tnr-bk-card" href="${ROUTE}/${b.id}" data-id="${b.id}" title="${esc(b.title)}${b.authors ? ` by ${esc(b.authors)}` : ''}">
            <div class="tnr-bk-cover${b.cover ? '' : ' none'}">${coverHtml(b)}${badgeHtml(B.states[b.id])}</div>
            <div class="tnr-bk-title">${esc(b.title)}</div>
            <div class="tnr-bk-author">${esc(b.authors || series)}</div>
        </a>`;
    }

    function badgeHtml(st) {
        if (!st) return '';
        if (st.state === 'have') return '<span class="tnr-bk-badge have" title="In the library"><span class="material-icons" aria-hidden="true">check</span></span>';
        if (st.state === 'downloading') return `<span class="tnr-bk-badge" title="Downloading">${Math.floor((st.progress || 0) * 100)}%</span>`;
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
        // break-ui pass (2026-11-24): "1 ratings" / "1 pages", and 4.0 came out as "★ 4" beside "★ 4.3".
        const plural = (n, word) => `${num(n)} ${word}${n === 1 ? '' : 's'}`;
        const stars = b.rating ? Number(b.rating).toFixed(1) : '';
        const meta = [b.year, b.pages ? plural(b.pages, 'page') : '',
            b.rating ? `<span class="tnr-bk-stars" aria-label="Rated ${stars} out of 5">★ ${stars}</span> <span class="tnr-bk-dim">(${plural(b.ratings, 'rating')})</span>` : '']
            .filter(Boolean).join('<span class="tnr-bk-dot">·</span>');
        const paras = String(b.description || '').split(/\n\s*\n|\n/).map((p) => p.trim()).filter(Boolean);
        body.innerHTML = `<div class="tnr-bk-detail">
            <button type="button" class="tnr-bk-back"><span class="material-icons" aria-hidden="true">arrow_back</span>Back</button>
            <div class="tnr-bk-hero">
                <div class="tnr-bk-bigcover${b.cover ? '' : ' none'}">${coverHtml(b, true)}</div>
                <div class="tnr-bk-info">
                    <h1>${esc(b.title)}</h1>
                    ${goodSubtitle(b.subtitle, b.title) ? `<div class="tnr-bk-sub">${esc(b.subtitle)}</div>` : ''}
                    ${b.authors ? `<div class="tnr-bk-by">by ${b.authorId
                        ? `<a href="${ROUTE}/author/${b.authorId}" data-go>${esc(b.authors)}</a>`
                        : `<a href="#" data-find="${esc(b.authors.split(' and ')[0].split(',')[0])}">${esc(b.authors)}</a>`}</div>` : ''}
                    ${b.series ? `<div class="tnr-bk-series">${b.seriesPosition === '0' ? 'Prequel to ' : b.seriesPosition ? `Book ${esc(b.seriesPosition)} of ` : 'Part of '}<a href="#" data-find="${esc(b.series)}">${esc(b.series)}</a></div>` : ''}
                    ${meta ? `<div class="tnr-bk-meta">${meta}</div>` : ''}
                    <div class="tnr-bk-action" aria-live="polite"></div>
                    ${b.genres && b.genres.length ? `<div class="tnr-bk-genres">${b.genres.map(esc).join(' · ')}</div>` : ''}
                    ${paras.length ? `<div class="tnr-bk-desc">${paras.map((p) => `<p>${esc(p)}</p>`).join('')}</div>
                        <button type="button" class="tnr-bk-more" hidden>More</button>` : ''}
                </div>
            </div>
        </div>`;
        bindCovers(body);
        bindBack(body);
        body.querySelectorAll('[data-go]').forEach((a) => a.addEventListener('click', (e) => {
            if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
            e.preventDefault();
            goTo(a.getAttribute('href'));
        }));
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
                // Only for a book that just arrived while you watched: the reader picks it up
                // a couple of minutes after the download (shown on every old book before).
                + (B.book.read && B.book.arrived ? '<div class="tnr-bk-hint">Just arrived: it can take a couple of minutes to show up in the reader.</div>' : '')
                // A download can be the wrong book (or a bad file) even after it's in.
                + '<button type="button" class="tnr-bk-link" data-do="replace">Wrong book? Replace it</button>';
        } else if (state === 'downloading' || state === 'problem') {
            const pct = Math.floor((st.progress || 0) * 100);   // down: 99.9% isn't done
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
                <div class="tnr-bk-hint">Adds it to the shared library, so everyone here can read it. Usually ready in a few minutes; you’ll find it under In the library.</div>`;
        }
        box.innerHTML = html;
        const read = $('a.tnr-bk-btn', box);
        // Read signs you in to the reader as yourself: the server hands out a one-time ticket
        // (POST Tuner/books/read) and the address carries it. If that fails, the plain address
        // still opens the reader, at its own login page. The desktop and phone apps can't open
        // new windows, so they hand the address to the system browser. A browser gets its window
        // opened right away, inside the click: one opened after waiting for the server counts as
        // a pop-up and gets blocked.
        if (read) {
            read.addEventListener('click', async (e) => {
                e.preventDefault();
                const native = window.NativeShell && typeof window.NativeShell.openUrl === 'function';
                const win = native ? null : window.open('', '_blank');
                let url = read.href;
                try {
                    const u = new URL(read.href);
                    const res = await ApiClient.ajax({ type: 'POST', url: ApiClient.getUrl('Tuner/books/read', { next: u.pathname + u.search }), dataType: 'json' });
                    if (res && res.url) url = res.url;
                } catch (err) { /* open the plain address */ }
                if (native) {
                    window.NativeShell.openUrl(url, '_blank');
                } else if (win) {
                    win.opener = null;
                    win.location.href = url;
                } else {
                    location.href = url;
                }
            });
        }
        box.querySelectorAll('[data-do]').forEach((btn) => btn.addEventListener('click', () => act(btn, btn.dataset.do)));
    }

    async function act(btn, what) {
        if (!B.book || btn.disabled) return;
        // Replace removes the copy everyone reads, so it asks first.
        if (what === 'replace' && !window.confirm('Remove this copy from the library for everyone and look for a different one? Use this if the file is the wrong book or won’t open.')) return;
        const id = B.book.id;
        btn.disabled = true;
        try {
            const res = await post(`Tuner/books/${id}/${what === 'retry' || what === 'replace' ? what : 'get'}`);
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
                if (isBook && B.book && B.states[B.book.id] && B.states[B.book.id].state === 'have') B.book.arrived = true;
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
