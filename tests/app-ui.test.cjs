// Regression tests for the verify hooks in app.js.
//
// The hooks live in a second IIFE, separate from the closure that owns
// updateBackendBadge(). Loading the real script in a VM and firing the events
// it listens for catches a helper that is out of scope (the original crash was
// "ReferenceError: updateBackendBadge is not defined" on every sync) and an
// Undo button wired to a method the store does not expose.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const flush = () => new Promise((resolve) => setImmediate(resolve));

function makeApp() {
  const listeners = {};
  const els = {};
  const node = () => ({
    hidden: false, style: {}, textContent: '', innerHTML: '', value: '', dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {}, getAttribute() { return null; },
    addEventListener(type, fn) {
      this._l = this._l || {};
      (this._l[type] = this._l[type] || []).push(fn);
    },
    appendChild() {}, focus() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
  });
  const document = {
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    querySelectorAll() { return []; },
    getElementById(id) { return (els[id] = els[id] || node()); },
    createElement() { return node(); },
    body: { appendChild() {}, textContent: '' },
    documentElement: {},
    visibilityState: 'visible',
    readyState: 'complete',
    dispatchEvent(ev) { (listeners[ev.type] || []).slice().forEach((fn) => fn(ev)); },
  };
  const layer = () => ({
    addTo() { return this; }, clearLayers() {},
  });
  const V = {
    undoCalls: [],
    confirmed: [],
    isVerifying: () => false,
    setVerifying() {},
    stats: () => ({ verified: 1, flagged: 0 }),
    syncState: () => ({ backend: 'supabase', shared: 3, queued: 0, realtime: false }),
    decorate: (m) => m,
    sync: async () => ({ mode: 'supabase' }),
    subscribe: async () => false,
    exportJson: () => ({ records: [] }),
    clearAll() {},
    confirm: async (id) => { V.confirmed.push(id); return { stored: 'supabase' }; },
    report: async () => ({}),
    async undo(id) { V.undoCalls.push(id); },
  };
  const sandbox = {
    document,
    navigator: { onLine: true },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    console, Date, JSON, Math, Promise, Array, Object, String, Number,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    location: { hash: '' }, history: { replaceState() {} }, alert() {}, CSS: { escape: (s) => s },
    CustomEvent: function (type, init) { this.type = type; this.detail = (init && init.detail) || {}; },
    FormData: class { entries() { return [['by', 'Tester'], ['source', 'https://example.org'], ['jummah', '1:15pm']][Symbol.iterator](); } },
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ masjids: [], meta: {} }) }),
    L: {
      map: () => ({ setView() { return this; }, invalidateSize() {}, flyTo() {} }),
      tileLayer: () => ({ addTo() {} }),
      layerGroup: layer,
      latLngBounds: () => ({}),
      divIcon: () => ({}),
      marker: () => ({ bindPopup() { return this; }, on() { return this; }, addTo() { return this; } }),
      circleMarker: () => ({ addTo() { return this; }, bindPopup() { return this; } }),
    },
    NZVerification: V,
  };
  sandbox.window = sandbox;
  sandbox.window.addEventListener = () => {};
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8'), sandbox, { filename: 'app.js' });
  return { sandbox, els, V };
}

const pending = [];
const ok = (name, fn) => { pending.push({ name, fn }); };

ok('a sync refresh updates the badge instead of crashing on an out-of-scope helper', async () => {
  const { sandbox, els, V } = makeApp();
  const App = sandbox.NZApp;
  let renders = 0;
  App.renderMasjidList = () => { renders += 1; };
  sandbox.document.dispatchEvent(new sandbox.CustomEvent('DOMContentLoaded'));
  await flush();
  await flush();
  App.masjids = [{ id: 'node/1', name: 'Test Masjid', lat: -36.8, lon: 174.7, address: { formatted: '1 Test Rd' }, kind: 'mosque' }];
  const before = renders;
  assert.doesNotThrow(() => sandbox.document.dispatchEvent(new sandbox.CustomEvent('nz:masjids-changed')));
  assert.ok(renders > before, 'the list re-rendered after the sync event');
  assert.strictEqual(els.backendState.textContent, '· shared: 3 record(s)', 'badge text was written');
});

ok('Undo calls the shared store instead of a missing method', async () => {
  const { sandbox, els, V } = makeApp();
  const App = sandbox.NZApp;
  let renders = 0;
  App.renderMasjidList = () => { renders += 1; };
  sandbox.document.dispatchEvent(new sandbox.CustomEvent('DOMContentLoaded'));
  await flush();
  await flush();
  App.masjids = [{ id: 'node/1', name: 'Test Masjid', lat: -36.8, lon: 174.7, address: { formatted: '1 Test Rd' }, kind: 'mosque' }];
  const clicks = els.mList._l.click || [];
  assert.ok(clicks.length > 0, 'the verify hooks registered their click handler');
  for (const fn of clicks) {
    await fn({ target: { closest: (sel) => (sel === '[data-act]' ? { dataset: { id: 'node/1', act: 'undo' } } : null) }, stopPropagation() {} });
  }
  assert.deepStrictEqual(V.undoCalls, ['node/1'], 'undo reached the store');
  assert.ok(renders > 0, 'the card was re-rendered after the undo');
});

ok('saving a confirmation re-renders through the shared badge updater', async () => {
  const { sandbox, els, V } = makeApp();
  const App = sandbox.NZApp;
  let renders = 0;
  App.renderMasjidList = () => { renders += 1; };
  sandbox.document.dispatchEvent(new sandbox.CustomEvent('DOMContentLoaded'));
  await flush();
  await flush();
  App.masjids = [{ id: 'node/1', name: 'Test Masjid', lat: -36.8, lon: 174.7, address: { formatted: '1 Test Rd' }, kind: 'mosque' }];
  const submits = els.mList._l.submit || [];
  assert.ok(submits.length > 0, 'the verify hooks registered their submit handler');
  for (const fn of submits) {
    await fn({
      target: { closest: () => ({ dataset: { id: 'node/1', form: 'confirm' } }) },
      preventDefault() {},
    });
  }
  assert.deepStrictEqual(V.confirmed, ['node/1'], 'confirmation reached the store');
  assert.ok(renders > 0, 'the card re-rendered without a ReferenceError');
});

ok('the walkthrough is modal, keyboard dismissible and replayable', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const tour = fs.readFileSync(path.join(__dirname, '../public/tour.js'), 'utf8');
  assert.ok(/tour\.js\?v=\d+/.test(html), 'tour.js is loaded, with a cache-busting version');
  assert.ok(/id="tourBtn"/.test(html), 'the “How it works” replay link is in the panel');
  assert.ok(tour.includes("'dialog'") && tour.includes('aria-modal'), 'the overlay is announced as a modal dialog');
  assert.ok(tour.includes('Escape') && tour.includes('ArrowRight'), 'Esc closes it and the arrows step through');
  assert.ok(tour.includes("localStorage.setItem(KEY, '1')"), 'the seen-once flag is persisted');
  assert.ok(/prefers-reduced-motion/.test(fs.readFileSync(path.join(__dirname, '../public/styles.css'), 'utf8')), 'the spotlight honours reduced motion');
});

ok('the launch screen greets first, then gets out of the way', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../public/styles.css'), 'utf8');
  const splash = fs.readFileSync(path.join(__dirname, '../public/splash.js'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const tour = fs.readFileSync(path.join(__dirname, '../public/tour.js'), 'utf8');
  assert.ok(/id="splash"/.test(html), 'the splash is in the HTML, so it paints before any script runs');
  assert.ok(/Assalāmu ʿalaykum/.test(html), 'it greets with a Muslim greeting');
  assert.ok(/splash\.js\?v=\d+/.test(html), 'its controller loads with a cache-busting version');
  assert.ok(/\.splash\.is-hidden/.test(css), 'it can be faded out');
  assert.ok(/prefers-reduced-motion/.test(css) && /\.splash-wait span/.test(css), 'the motion is opt-out for reduced-motion users');
  assert.ok(/setTimeout\(hide, MAX_MS\)/.test(splash), 'a hard stop lifts it even if boot never finishes');
  assert.ok(/window\.NZSplash\.hide\(\)/.test(app), 'the app lifts it once the first listings are on screen');
  assert.ok(!/Kia ora/.test(tour), 'the walkthrough no longer opens with “Kia ora”');
  assert.ok(/Assalāmu/.test(tour), 'the walkthrough opens with a Muslim greeting');
  assert.ok(/id=\s*'splash'|getElementById\('splash'\)/.test(tour), 'the walkthrough waits for it to lift');
});

ok('the walkthrough switches to the Prayer screen before the tab-bar step', () => {
  const tour = fs.readFileSync(path.join(__dirname, '../public/tour.js'), 'utf8');
  const prayer = tour.indexOf("tab: 'prayer'");
  const tabbar = tour.indexOf("target: '.tabbar'");
  assert.ok(prayer > 0, 'a step names the Prayer tab');
  assert.ok(tabbar > 0 && prayer < tabbar, 'the Prayer step comes before the tab-bar step');
  assert.ok(/#pTimes li\.next/.test(tour), 'the Prayer step points at the row of the prayer still to come');
  assert.ok(/NZApp\.showTab/.test(tour), 'the step drives the app’s own tab switcher');
  assert.ok(/if \(step\.tab && currentTab\(\) !== step\.tab\) goTab\(step\.tab\)/.test(tour), 'the switch happens when the step is entered');
  assert.ok(/startTab/.test(tour) && /goTab\(startTab\)/.test(tour), 'leaving the tour returns to the tab the visitor came from');
});

(async () => {
  let good = 0;
  for (const t of pending) {
    try {
      await t.fn();
      good += 1;
      console.log('  ✓', t.name);
    } catch (e) {
      console.error('  ✗', t.name, '—', e.message);
      if (e.stack) console.error(e.stack.split('\n').slice(1, 5).join('\n'));
      process.exitCode = 1;
    }
  }
  console.log(`\n${good} checks passed (${pending.length} total)`);
})();
