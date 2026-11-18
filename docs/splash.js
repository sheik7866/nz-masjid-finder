/* NZ Masjid Finder — launch screen.
 *
 * The greeting lives in the HTML, so it is on screen at first paint instead of
 * waiting for a round trip. This script only takes it away: as soon as the
 * first listings are rendered (app.js calls NZSplash.hide()), and after a hard
 * limit whatever happened, so a slow fetch or a broken script elsewhere can
 * never leave someone stuck behind it.
 */
(() => {
  'use strict';

  const MIN_MS = 550;   // let the name land rather than flash on a warm cache
  const MAX_MS = 5000;  // hard stop: the app is revealed even if boot never ends
  const FADE_MS = 320;  // keep in step with .splash in styles.css
  const started = Date.now();
  let done = false;

  function hide() {
    if (done) return;
    done = true;
    const node = document.getElementById('splash');
    if (!node) return;
    const wait = Math.max(0, MIN_MS - (Date.now() - started));
    setTimeout(() => {
      node.classList.add('is-hidden');
      node.setAttribute('aria-hidden', 'true');
      setTimeout(() => { node.hidden = true; }, FADE_MS);
    }, wait);
  }

  window.NZSplash = { hide };
  setTimeout(hide, MAX_MS);
})();
