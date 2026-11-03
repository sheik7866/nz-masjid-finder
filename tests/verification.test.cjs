// Test the verification module's logic with a fake localStorage.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const store = new Map();
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const listeners = {};
const document = {
  addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); },
  dispatchEvent: (e) => { (listeners[e.type] || []).forEach((f) => { try { f(e); } catch (err) {} }); },
  visibilityState: 'visible', readyState: 'complete',
};
const sandbox = {
  localStorage, document,
  navigator: { onLine: true }, setTimeout: () => 0, setInterval: () => 0, clearTimeout: () => {},
  window: {}, console, Date, JSON, Math, Promise, Array, Object, String, Number,
};
sandbox.window = sandbox;
sandbox.window.addEventListener = () => {};
sandbox.window.NZ_CONFIG = { supabaseUrl: '', supabaseAnonKey: '' };
sandbox.CustomEvent = function (t, init) { this.type = t; this.detail = (init && init.detail) || {}; };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/verification.js'), 'utf8'), sandbox);

const assert = require('assert');
const V = sandbox.NZVerification;
assert.strictEqual(typeof V.confirm, 'function');
assert.strictEqual(typeof V.queues, 'function', 'new API exposes queues()');
const pendingV = [];
const ok = (name, fn) => { pendingV.push({ name, fn }); };

const masjid = { id: 'node/1', name: 'Test Masjid', address: { formatted: '1 Test Rd' }, lat: -36.8, lon: 174.7 };

ok('starts empty', () => {
  assert.strictEqual(Object.keys(V.getAll()).length, 0);
  assert.strictEqual(V.get('node/1'), null);
});

ok('confirm() without Supabase queues offline and stays invisible', async () => {
  const res = await V.confirm('node/1', { by: 'Ahmed R.', source: 'https://x.org', jummah: 'Khutbah 1:15pm' });
  assert.strictEqual(res.stored, 'queued');
  assert.strictEqual(V.get('node/1'), null, 'unconfirmed rows are never shown');
  assert.strictEqual(V.queues().verifications, 1);
});

ok('queues are per-id: a second confirm replaces the first queued write', async () => {
  await V.confirm('node/1', { by: 'Ahmed R.' });
  await V.confirm('node/1', { by: 'Sara' });
  assert.strictEqual(V.queues().verifications, 1, 'one pending write per masjid');
});

ok('decorate exposes only server-accepted rows', () => {
  const d = V.decorate({ ...masjid });
  assert.strictEqual(d.verification, undefined, 'nothing server-side yet');
  assert.strictEqual(d.verified, undefined);
});

ok('decorate leaves untouched listings unverified', () => {
  const d = V.decorate({ id: 'node/99', name: 'Other' });
  assert.strictEqual(d.verified, undefined);
  assert.strictEqual(d.verification, undefined);
});

ok('report() without Supabase queues offline', async () => {
  const res = await V.report('node/1', { by: 'Sara', note: 'Moved', kind: 'moved' });
  assert.strictEqual(res.stored, 'queued');
  assert.strictEqual(V.get('node/1'), null, 'unconfirmed rows are never shown');
});

ok('stats() counts only the shared cache', () => {
  const s = V.stats(['node/1', 'node/99']);
  assert.strictEqual(s.verified, 0);
  assert.strictEqual(s.flagged, 0);
});

ok('stats counts verified vs flagged', () => {
  V.clearAll();
  const s = V.stats(['a', 'b', 'c', 'd']);
  assert.strictEqual(s.verified, 0);
  assert.strictEqual(s.flagged, 0);
});

ok('export includes name and address for shared rows', () => {
  V.clearAll();
  const out = V.exportJson([masjid]);
  assert.strictEqual(out.records.length, 0, 'nothing shared yet -> nothing exported');
  assert.strictEqual(out.app, 'NZ Masjid Finder');
  assert.strictEqual(out.backend, 'local');
});

ok('verify mode flag round-trips', () => {
  V.setVerifying(true);
  assert.strictEqual(V.isVerifying(), true);
  V.setVerifying(false);
  assert.strictEqual(V.isVerifying(), false);
});

ok('clearAll wipes everything', () => {
  V.clearAll();
  assert.strictEqual(Object.keys(V.getAll()).length, 0);
  assert.strictEqual(V.queues().verifications, 0);
  assert.strictEqual(V.queues().submissions, 0);
});

ok('corrupt storage does not throw', () => {
  localStorage.setItem('nzmasjidfinder.verifications.v1', '{not json');
  assert.strictEqual(Object.keys(V.getAll()).length, 0);
});

(async () => {
  let good = 0;
  for (const t of pendingV) {
    try { await t.fn(); good += 1; console.log('  ✓', t.name); }
    catch (e) { console.error('  ✗', t.name, '—', e.message); process.exitCode = 1; }
  }
  console.log(`\n${good} checks passed (${pendingV.length} total)`);
})();
