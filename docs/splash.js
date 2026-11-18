/* NZ Masjid Finder — launch screen.
 *
 * The greeting lives in the HTML, so it is on screen at first paint. This file
 * decides whether it should be, and it runs in <head>, before the body is
 * parsed: a reload inside the same session gets the `.no-splash` class in time
 * for the first paint, so the greeting never flashes. A sessionStorage marker
 * means one launch screen per session — a genuine cold start — rather than one
 * on every page load.
 *
 * When the splash does show, app.js lifts it as soon as the first listings are
 * rendered, with a hard stop below, so a slow fetch or a broken script
 * elsewhere can never leave someone stuck behind it.
 */
(() => {
  'use strict';

  const KEY = 'nzmasjidfinder.launched';
  const MIN_MS = 550;   // let the name land rather than flash on a warm cache
  const MAX_MS = 5000;  // hard stop: the app is revealed even if boot never ends
  const FADE_MS = 320;  // keep in step with .splash in styles.css

  let again = false;
  try {
    again = sessionStorage.getItem(KEY) === '1';
    sessionStorage.setItem(KEY, '1');
  } catch (e) {
    again = false;      // storage blocked (private mode): greet on every load
  }

  if (again) {
    document.documentElement.classList.add('no-splash');
    window.NZSplash = { hide() {} };
    // Keep the element out of the accessibility tree as well as off the screen.
    document.addEventListener('DOMContentLoaded', () => {
      const node = document.getElementById('splash');
      if (!node) return;
      node.hidden = true;
      node.setAttribute('aria-hidden', 'true');
    });
    return;
  }

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
