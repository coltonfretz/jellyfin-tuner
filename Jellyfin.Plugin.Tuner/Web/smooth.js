/*
 * Tuner: smooth scrolling for jellyfin-web, the lenis.dev feel.
 *
 * WHY (Fretzflix, 2026-11-15): Colton wanted page scrolling to feel like lenis.dev ("butter
 * from the happiest cows"). A mouse wheel normally jumps ~100 px per notch; here each notch
 * moves a target instead, and the page glides toward it every frame, easing out (the same
 * damped-lerp Lenis uses, made frame-rate independent so 144 Hz screens feel the same).
 *
 * Own file, own setting (Home -> Smooth scrolling), not part of Lenis: Jellyfin needs these
 * cases handled and Lenis knows none of them:
 *  - Only the page itself is smoothed. Anything that scrolls on its own (dialogs, the chat,
 *    lyrics, side menu, MUI menus) keeps the browser's scrolling. So do horizontal rows,
 *    Shift+wheel, Ctrl+wheel (zoom) and anything another handler already took.
 *  - Off in Jellyfin's TV layout (the remote moves focus, not the wheel), with
 *    "reduce motion" on (unless the second setting says to glide anyway), in full screen, and while a dialog or menu has locked the page.
 *  - Anything else that scrolls the page (scrollbar drag, keys, Jellyfin restoring a
 *    position, Back) wins: the glide notices and stops instead of fighting it.
 * Touch screens are left alone; they already glide natively.
 */
(function () {
    'use strict';
    if (window.TunerSmooth) return;

    // Lenis' default "lerp: 0.1": each 60 Hz frame covers 10% of what's left.
    // Lower = floatier. Try TunerSmooth.lerp = 0.07 in the console to feel the difference.
    const api = { lerp: 0.1, wheelMultiplier: 1, enabled: true };
    let current = 0;       // where we last put the page
    let target = 0;        // where the wheel wants it
    let running = false;
    let lastTime = 0;

    const root = document.documentElement;
    const reducedQuery = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
    // "Even when the device asks for reduced motion" (setting): Windows' "Animation effects"
    // off also means reduce motion, and plenty of people turn that off just for snappiness.
    const ME = document.currentScript;
    const IGNORE_REDUCED = !!(ME && ME.dataset.ignoreReduced);
    const reduced = { get matches() { return !IGNORE_REDUCED && reducedQuery.matches; } };
    const maxScroll = () => Math.max(0, (document.scrollingElement || root).scrollHeight - window.innerHeight);
    const clamp = (v) => Math.min(maxScroll(), Math.max(0, v));

    function pageLocked() {
        // Dialogs and MUI menus lock the page by hiding its overflow; the request page does too.
        const h = getComputedStyle(root).overflowY, b = getComputedStyle(document.body).overflowY;
        return h === 'hidden' || b === 'hidden' || h === 'clip' || b === 'clip';
    }

    // An element between the pointer and the page that can scroll vertically keeps the wheel.
    // Checked once per wheel event, walking up from the target (a few dozen nodes at most).
    function scrollsItself(el) {
        for (; el && el !== document.body && el !== root; el = el.parentElement) {
            if (el.nodeType !== 1) continue;
            if (el.hasAttribute('data-tnr-native-scroll')) return true;
            if (el.scrollHeight > el.clientHeight + 1) {
                const oy = getComputedStyle(el).overflowY;
                if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') return true;
            }
            // A fixed panel (dialog, player, side menu) sits over the page; wheeling on it
            // scrolling the page underneath is not what anyone means.
            if (el.classList.contains('dialogContainer') || el.classList.contains('videoPlayerContainer')
                || el.id === 'videoOsdPage') return true;
        }
        return false;
    }

    function off() {
        return !api.enabled || reduced.matches || root.classList.contains('layout-tv')
            || document.fullscreenElement || pageLocked();
    }

    function onWheel(e) {
        if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.shiftKey) return;
        // Mostly-sideways gestures (trackpad swipes along a row) stay native.
        if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
        if (off() || maxScroll() <= 0 || scrollsItself(e.target)) return;

        // Line-based wheels (some Firefox setups) report lines, not pixels.
        const unit = e.deltaMode === 1 ? 100 / 6 : e.deltaMode === 2 ? window.innerHeight : 1;
        const delta = e.deltaY * unit * api.wheelMultiplier;
        if (!delta) return;
        e.preventDefault();

        if (!running) current = window.scrollY;
        target = clamp((running ? target : current) + delta);
        start();
    }

    function start() {
        if (running) return;
        running = true;
        lastTime = performance.now();
        requestAnimationFrame(frame);
    }

    function stop() {
        running = false;
        current = target = window.scrollY;
    }

    function frame(now) {
        if (!running) return;
        // Something else moved the page since our last frame (scrollbar, keys, Jellyfin
        // restoring a position): it wins.
        if (Math.abs(window.scrollY - current) > 2) { stop(); return; }
        const dt = Math.min(0.1, (now - lastTime) / 1000);
        lastTime = now;
        target = clamp(target); // the page may have grown or shrunk (rows loading)
        // Lenis' damp(): lerp by 1 - e^(-lambda dt), lambda = lerp * 60.
        current += (target - current) * (1 - Math.exp(-api.lerp * 60 * dt));
        if (Math.abs(target - current) < 0.5) current = target;
        window.scrollTo({ top: current, behavior: 'instant' });
        if (current === target) { running = false; return; }
        requestAnimationFrame(frame);
    }

    // Glide to a position with the same feel (Back to top uses this).
    api.scrollTo = function (y) {
        if (off()) { window.scrollTo({ top: y, behavior: reduced.matches ? 'auto' : 'smooth' }); return; }
        if (!running) current = window.scrollY;
        target = clamp(y);
        start();
    };
    api.stop = stop;

    window.addEventListener('wheel', onWheel, { passive: false });
    // A new page starts wherever Jellyfin puts it; don't carry a glide across.
    window.addEventListener('hashchange', stop);
    window.addEventListener('popstate', stop);
    document.addEventListener('viewbeforeshow', stop);
    // Keys, scrollbar, middle-click: let any running glide go.
    window.addEventListener('keydown', (e) => { if (running && !e.repeat) stop(); });
    window.addEventListener('mousedown', () => { if (running) stop(); });

    window.TunerSmooth = api;
})();
