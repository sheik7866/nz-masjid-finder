// Tests for the Supabase client + offline sync layer, with a fake fetch/localStorage.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

function makeEnv({ config = {}, fetchImpl } = {}) {
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const sandbox = {
    localStorage, console, JSON, Date, Math, Promise, Error, Array, Object, String, Number,
    encodeURIComponent, setTimeout, clearTimeout,
    fetch: fetchImpl || (() => Promise.reject(new Error('no fetch'))),
  };
  sandbox.window = sandbox;
  sandbox.NZ_CONFIG = config;
  vm.createContext(sandbox);
  for (const f of ['supabase.js', 'verification.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public', f), 'utf8'), sandbox, { filename: f });
  }
  return { sandbox, SB: sandbox.NZSupabase, V: sandbox.NZVerification, localStorage };
}

const json = (body, status = 200) => Promise.resolve({
  ok: status < 400,
  status,
  statusText: status < 400 ? 'OK' : 'Error',
  text: () => Promise.resolve(JSON.stringify(body)),
  json: () => Promise.resolve(body),
});

let pass = 0;
async function ok(name, fn) { await fn(); pass += 1; console.log('  ✓', name); }

(async () => {
  await ok('without config the app uses local storage', async () => {
    const { V, SB } = makeEnv();
    assert.strictEqual(SB.enabled, false);
    assert.strictEqual(V.backend, 'local');
    const r = await V.sync();
    assert.strictEqual(r.mode, 'local');
  });

  await ok('confirm writes locally and queues for Supabase', async () => {
    const calls = [];
    const fetchImpl = (url, opts) => {
      calls.push({ url, opts });
      return json([JSON.parse(opts.body)]);
    };
    const { V } = makeEnv({ config: { supabaseUrl: 'https://demo.supabase.co', supabaseAnonKey: 'anon' }, fetchImpl });
    V.confirm('node/1', { by: 'Ahmed', source: 'https://x.org', jummah: '1:15pm' });
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(V.get('node/1').status, 'verified');
    assert.strictEqual(V.get('node/1').verified_by, 'Ahmed');
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].url.includes('/rest/v1/verifications?on_conflict=id'));
    assert.strictEqual(calls[0].opts.method, 'POST');
    assert.strictEqual(calls[0].opts.headers.apikey, 'anon');
    assert.ok(calls[0].opts.headers.Prefer.includes('merge-duplicates'));
    assert.ok(calls[0].opts.headers.Prefer.includes('return=minimal'), 'anon must not request the row back');
  });

  await ok('a failed push stays queued and is retried on next sync', async () => {
    let fail = true;
    const sent = [];
    const fetchImpl = (url, opts) => {
      if (url.includes('select=')) return json([]);
      if (fail) return json({ message: 'network down' }, 503);
      sent.push(JSON.parse(opts.body));
      return json([JSON.parse(opts.body)]);
    };
    const { V } = makeEnv({ config: { supabaseUrl: 'https://demo.supabase.co', supabaseAnonKey: 'anon' }, fetchImpl });
    V.confirm('node/9', { by: 'Sara' });
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(V.lastError, 'error recorded');
    assert.strictEqual(V.get('node/9').status, 'verified', 'still saved locally');

    fail = false;
    const res = await V.sync();
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(res.mode, 'supabase');
    assert.strictEqual(sent.length, 1, 'queued write flushed');
    assert.strictEqual(sent[0].id, 'node/9');
  });

  await ok('sync pulls shared records and newest write wins', async () => {
    const remote = [{
      id: 'node/2', status: 'verified', verified_by: 'Remote Admin',
      verified_at: '2026-01-01T00:00:00Z', updated_at: '2030-01-01T00:00:00Z', history: [],
    }];
    const { V } = makeEnv({
      config: { supabaseUrl: 'https://demo.supabase.co', supabaseAnonKey: 'anon' },
      fetchImpl: () => json(remote),
    });
    const res = await V.sync();
    assert.strictEqual(res.count, 1);
    assert.strictEqual(V.get('node/2').verified_by, 'Remote Admin');
    assert.strictEqual(V.decorate({ id: 'node/2', name: 'X' }).verified, true);
  });

  await ok('report clears verification fields', async () => {
    const { V } = makeEnv();
    V.confirm('node/3', { by: 'A' });
    V.report('node/3', { by: 'B', note: 'closed', kind: 'closed' });
    const rec = V.get('node/3');
    assert.strictEqual(rec.status, 'closed');
    assert.strictEqual(rec.verified_by, null);
    assert.strictEqual(rec.reported_by, 'B');
    assert.strictEqual(V.decorate({ id: 'node/3' }).verified, false);
  });

  await ok('submission goes to Supabase when configured', async () => {
    let body = null;
    const fetchImpl = (url, opts) => {
      if (url.includes('/rest/v1/submissions')) {
        body = JSON.parse(opts.body);
        assert.ok(!opts.headers.Prefer.includes('representation'), 'no row requested back');
        return json(null);
      }
      return json([]);
    };
    const { V } = makeEnv({ config: { supabaseUrl: 'https://demo.supabase.co', supabaseAnonKey: 'anon' }, fetchImpl });
    const res = await V.submitMasjid({ name: 'New Masjid', city: 'Hamilton', lat: '-37.78', lon: '175.28' });
    assert.strictEqual(res.stored, 'supabase');
    assert.strictEqual(res.record.status, 'pending');
    assert.strictEqual(body.name, 'New Masjid');
    assert.strictEqual(body.lat, -37.78);
    assert.strictEqual(body.city, 'Hamilton');
  });

  await ok('submission falls back to the local queue without Supabase', async () => {
    const { V } = makeEnv();
    const res = await V.submitMasjid({ name: 'Offline Masjid', city: 'Nelson' });
    assert.strictEqual(res.stored, 'local');
    assert.strictEqual(V.localSubmissions().length, 1);
    assert.strictEqual(V.localSubmissions()[0].status, 'pending');
  });

  await ok('sign-in stores a session token and uses it on requests', async () => {
    let authHeader = null;
    const fetchImpl = (url, opts) => {
      if (url.includes('/auth/v1/token')) return json({ access_token: 'tok-123', user: { email: 'a@b.c' } });
      authHeader = opts.headers.Authorization;
      return json([]);
    };
    const { SB } = makeEnv({ config: { supabaseUrl: 'https://demo.supabase.co', supabaseAnonKey: 'anon' }, fetchImpl });
    await SB.signIn('admin@nz.nz', 'secret');
    assert.strictEqual(SB.isSignedIn(), true);
    await SB.listSubmissions();
    assert.strictEqual(authHeader, 'Bearer tok-123');
    SB.signOut();
    assert.strictEqual(SB.isSignedIn(), false);
  });

  await ok('admin approve sends a PATCH with the new status', async () => {
    let sent = null;
    const fetchImpl = (url, opts) => { sent = { url, opts }; return json(null); };
    const { SB } = makeEnv({ config: { supabaseUrl: 'https://demo.supabase.co', supabaseAnonKey: 'anon' }, fetchImpl });
    await SB.updateSubmission('uuid-1', { status: 'approved' });
    assert.strictEqual(sent.opts.method, 'PATCH');
    assert.ok(sent.url.includes('id=eq.uuid-1'));
    assert.strictEqual(JSON.parse(sent.opts.body).status, 'approved');
    assert.ok(!sent.opts.headers.Prefer.includes('representation'), 'no row requested back');
  });

  await ok('sign-in error surfaces the Supabase message', async () => {
    const { SB } = makeEnv({
      config: { supabaseUrl: 'https://demo.supabase.co', supabaseAnonKey: 'anon' },
      fetchImpl: () => json({ error_description: 'Invalid login credentials' }, 400),
    });
    await assert.rejects(() => SB.signIn('a@b.c', 'wrong'), /Invalid login credentials/);
  });

  console.log(`\n${pass} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
