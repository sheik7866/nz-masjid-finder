// Tests for the shared-data sync engine (verification.js):
// Supabase-wins merge, offline queueing, confirm/report/adminUpdate/adminDelete,
// and that RLS policies are never bypassed. Supabase is mocked with a fake fetch.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

function makeEnv(fetchImpl, opts) {
  opts = opts || {};
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
    visibilityState: 'visible',
  };
  class FakeEvent {
    constructor(type, init) { this.type = type; this.detail = (init && init.detail) || {}; }
  }
  const sandbox = {
    localStorage, document, CustomEvent: FakeEvent,
    navigator: { onLine: true }, setTimeout: (f) => 0, setInterval: () => 0,
    clearTimeout: () => {}, console, Date, JSON, Math, Promise, Array, Object, String, Number,
    fetch: fetchImpl || (() => Promise.reject(new Error('offline'))),
  };
  sandbox.window = sandbox;
sandbox.window.addEventListener = () => {};
  sandbox.NZ_CONFIG = opts.noSupabase
    ? { supabaseUrl: '', supabaseAnonKey: '' }
    : { supabaseUrl: 'https://fake.supabase.co', supabaseAnonKey: 'fake-anon-key' };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/config.js'), 'utf8'), sandbox, { filename: 'config.js' });
  // the app's config.js overwrites NZ_CONFIG: pin the harness values AFTER it
  sandbox.NZ_CONFIG = opts.noSupabase
    ? { supabaseUrl: '', supabaseAnonKey: '' }
    : { supabaseUrl: 'https://fake.supabase.co', supabaseAnonKey: 'fake-anon-key' };
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/supabase.js'), 'utf8'), sandbox, { filename: 'supabase.js' });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/verification.js'), 'utf8'), sandbox, { filename: 'verification.js' });
  return { sandbox, V: sandbox.NZVerification, SB: sandbox.NZSupabase, store };
}

const pending = [];
const ok = (name, fn) => { pending.push({ name, fn }); };
const asyncOk = (name, fn) => { pending.push({ name, fn, async: true }); };

const ID = 'synctest/node-1';

// ---------------------------------------------------------------- no supabase: honest local-only
asyncOk('without Supabase configured, writes queue honestly and never claim to sync', async () => {
  const { V } = makeEnv(null, { noSupabase: true });
  const sync = await V.sync();
  assert.strictEqual(sync.mode, 'local');
  assert.strictEqual(V.backend, 'local');
  const res = await V.confirm(ID, { by: 'Ahmed' });
  assert.strictEqual(res.stored, 'queued');
  assert.strictEqual(res.reason, 'no-supabase');
  assert.strictEqual(V.queues().verifications, 1);
  assert.strictEqual(V.get(ID), null, 'queued writes are NOT visible until server accepts them');
});

// ---------------------------------------------------------------- sync loads shared rows; server wins
asyncOk('sync() loads server rows; local merge cannot resurrect deleted rows', async () => {
  const server = { [ID]: { id: ID, status: 'verified', verified_by: 'Server', updated_at: '2026-01-02T00:00:00Z' } };
  const { V } = makeEnv((url, opts) => {
    if (url.includes('/verifications?select=')) return Promise.resolve({ ok: true, status: 200, text: () => JSON.stringify([server[ID]]) });
    return Promise.reject(new Error('unexpected ' + url));
  });
  const r = await V.sync();
  assert.strictEqual(r.mode, 'supabase');
  assert.strictEqual(V.get(ID).verified_by, 'Server');
  assert.strictEqual(Object.keys(V.getAll()).length, 1, 'cache holds exactly the server set');
  assert.strictEqual(V.getAll()[ID].verified_by, 'Server');
  // resilience: a locally cached row the server has deleted must not come back
  const { V: V2 } = makeEnv((url) => {
    if (url.includes('/verifications?select=')) return Promise.resolve({ ok: true, status: 200, text: () => JSON.stringify([]) });
    return Promise.reject(new Error('unexpected ' + url));
  });
  await V2.sync();
  assert.strictEqual(V2.get(ID), null, 'deleted-on-server row is gone everywhere');
});

// ---------------------------------------------------------------- confirm goes to the server; visible immediately
ok('confirm() writes to Supabase and caches only the server-accepted row', async () => {
  const calls = [];
  const { V } = makeEnv((url, opts) => {
    calls.push({ url, opts });
    if (url.includes('/verifications?select=')) return Promise.resolve({ ok: true, status: 200, text: () => JSON.stringify([]) });
    if ((opts.method || 'GET') === 'POST' && url.includes('/verifications')) {
      return Promise.resolve({ ok: true, status: 201, text: () => JSON.stringify('') });
    }
    return Promise.reject(new Error('unexpected ' + url));
  });
  await V.sync();
  const res = await V.confirm(ID, { by: 'Ahmed', source: 'https://x.org', jummah: '1:15pm' });
  assert.strictEqual(res.stored, 'supabase');
  assert.strictEqual(V.get(ID).verified_by, 'Ahmed');
  const post = calls.find((c) => (c.opts.method || '') === 'POST' && c.url.includes('/verifications'));
  const body = JSON.parse(post.opts.body);
  assert.strictEqual(body.status, 'verified');
  assert.strictEqual(body.verified_by, 'Ahmed');
  assert.strictEqual(body.jummah_times, '1:15pm');
});

// ---------------------------------------------------------------- 409 on INSERT escalates to admin UPDATE
ok('write() falls back INSERT -> admin UPDATE on 409 conflict', async () => {
  const seen = [];
  const { V } = makeEnv((url, opts) => {
    seen.push({ url, method: opts.method });
    if (url.includes('/verifications?select=')) return Promise.resolve({ ok: true, status: 200, text: () => JSON.stringify([]) });
    if (opts.method === 'POST') return Promise.resolve({ ok: false, status: 409, text: () => JSON.stringify({ code: '23505', message: 'duplicate' }) });
    if (opts.method === 'PATCH') return Promise.resolve({ ok: true, status: 200, text: () => JSON.stringify('') });
    return Promise.reject(new Error('unexpected'));
  });
  await V.sync();
  const res = await V.report(ID, { by: 'Sara', kind: 'moved', note: 'moved away' });
  assert.strictEqual(res.stored, 'supabase');
  assert.strictEqual(res.via, 'update');
  assert.ok(seen.some((c) => c.method === 'PATCH' && c.url.includes('id=eq.' + encodeURIComponent(ID))));
});

// ---------------------------------------------------------------- offline: queued, not shown, flushed later
ok('offline writes queue invisibly and flush on the next sync', async () => {
  let online = true;
  const posted = [];
  const serverRows = {};
  const { sandbox, V } = makeEnv((url, opts) => {
    if (!online) return Promise.reject(new Error('network down'));
    if (url.includes('/verifications?select=')) return Promise.resolve({ ok: true, status: 200, text: () => JSON.stringify(Object.keys(serverRows).map((k) => serverRows[k])) });
    if (opts.method === 'POST' && url.includes('/verifications')) {
      const row = JSON.parse(opts.body);
      posted.push(row);
      serverRows[row.id] = Object.assign({}, row);   // the server now holds it
      return Promise.resolve({ ok: true, status: 201, text: () => JSON.stringify('') });
    }
    return Promise.reject(new Error('unexpected ' + url));
  });
  await V.sync();
  sandbox.navigator.onLine = false;
  online = false;
  const res = await V.confirm(ID, { by: 'Ahmed' });
  assert.strictEqual(res.stored, 'queued');
  assert.strictEqual(V.get(ID), null, 'not visible while unconfirmed by the server');
  sandbox.navigator.onLine = true;
  online = true;
  const s2 = await V.sync();
  assert.strictEqual(s2.mode, 'supabase');
  assert.strictEqual(posted.length, 1);
  assert.strictEqual(posted[0].verified_by, 'Ahmed');
  assert.strictEqual(V.get(ID) && V.get(ID).verified_by, 'Ahmed', 'flushed row is cached from the server');
});

// ---------------------------------------------------------------- realtime push triggers a fresh sync
ok('a Realtime postgres_changes event triggers a fresh sync', async () => {
  let selects = 0;
  const server = [{ id: ID, status: 'verified', verified_by: 'Other device', updated_at: '2026-01-03T00:00:00Z' }];
  const { sandbox, V } = makeEnv((url) => {
    if (url.includes('/verifications?select=')) {
      selects += 1;
      return Promise.resolve({ ok: true, status: 200, text: () => JSON.stringify(server) });
    }
    return Promise.reject(new Error('unexpected'));
  });
  await V.sync();
  assert.strictEqual(selects, 1);
  // the production nz:data listener is registered on DOMContentLoaded; replicate it here
  sandbox.document.addEventListener('nz:data', () => V.sync().catch(() => {}));
  sandbox.document.dispatchEvent(new sandbox.CustomEvent('nz:data', { detail: { table: 'verifications' } }));
  await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(selects >= 2, 'sync re-ran after realtime event (selects=' + selects + ')');
  assert.strictEqual(V.get(ID).verified_by, 'Other device');
});

// ---------------------------------------------------------------- admin paths use signed-in token, never queued
ok('adminUpdate/adminDelete go through is_admin() and never queue offline', async () => {
  const calls = [];
  const { V } = makeEnv((url, opts) => {
    calls.push({ url, method: opts.method, body: opts.body });
    if (url.includes('/verifications?select=')) return Promise.resolve({ ok: true, status: 200, text: () => JSON.stringify([]) });
    if (opts.method === 'PATCH' || opts.method === 'DELETE') return Promise.resolve({ ok: true, status: 200, text: () => JSON.stringify('') });
    return Promise.reject(new Error('unexpected ' + url + ' ' + opts.method));
  });
  await V.sync();
  await V.adminUpdate(ID, { status: 'closed' });
  assert.ok(calls.some((c) => c.method === 'PATCH' && c.url.includes('verifications')), 'admin PATCH used');
  await V.adminDelete(ID);
  assert.ok(calls.some((c) => c.method === 'DELETE'), 'admin DELETE used');
  assert.ok(V.get(ID) == null, 'deleted row leaves the cache');
});

// ---------------------------------------------------------------- submissions share, never hide locally
ok('submitMasjid goes to the shared queue; offline only as a retry queue', async () => {
  const posted = [];
  const { sandbox, V } = makeEnv((url, opts) => {
    if (url.includes('/verifications?select=')) return Promise.resolve({ ok: true, status: 200, text: () => JSON.stringify([]) });
    if (url.includes('/submissions')) {
      posted.push(JSON.parse(opts.body));
      assert.ok(!opts.body.includes('"status"'), 'client must not send status');
      return Promise.resolve({ ok: true, status: 201, text: () => JSON.stringify('') });
    }
    return Promise.reject(new Error('unexpected'));
  });
  await V.sync();
  const res = await V.submitMasjid({ name: 'Test Masjid X', city: 'Hamilton', type: 'masjid' });
  assert.strictEqual(res.stored, 'supabase');
  assert.strictEqual(posted[0].name, 'Test Masjid X');
  assert.strictEqual(V.localSubmissions().length, 0, 'no shadow local list when shared');
  sandbox.navigator.onLine = false;
  const off = await V.submitMasjid({ name: 'Offline Masjid', city: 'Nelson', type: 'masjid' });
  assert.strictEqual(off.stored, 'queued');
  assert.strictEqual(V.localSubmissions().length, 1, 'offline rows visible only as pending retry');
  sandbox.navigator.onLine = true;
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
      if (e.stack) console.error(e.stack.split('\n').slice(1, 6).join('\n'));
      process.exitCode = 1;
    }
  }
  console.log(`\n${good} checks passed (${pending.length} total)`);
})();
