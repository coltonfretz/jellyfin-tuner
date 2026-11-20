/*
 * Tuner: a shorter "Next episode playing in..." countdown.
 *
 * WHY (Fretzflix, 2026-11-19): users said waiting for the next episode takes too long.
 * jellyfin-web's Up Next popup shows when the credits start (the Outro media segment)
 * and its countdown is simply the time left in the file (duration - currentTime in the
 * upNextDialog chunk), so it runs as long as the credits do. A sample of 80 Fretzflix
 * episodes: median ~55 s, Frieren ~100 s, Bleach up to ~4 min (the preview comes after the ED).
 * Jellyfin has no setting for this length.
 *
 * What this does: when the popup is counting down from more than the cap, it counts the
 * cap instead and then presses the popup's own "Start now" button. It changes nothing
 * else:
 *  - The popup's Hide button still lets people watch the credits; once hidden we stop.
 *  - Popups that already say less than the cap are left alone.
 *  - People with "auto-play next episode" off get a popup without a countdown (Jellyfin's
 *    static text); no countdown span means we never start.
 *  - Pausing pauses our count too, like Jellyfin's own (it follows the playhead).
 * Skipping the credits outright (Jellyfin's per-device "Outro: Skip", or Jellyfin
 * Enhanced's AutoSkipOutro) was rejected: it also eats post-credit scenes and anime
 * previews for people who want them.
 *
 * Only where jellyfin-web runs (browser, desktop apps, official Android app). Plain
 * ES2017 on purpose: Jellyfin Media Player is Chromium 83.
 */
(function () {
    'use strict';
    if (window.TunerUpNext) return;

    const ME = document.currentScript;
    const CAP = Math.max(5, parseInt((ME && ME.dataset.seconds) || '15', 10) || 15);
    const api = { cap: CAP, active: false };
    window.TunerUpNext = api;

    let dialog = null;      // the popup we are counting for
    let left = 0;           // our seconds left, fractional
    let lastTick = 0;
    let observer = null;    // keeps Jellyfin's text showing our number

    function visibleDialog() {
        const d = document.querySelector('.upNextDialog');
        if (!d || d.classList.contains('hide') || d.classList.contains('upNextDialog-hidden')) return null;
        return d;
    }

    function shownNumber(d) {
        const span = d.querySelector('.upNextDialog-countdownText');
        if (!span) return NaN;
        const m = /\d+/.exec(span.textContent);
        return m ? parseInt(m[0], 10) : NaN;
    }

    // Jellyfin rewrites the countdown text every 400 ms from the time left in the file.
    // A MutationObserver runs before the next paint, so putting our number back right
    // after each rewrite never flickers.
    function showOurs() {
        if (!dialog) return;
        const span = dialog.querySelector('.upNextDialog-countdownText');
        if (!span) return;
        const want = String(Math.max(0, Math.ceil(left)));
        const text = span.textContent.replace(/\d+/, want);
        if (text !== span.textContent) span.textContent = text;
    }

    function start(d) {
        dialog = d;
        left = CAP;
        lastTick = performance.now();
        api.active = true;
        observer = new MutationObserver(showOurs);
        observer.observe(d, { childList: true, subtree: true, characterData: true });
        showOurs();
    }

    function stop() {
        if (observer) observer.disconnect();
        observer = null;
        dialog = null;
        api.active = false;
    }

    function playing() {
        const v = document.querySelector('video');
        return !!v && !v.paused && !v.ended;
    }

    function tick() {
        const now = performance.now();
        const dt = (now - lastTick) / 1000;
        lastTick = now;
        const d = visibleDialog();

        if (dialog) {
            // Hidden (Hide pressed, playback ended, next episode started): we're done.
            if (d !== dialog) { stop(); return; }
            if (playing()) left -= dt;
            if (left <= 0) {
                const btn = dialog.querySelector('.btnStartNow');
                stop();
                if (btn) btn.click();
                return;
            }
            showOurs();
            return;
        }

        // Only take over a popup that is counting down from more than the cap.
        if (d && !d._tunerSeen) {
            const n = shownNumber(d);
            if (isNaN(n)) return; // not drawn yet, or no countdown (auto-play off)
            d._tunerSeen = true;
            if (n > CAP) start(d);
        }
        // Jellyfin reuses nothing across popups, but clear the flag on a hidden one anyway
        // so a popup shown again (seek back into the credits) is looked at again.
        const any = document.querySelector('.upNextDialog');
        if (any && any !== d) any._tunerSeen = false;
    }

    // 4 checks a second while a video is on screen, 1 otherwise. A querySelector is cheap,
    // and polling avoids watching the whole page for the popup to appear.
    function loop() {
        tick();
        setTimeout(loop, document.querySelector('video') ? 250 : 1000);
    }
    loop();
})();
