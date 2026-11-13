/*
 * Watch together: a chat for people in the same SyncPlay group.
 *
 * Injected only when "Chat for SyncPlay groups" is on in the plugin settings. While you
 * are in a group:
 *   - with a video open, the chat sits in a column on the right and the player shrinks to
 *     make room for it;
 *   - in full screen, or anywhere else in Jellyfin, it becomes a bubble in the bottom right
 *     that opens into a small chat window, and new messages peek out beside it;
 *   - minimize (-) turns it into the bubble, close (x) hides it until you join another
 *     group; a chat button in the top bar brings it back;
 *   - its group button opens Jellyfin's SyncPlay menu (Resume playback after leaving the
 *     video, Settings, Leave), offered as "Back to the group's video" away from the player,
 *     opened over the chat; Esc or its added Close button closes it.
 *
 * Talks to /Tuner/party (PartyController): one long-poll request open at a time, which the
 * server answers the moment someone writes. The server decides which group you're in from
 * Jellyfin's SyncPlay state, so nothing here has to watch SyncPlay itself.
 */
(function () {
    'use strict';
    if (window.__tnrPartyLoaded) return;
    window.__tnrPartyLoaded = true;

    const WIDTH = 340;          // the chat column beside the player, px
    const WIDE = 760;           // narrower windows (phones) get the floating window instead
    const PEEK_MS = 5000;

    const P = {
        group: null, name: '', me: '', people: [], last: 0,
        open: true,             // panel showing (false = bubble)
        closed: false,          // dismissed for this group
        unread: 0,
        mode: '',               // last layout applied
        fsOpen: false,          // opened from the bubble while in full screen
        wasFs: false,
    };

    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const signedIn = () => !!(window.ApiClient && ApiClient.getCurrentUserId && ApiClient.getCurrentUserId());
    function api(path, opts) {
        return ApiClient.ajax(Object.assign({ type: 'GET', url: ApiClient.getUrl(path), dataType: 'json' }, opts || {}));
    }

    // Open/minimized/closed is remembered per group for this browser tab.
    const stateKey = () => `tnr.party.${P.group}`;
    function saveState() { try { sessionStorage.setItem(stateKey(), JSON.stringify({ open: P.open, closed: P.closed })); } catch (e) { /* private mode */ } }
    function loadState() {
        try { const s = JSON.parse(sessionStorage.getItem(stateKey()) || 'null'); if (s) { P.open = !!s.open; P.closed = !!s.closed; return; } } catch (e) { /* ignore */ }
        P.open = true; P.closed = false;
    }

    // ---------- styles ----------

    const CSS = `
.tnrp { --tnrp-bg: #12161b; --tnrp-raise: #1c222a; --tnrp-line: #2a323c; --tnrp-text: #e8eaed; --tnrp-dim: #98a1ab;
  --tnrp-accent: #00a4dc; font-family: inherit; color: var(--tnrp-text); }
.tnrp[hidden] { display: none !important; }
.tnrp-panel { position: fixed; z-index: 1100; display: flex; flex-direction: column; background: var(--tnrp-bg);
  border: 1px solid var(--tnrp-line); box-shadow: 0 8px 30px rgba(0,0,0,.5); }
.tnrp.docked .tnrp-panel { top: 0; right: 0; bottom: 0; width: ${WIDTH}px; border-width: 0 0 0 1px; box-shadow: none; }
.tnrp.float .tnrp-panel { right: 16px; bottom: 16px; width: ${WIDTH}px; height: min(480px, calc(100vh - 32px)); border-radius: 12px; overflow: hidden; }
.tnrp.bubble .tnrp-panel { display: none; }
.tnrp:not(.bubble) .tnrp-bubble, .tnrp:not(.bubble) .tnrp-peek { display: none; }
.tnrp-head { display: flex; align-items: center; gap: .5em; padding: .55em .5em .55em .9em; border-bottom: 1px solid var(--tnrp-line); background: var(--tnrp-raise); }
.tnrp-title { flex: 1; min-width: 0; line-height: 1.25; }
.tnrp-title b { display: block; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tnrp-title small { display: block; color: var(--tnrp-dim); font-size: .8em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tnrp-icon { background: none; border: 0; color: var(--tnrp-dim); cursor: pointer; padding: .3em; border-radius: 50%; display: flex; }
.tnrp-icon:hover, .tnrp-icon:focus-visible { color: var(--tnrp-text); background: rgba(255,255,255,.08); outline: none; }
.tnrp-list { flex: 1; overflow-y: auto; padding: .7em .9em; display: flex; flex-direction: column; gap: .35em; overscroll-behavior: contain; }
.tnrp-msg { line-height: 1.35; overflow-wrap: anywhere; }
.tnrp-msg b { font-weight: 600; margin-right: .4em; }
.tnrp-sys { color: var(--tnrp-dim); font-size: .85em; text-align: center; padding: .15em 0; }
.tnrp-empty { color: var(--tnrp-dim); font-size: .9em; text-align: center; margin: auto 0; }
.tnrp-form { display: flex; gap: .4em; padding: .6em; border-top: 1px solid var(--tnrp-line); }
.tnrp-form input { flex: 1; min-width: 0; background: var(--tnrp-raise); color: var(--tnrp-text); border: 1px solid var(--tnrp-line);
  border-radius: 18px; padding: .55em .9em; font: inherit; outline: none; }
.tnrp-form input:focus { border-color: var(--tnrp-accent); }
.tnrp-form button { background: var(--tnrp-accent); color: #fff; border: 0; border-radius: 50%; width: 2.4em; height: 2.4em;
  cursor: pointer; display: flex; align-items: center; justify-content: center; flex: none; }
.tnrp-form button:disabled { opacity: .5; cursor: default; }
.tnrp-bubble { position: fixed; z-index: 1100; right: 16px; bottom: 16px; width: 52px; height: 52px; border-radius: 50%; border: 0;
  background: var(--tnrp-accent); color: #fff; cursor: pointer; box-shadow: 0 4px 16px rgba(0,0,0,.5); display: flex; align-items: center; justify-content: center; }
.tnrp-badge { position: absolute; top: -2px; right: -2px; min-width: 20px; height: 20px; padding: 0 5px; border-radius: 10px;
  background: #E24B4A; color: #fff; font-size: 12px; font-weight: 700; line-height: 20px; text-align: center; box-sizing: border-box; }
.tnrp-badge:empty { display: none; }
.tnrp-peek { position: fixed; z-index: 1100; right: 80px; bottom: 22px; max-width: min(320px, calc(100vw - 100px)); background: var(--tnrp-raise);
  border: 1px solid var(--tnrp-line); border-radius: 12px; padding: .5em .8em; box-shadow: 0 4px 16px rgba(0,0,0,.5);
  opacity: 0; transform: translateX(8px); transition: opacity .2s, transform .2s; pointer-events: none; overflow-wrap: anywhere; }
.tnrp-peek.show { opacity: 1; transform: none; }
/* Clear of Jellyfin's now-playing bar along the bottom. */
.tnrp.np .tnrp-bubble { bottom: 92px; } .tnrp.np .tnrp-peek { bottom: 98px; } .tnrp.np.float .tnrp-panel { bottom: 92px; height: min(480px, calc(100vh - 108px)); }
/* In the player the bottom right holds its controls, so the bubble moves up out of the way. */
.tnrp.player .tnrp-bubble { bottom: auto; top: 80px; } .tnrp.player .tnrp-peek { bottom: auto; top: 86px; }
.tnrp.player.float .tnrp-panel { bottom: auto; top: 80px; height: min(480px, calc(100vh - 200px)); }
@media (max-width: 600px) {
  .tnrp.float .tnrp-panel { left: 8px; right: 8px; width: auto; bottom: 8px; height: min(70vh, calc(100vh - 16px)); }
  .tnrp.np.float .tnrp-panel { bottom: 80px; }
}
/* The column beside the player: the video, its controls and its top bar end where the chat starts. */
/* Each of these is pinned to the window on its own (position: fixed), so each moves over. */
body.tnrp-docked .videoPlayerContainer, body.tnrp-docked #videoOsdPage, body.tnrp-docked .skinHeader.osdHeader,
body.tnrp-docked .videoOsdBottom, body.tnrp-docked .upNextContainer { right: ${WIDTH}px !important; width: auto !important; }
.tnrp-sync { display: flex; align-items: center; gap: .5em; margin: .6em .9em 0; padding: .5em .8em; border-radius: 8px; cursor: pointer;
  background: rgba(0,164,220,.14); border: 1px solid rgba(0,164,220,.45); color: var(--tnrp-text); font: inherit; text-align: left; }
.tnrp-sync:hover, .tnrp-sync:focus-visible { background: rgba(0,164,220,.25); outline: none; }
.tnrp.player .tnrp-sync { display: none; }
/* The Close button added to Jellyfin's SyncPlay popup, styled like the popup's own rows. */
.tnrp-menuclose { display: flex; align-items: center; gap: 1em; width: 100%; padding: .9em 1.2em; margin-top: .3em; background: none;
  border: 0; border-top: 1px solid rgba(255,255,255,.12); color: inherit; font: inherit; cursor: pointer; text-align: left; }
.tnrp-menuclose:hover, .tnrp-menuclose:focus-visible { background: rgba(255,255,255,.08); outline: none; }
.tnrp-reopen .tnrp-dot { position: absolute; top: 6px; right: 6px; width: 8px; height: 8px; border-radius: 50%; background: #E24B4A; }
`;

    // ---------- page parts ----------

    let root, list, input, sendBtn, bubble, badge, peek, titleB, titleSmall, peekTimer;

    function build() {
        const style = document.createElement('style');
        style.textContent = CSS;
        document.head.appendChild(style);
        root = document.createElement('div');
        root.className = 'tnrp';
        root.hidden = true;
        root.innerHTML = `
<section class="tnrp-panel" aria-label="Group chat">
  <div class="tnrp-head">
    <span class="material-icons" aria-hidden="true">forum</span>
    <div class="tnrp-title"><b></b><small></small></div>
    <button type="button" class="tnrp-icon tnrp-syncmenu" title="SyncPlay: resume, settings, leave" aria-label="SyncPlay menu"><span class="material-icons">groups</span></button>
    <button type="button" class="tnrp-icon tnrp-min" title="Minimize" aria-label="Minimize chat"><span class="material-icons">remove</span></button>
    <button type="button" class="tnrp-icon tnrp-x" title="Close chat" aria-label="Close chat"><span class="material-icons">close</span></button>
  </div>
  <button type="button" class="tnrp-sync"><span class="material-icons" aria-hidden="true">play_circle</span><span>Back to the group's video</span></button>
  <div class="tnrp-list" role="log" aria-live="polite"></div>
  <form class="tnrp-form" autocomplete="off">
    <input type="text" maxlength="500" placeholder="Message the group" aria-label="Message">
    <button type="submit" title="Send" aria-label="Send"><span class="material-icons">send</span></button>
  </form>
</section>
<button type="button" class="tnrp-bubble" title="Group chat" aria-label="Open group chat"><span class="material-icons">forum</span><span class="tnrp-badge"></span></button>
<div class="tnrp-peek" aria-hidden="true"></div>`;
        document.body.appendChild(root);
        list = root.querySelector('.tnrp-list');
        input = root.querySelector('input');
        sendBtn = root.querySelector('.tnrp-form button');
        bubble = root.querySelector('.tnrp-bubble');
        badge = root.querySelector('.tnrp-badge');
        peek = root.querySelector('.tnrp-peek');
        titleB = root.querySelector('.tnrp-title b');
        titleSmall = root.querySelector('.tnrp-title small');

        root.querySelector('.tnrp-min').addEventListener('click', () => setOpen(false));
        root.querySelector('.tnrp-x').addEventListener('click', () => { P.closed = true; saveState(); layout(); });
        bubble.addEventListener('click', () => setOpen(true, true));
        root.querySelector('.tnrp-syncmenu').addEventListener('click', syncPlayMenu);
        root.querySelector('.tnrp-sync').addEventListener('click', syncPlayMenu);
        root.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); send(); });
        // Enter sends. Handled here rather than left to the form: Jellyfin's keyboard handling
        // takes Enter before the form ever sees it.
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
        });
        // Keys typed into the message box are for the chat: the player would otherwise take
        // space as pause, f as full screen, arrows as seek, and Esc as "leave the video".
        // Only the box: keys while a chat button has focus (Esc for the SyncPlay popup) go on to Jellyfin.
        ['keydown', 'keyup', 'keypress'].forEach((t) => input.addEventListener(t, (e) => {
            e.stopPropagation();
            if (t === 'keydown' && e.key === 'Escape') input.blur();
        }));
    }

    function setOpen(open, focus) {
        // In full screen the chat starts as the bubble each time; opening it there lasts until
        // full screen ends, then the column comes back the way it was.
        if (fullScreen()) P.fsOpen = open;
        else { P.open = open; saveState(); }
        if (open) P.unread = 0;
        layout();
        if (open && focus) setTimeout(() => input.focus(), 0);
    }

    // Jellyfin's own SyncPlay menu (the group button in its top bar): Resume playback for
    // someone who left the video, plus Settings and Leave. The page can't reach SyncPlay
    // directly, so this presses that button.
    function syncPlayMenu(e) {
        const b = document.querySelector('.headerSyncButton');
        // Let the popup have the keyboard (Esc closes it), not the chat button just pressed.
        if (e && e.currentTarget) e.currentTarget.blur();
        if (b) { b.click(); moveMenuToChat(); return; }
        sysLine("Couldn't find Jellyfin's SyncPlay button. It's the group icon at the top of the page.");
    }

    // The popup Jellyfin opens. It closes when the dimmed area around it is clicked, so Esc
    // and our Close button do exactly that (a click that starts and ends on its container).
    const openMenu = () => { const all = document.querySelectorAll('.syncPlayGroupMenu.opened'); return all[all.length - 1] || null; };
    function closeMenu(menu) {
        const box = menu.dialogContainer || menu.closest('.dialogContainer');
        if (!box) return;
        box.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        box.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
    function addCloseButton(menu) {
        if (menu.querySelector('.tnrp-menuclose')) return;
        const list = menu.querySelector('.actionSheetScroller') || menu.querySelector('.actionSheetContent') || menu;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'tnrp-menuclose';
        b.innerHTML = '<span class="material-icons" aria-hidden="true">close</span><span>Close</span>';
        b.addEventListener('click', (e) => { e.stopPropagation(); closeMenu(menu); });
        list.appendChild(b);
    }

    // Jellyfin places the popup beside its top bar button, the far corner from the chat.
    // Opened from the chat, it moves over the chat instead (or to the middle of the screen
    // when the chat is just the bubble). Jellyfin positions it a moment after it appears, so
    // this keeps placing it for the first few frames.
    function moveMenuToChat() {
        const until = Date.now() + 1500;
        let placed = 0;
        const tick = () => {
            const m = openMenu();
            if (m) { placeMenu(m); placed++; }
            if (placed < 20 && Date.now() < until) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    }
    function placeMenu(menu) {
        const w = menu.offsetWidth, h = menu.offsetHeight;
        if (!w) return;
        const r = panelVisible() ? root.querySelector('.tnrp-panel').getBoundingClientRect() : null;
        let left = (innerWidth - w) / 2, top = (innerHeight - h) / 2;
        if (r && r.width) { left = r.left + (r.width - w) / 2; top = r.top + Math.max(10, Math.min(70, (r.height - h) / 2)); }
        const clamp = (v, max) => Math.max(10, Math.min(v, max - 10));
        menu.style.position = 'fixed';
        menu.style.margin = '0';
        menu.style.left = clamp(left, innerWidth - w) + 'px';
        menu.style.top = clamp(top, innerHeight - h) + 'px';
    }

    // ---------- layout ----------

    // The player tags Jellyfin's top bar with osdHeader while it's showing; its page may also be
    // found by id. Either means a video is open.
    const playerOpen = () => !!document.querySelector('.skinHeader.osdHeader, #videoOsdPage:not(.hide)');
    const fullScreen = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
    const nowPlayingBar = () => !!document.querySelector('.nowPlayingBar:not(.hide)');

    function layout() {
        if (!root) return;
        const show = !!P.group && !P.closed && signedIn();
        const player = playerOpen();
        const fs = fullScreen();
        if (fs !== P.wasFs) { P.wasFs = fs; P.fsOpen = false; }
        const open = fs ? P.fsOpen : P.open;
        const docked = show && open && player && !fs && innerWidth >= WIDE;
        const mode = !show ? 'none' : docked ? 'docked' : open ? 'float' : 'bubble';
        root.hidden = !show;
        root.classList.toggle('docked', mode === 'docked');
        root.classList.toggle('float', mode === 'float');
        root.classList.toggle('bubble', mode === 'bubble');
        root.classList.toggle('player', player);
        root.classList.toggle('np', !player && nowPlayingBar());
        document.body.classList.toggle('tnrp-docked', docked);
        badge.textContent = P.unread ? (P.unread > 99 ? '99+' : String(P.unread)) : '';
        if (mode !== P.mode) {
            const wasDocked = P.mode === 'docked';
            P.mode = mode;
            if (mode === 'docked' || mode === 'float') scrollToEnd();
            // The player sizes its video on window resize; tell it the room changed.
            if (wasDocked !== docked) window.dispatchEvent(new Event('resize'));
        }
        reopenButton(P.group && P.closed && signedIn());
    }

    // While the chat is closed, a chat button in Jellyfin's top bar brings it back.
    function reopenButton(want) {
        let b = document.querySelector('.tnrp-reopen');
        if (!want) { if (b) b.remove(); return; }
        const bar = document.querySelector('.skinHeader .headerRight');
        if (!bar) return;
        if (!b || b.parentElement !== bar) {
            if (b) b.remove();
            b = document.createElement('button');
            b.type = 'button';
            b.className = 'headerButton headerButtonRight paper-icon-button-light tnrp-reopen';
            b.title = 'Group chat';
            b.setAttribute('aria-label', 'Open group chat');
            b.style.position = 'relative';
            b.innerHTML = '<span class="material-icons" aria-hidden="true">forum</span><span class="tnrp-dot" hidden></span>';
            b.addEventListener('click', () => { P.closed = false; P.open = true; P.unread = 0; saveState(); layout(); });
            bar.insertBefore(b, bar.firstChild);
        }
        b.querySelector('.tnrp-dot').hidden = !P.unread;
    }

    const panelVisible = () => P.mode === 'docked' || P.mode === 'float';

    // ---------- messages ----------

    function colorOf(name) {
        let h = 0;
        for (const c of String(name).toLowerCase()) h = (h * 31 + c.charCodeAt(0)) >>> 0;
        return `hsl(${h % 360}, 65%, 70%)`;
    }

    const nearEnd = () => list.scrollHeight - list.scrollTop - list.clientHeight < 60;
    function scrollToEnd() { list.scrollTop = list.scrollHeight; }

    function renderHead() {
        titleB.textContent = P.name || 'Watch together';
        titleSmall.textContent = P.people.join(', ');
        titleSmall.title = P.people.join(', ');
        if (!list.children.length) list.innerHTML = '<div class="tnrp-empty">Say hi. Everyone in this SyncPlay group sees what you write here.</div>';
    }

    function addMessages(msgs, history) {
        if (!msgs.length) return;
        const stick = nearEnd();
        const empty = list.querySelector('.tnrp-empty');
        if (empty) empty.remove();
        let newest = null;
        msgs.forEach((m) => {
            if (m.id <= P.last) return;
            P.last = m.id;
            const el = document.createElement('div');
            const when = new Date(m.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
            el.title = when;
            if (m.system) {
                el.className = 'tnrp-sys';
                el.textContent = m.text;
            } else {
                el.className = 'tnrp-msg';
                const mine = m.user.toLowerCase() === P.me.toLowerCase();
                el.innerHTML = `<b style="color:${mine ? 'var(--tnrp-accent)' : colorOf(m.user)}">${esc(m.user)}</b>${esc(m.text)}`;
                if (!mine) newest = m;
            }
            list.appendChild(el);
        });
        // Keep the list from growing forever in a long movie night.
        while (list.children.length > 300) list.firstChild.remove();
        if (stick) scrollToEnd();
        if (newest && !history && (!panelVisible() || document.hidden)) {
            P.unread += msgs.filter((m) => !m.system && m.user.toLowerCase() !== P.me.toLowerCase()).length;
            if (P.mode === 'bubble') showPeek(newest);
            layout();
        }
    }

    function showPeek(m) {
        peek.innerHTML = `<b style="color:${colorOf(m.user)}">${esc(m.user)}</b> ${esc(m.text.length > 140 ? m.text.slice(0, 140) + '…' : m.text)}`;
        peek.classList.add('show');
        clearTimeout(peekTimer);
        peekTimer = setTimeout(() => peek.classList.remove('show'), PEEK_MS);
    }

    async function send() {
        const text = input.value.trim();
        if (!text || sendBtn.disabled) return;
        sendBtn.disabled = true;
        try {
            await api('Tuner/party', { type: 'POST', data: JSON.stringify({ Text: text }), contentType: 'application/json' });
            input.value = '';
        } catch (e) {
            let msg = "Couldn't send that";
            try { const j = e && typeof e.json === 'function' ? await e.json() : null; if (j && j.message) msg = j.message; } catch (x) { /* keep default */ }
            sysLine(msg);
        } finally {
            sendBtn.disabled = false;
            input.focus();
        }
    }

    function sysLine(text) {
        const el = document.createElement('div');
        el.className = 'tnrp-sys';
        el.textContent = text;
        list.appendChild(el);
        scrollToEnd();
    }

    function joined(r) {
        P.group = r.group;
        P.last = 0;
        P.unread = 0;
        list.innerHTML = '';
        loadState();
    }

    function left() {
        P.group = null;
        P.people = [];
        P.last = 0;
        list.innerHTML = '';
        layout();
    }

    // ---------- the long poll ----------

    async function poll() {
        let fails = 0;
        let user = null;
        for (;;) {
            if (!signedIn()) { if (P.group) left(); await sleep(3000); continue; }
            // Another person signed in on this tab: start over as them.
            const id = ApiClient.getCurrentUserId();
            if (user !== id) { user = id; if (P.group) left(); }
            let r;
            try {
                const q = P.group ? `?group=${encodeURIComponent(P.group)}&after=${P.last}&wait=true` : '';
                r = await api('Tuner/party' + q);
                fails = 0;
            } catch (e) {
                // Server restarting, offline, or a plugin version without this endpoint.
                fails++;
                await sleep(Math.min(60000, 4000 * fails));
                continue;
            }
            if (!r || r.enabled === false) { if (P.group) left(); return; }   // turned off in settings
            if (ApiClient.getCurrentUserId() !== user) continue;
            if (!r.inGroup) {
                if (P.group) left();
                // Not in a group: a cheap check now and then to notice when you join one.
                await sleep(document.hidden ? 30000 : 4000);
                continue;
            }
            const fresh = r.group !== P.group;
            if (fresh) joined(r);
            P.name = r.name || '';
            P.me = r.me || '';
            P.people = r.people || [];
            renderHead();
            addMessages(r.messages || [], fresh);
            layout();
        }
    }

    // ---------- boot ----------

    // For troubleshooting from the browser console: TunerParty.state()
    window.TunerParty = {
        state: () => ({ group: P.group, mode: P.mode, open: P.open, closed: P.closed, player: playerOpen(), fullScreen: fullScreen(), width: innerWidth }),
    };

    function boot() {
        if (!document.body || !window.ApiClient) { setTimeout(boot, 500); return; }
        build();
        // The player opening and closing, the top bar being redrawn and the now-playing bar
        // coming and going don't fire one event we can listen to; a quick check is cheaper
        // than watching every change to the page.
        setInterval(() => { if (P.group) layout(); }, 700);
        // Esc closes the SyncPlay popup (from the chat or Jellyfin's top bar). Jellyfin only
        // does that in its TV layout. Capture phase, so the player doesn't also take Esc as
        // "leave the video".
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape' && e.key !== 'Esc') return;
            const menu = openMenu();
            if (!menu) return;
            e.preventDefault();
            e.stopPropagation();
            closeMenu(menu);
        }, true);
        // Every SyncPlay popup gets a plain Close button at the bottom.
        // (A frame later: the popup is added to the page first and marked open after.)
        new MutationObserver(() => requestAnimationFrame(() => document.querySelectorAll('.syncPlayGroupMenu').forEach(addCloseButton)))
            .observe(document.body, { childList: true });
        document.addEventListener('fullscreenchange', layout);
        document.addEventListener('webkitfullscreenchange', layout);
        window.addEventListener('resize', () => { if (P.group) layout(); });
        document.addEventListener('visibilitychange', () => { if (!document.hidden && panelVisible()) { P.unread = 0; layout(); } });
        poll();
    }
    boot();
})();
