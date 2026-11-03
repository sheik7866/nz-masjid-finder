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
const sandbox = { localStorage, window: {}, console, Date, JSON, Math };
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/verification.js'), 'utf8'), sandbox);

const V = sandbox.NZVerification;
const assert = require('assert');
let pass = 0;
const ok = (name, fn) => { fn(); pass += 1; console.log('  ✓', name); };

const masjid = { id: 'node/1', name: 'Test Masjid', address: { formatted: '1 Test Rd' }, lat: -36.8, lon: 174.7 };

ok('starts empty', () => {
  assert.strictEqual(Object.keys(V.getAll()).length, 0);
  assert.strictEqual(V.get('node/1'), null);
});

ok('confirm requires a name and stores source + history', () => {
  const rec = V.confirm('node/1', { by: 'Ahmed R.', source: 'https://x.org', jummah: 'Khutbah 1:15pm' });
  assert.strictEqual(rec.status, 'verified');
  assert.strictEqual(rec.verified_by, 'Ahmed R.');
  assert.strictEqual(rec.source_url, 'https://x.org');
  assert.strictEqual(rec.jummah_times, 'Khutbah 1:15pm');
  assert.strictEqual(rec.history.length, 1);
  assert.ok(rec.verified_at);
});

ok('anonymous confirm falls back to "Anonymous" label (never blank)', () => {
  const rec = V.confirm('node/2', { by: '   ' });
  assert.strictEqual(rec.verified_by, 'Anonymous');
});

ok('decorate marks the listing verified and exposes jummah', () => {
  const d = V.decorate({ ...masjid });
  assert.strictEqual(d.verified, true);
  assert.strictEqual(d.status, 'verified');
  assert.strictEqual(d.verified_by, 'Ahmed R.');
  assert.strictEqual(d.jummah_times, 'Khutbah 1:15pm');
});

ok('decorate leaves untouched listings unverified', () => {
  const d = V.decorate({ id: 'node/99', name: 'Other' });
  assert.strictEqual(d.verified, undefined);
  assert.strictEqual(d.verification, undefined);
});

ok('report invalidates a previous verification', () => {
  const rec = V.report('node/1', { by: 'Sara', note: 'Moved', kind: 'moved' });
  assert.strictEqual(rec.status, 'moved');
  assert.ok(rec.verified !== true);
  assert.strictEqual(rec.reported_by, 'Sara');
  assert.strictEqual(rec.history.length, 2);
  assert.ok(V.decorate({ ...masjid }).verified !== true);
});

ok('undo returns a listing to unverified', () => {
  V.confirm('node/1', { by: 'Ahmed' });
  V.undo('node/1');
  assert.strictEqual(V.get('node/1').status, 'unverified');
  assert.ok(V.decorate({ ...masjid }).verified !== true);
});

ok('stats counts verified vs flagged', () => {
  V.clearAll();
  V.confirm('a', { by: 'x' });
  V.confirm('b', { by: 'y' });
  V.report('c', { by: 'z', note: 'closed' });
  const s = V.stats(['a', 'b', 'c', 'd']);
  assert.strictEqual(s.verified, 2);
  assert.strictEqual(s.flagged, 1);
});

ok('export includes name, address and source', () => {
  V.clearAll();
  V.confirm('node/1', { by: 'Ahmed', source: 'https://x.org' });
  const out = V.exportJson([masjid]);
  assert.strictEqual(out.records.length, 1);
  assert.strictEqual(out.records[0].name, 'Test Masjid');
  assert.strictEqual(out.records[0].address, '1 Test Rd');
  assert.strictEqual(out.records[0].source_url, 'https://x.org');
});

ok('verify mode flag round-trips', () => {
  V.setVerifying(true);
  assert.strictEqual(V.isVerifying(), true);
  V.setVerifying(false);
  assert.strictEqual(V.isVerifying(), false);
});

ok('clearAll wipes everything', () => {
  V.confirm('node/1', { by: 'Ahmed' });
  V.clearAll();
  assert.strictEqual(Object.keys(V.getAll()).length, 0);
});

ok('corrupt storage does not throw', () => {
  localStorage.setItem('nzmasjidfinder.verifications.v1', '{not json');
  assert.strictEqual(Object.keys(V.getAll()).length, 0);
});

console.log(`\n${pass} checks passed`);
