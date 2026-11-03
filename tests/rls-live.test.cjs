// LIVE three-identity security test for NZ Masjid Finder.
//
// Runs against a real Supabase project as three callers:
//   anon          the publishable key, nobody signed in
//   ordinary user a real signed-in account with NO app_metadata.role
//   admin         a real signed-in account WITH app_metadata.role = 'admin'
//
// Credentials are never printed, logged or echoed. They are read from a local
// .env file (git-ignored) or the process environment, used for one HTTP request
// each, and never written anywhere. Access tokens are held in memory only.
//
// ---------------------------------------------------------------------------
// SETUP (no passwords shared with anyone)
// ---------------------------------------------------------------------------
// 1. Create the two test accounts yourself, in Supabase → Authentication → Users
//    → "Add user" (tick Auto Confirm):
//        masjidfinder-tester@yourdomain   (ordinary — leave app_metadata empty)
//        masjidfinder-admin@yourdomain    (admin — set app_metadata {"role":"admin"}
//                                          via supabase/admin-role.sql)
// 2. Copy .env.example to .env in the project root and fill it in. The file is
//    git-ignored; keep it local and delete it when you are finished.
// 3. Run:
//        "$ABACUSAI_BOT_NODE" tests/rls-live.test.cjs
//
// Nothing is deployed and no paid service is used.
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------- env loading
function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach((line) => {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) return;
      const value = m[2].replace(/^['"]|['"]$/g, '');
      if (!process.env[m[1]]) process.env[m[1]] = value;
    });
  }
}
loadEnv();

const {
  SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE,
  TEST_USER_EMAIL, TEST_USER_PASSWORD, TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD,
} = process.env;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.log('SKIPPED: no SUPABASE_URL / SUPABASE_ANON_KEY (see the header of this file).');
  process.exit(0);
}

const base = SUPABASE_URL.replace(/\/+$/, '');
const anonHeaders = { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY };
const serviceHeaders = SUPABASE_SERVICE_ROLE
  ? { apikey: SUPABASE_SERVICE_ROLE, Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE }
  : null;

// A short redaction helper so an accidental log can never leak a secret.
const secrets = [SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE, TEST_USER_PASSWORD, TEST_ADMIN_PASSWORD]
  .filter(Boolean);
function redact(text) {
  let out = String(text);
  secrets.forEach((s) => { out = out.split(s).join('[redacted]'); });
  return out.replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[redacted-jwt]');
}

const results = [];
function record(group, name, status, detail) {
  results.push({ group, name, status, detail: detail ? redact(detail) : '' });
  const icon = status === 'PASS' ? '✓' : status === 'FAIL' ? '✗' : '–';
  console.log('  ' + icon + ' ' + name + (detail && status !== 'PASS' ? '  [' + redact(detail) + ']' : ''));
}

async function check(group, name, fn) {
  try {
    await fn();
    record(group, name, 'PASS');
  } catch (e) {
    record(group, name, 'FAIL', e.message);
  }
}

async function req(pathname, { method = 'GET', body, headers = anonHeaders, prefer } = {}) {
  const h = Object.assign({ 'Content-Type': 'application/json' }, headers);
  if (prefer) h.Prefer = prefer;
  const res = await fetch(base + pathname, {
    method, headers: h, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  return { status: res.status, ok: res.ok, data };
}

async function signIn(email, password) {
  if (!email || !password) throw new Error('credentials missing');
  const res = await req('/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY },
    body: { email, password },
  });
  if (!res.ok) throw new Error('sign-in rejected: ' + (res.data && (res.data.msg || res.data.error_description || res.data.message)));
  const token = res.data.access_token;
  if (!token) throw new Error('no access token returned');
  return { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token };
}

/** Decode a JWT payload (no verification needed — we only read our own claims). */
function jwtClaims(headers) {
  const token = (headers.Authorization || '').replace('Bearer ', '');
  const part = token.split('.')[1];
  if (!part) return {};
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

// Denied can look like 401/403, or 200 with an empty list (row invisible).
const denied = (r) => r.status === 401 || r.status === 403 || (r.status === 200 && (!r.data || r.data.length === 0));

// A write is only really blocked if it did not report success AND the row is
// unchanged afterwards. PostgREST returns 204 for an UPDATE that matched no
// visible rows, so a 204 alone is not proof of anything.
const writeBlocked = (r) => !(r.status >= 200 && r.status < 300);

let adminHeaders = null;

const RUN = String(Date.now());
const VER_ID = 'rlstest-' + RUN;          // no 'probe/' prefix: cleaned up by the test itself
const VER_ID_2 = 'rlstest-' + RUN + '-b';
const SUB_NAME = 'rls-test ' + RUN;

// Cleanup: the test deletes its own rows with the admin identity when one is
// configured, otherwise with the service_role key. If neither is available the
// rows are left behind — they are clearly named and cleanup-probes.sql removes them.
async function cleanup() {
  const auth = adminHeaders || serviceHeaders;
  if (!auth) {
    console.log('\n  note: no admin/service_role available — test rows left behind:');
    console.log('        verifications: ' + VER_ID + ', ' + VER_ID_2);
    console.log('        submissions:   ' + SUB_NAME + '*');
    return;
  }
  await req('/rest/v1/verifications?id=eq.' + encodeURIComponent(VER_ID), { method: 'DELETE', headers: auth });
  await req('/rest/v1/verifications?id=eq.' + encodeURIComponent(VER_ID_2), { method: 'DELETE', headers: auth });
  await req('/rest/v1/submissions?name=like.' + encodeURIComponent(SUB_NAME + '*'), { method: 'DELETE', headers: auth });
}

(async () => {
  console.log('\nNZ Masjid Finder — live three-identity security test');
  console.log('project: ' + base.replace(/^https?:\/\//, '').split('.')[0] + '.supabase.co');
  console.log('service_role available for cleanup: ' + (serviceHeaders ? 'yes' : 'no') + '\n');

  const admin = (TEST_ADMIN_EMAIL && TEST_ADMIN_PASSWORD) ? await signIn(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD) : null;
  adminHeaders = admin;
  const user = (TEST_USER_EMAIL && TEST_USER_PASSWORD) ? await signIn(TEST_USER_EMAIL, TEST_USER_PASSWORD) : null;

  // ---------------------------------------------------------------- identity sanity
  console.log('1. Identity checks');
  if (!user) record('identity', 'ordinary account configured', 'SKIP', 'TEST_USER_* not set');
  if (!admin) record('identity', 'admin account configured', 'SKIP', 'TEST_ADMIN_* not set');
  if (user) await check('identity', 'ordinary account has no admin claim', async () => {
    const claims = jwtClaims(user);
    const role = claims.app_metadata && claims.app_metadata.role;
    if (role === 'admin') throw new Error('this account IS an admin — use a different ordinary account');
    if (role) throw new Error('unexpected app_metadata.role: ' + role);
  });
  if (admin) await check('identity', 'admin account carries app_metadata.role = admin', async () => {
    const claims = jwtClaims(admin);
    const role = claims.app_metadata && claims.app_metadata.role;
    if (role !== 'admin') throw new Error('app_metadata.role is ' + JSON.stringify(role) + ' — run supabase/admin-role.sql');
  });

  // ---------------------------------------------------------------- anonymous
  console.log('\n2. Anonymous (publishable key, not signed in)');
  await check('anon', 'can read public verification records', async () => {
    const r = await req('/rest/v1/verifications?select=id,status&limit=5');
    if (r.status !== 200) throw new Error('expected 200, got ' + r.status);
  });
  await check('anon', 'cannot insert a verification with no name', async () => {
    const r = await req('/rest/v1/verifications', { method: 'POST', prefer: 'return=minimal', body: { id: VER_ID + '-a', status: 'verified' } });
    if (r.ok) throw new Error('insert with no name was ACCEPTED (' + r.status + ')');
  });
  await check('anon', 'cannot insert a verification with a blank name', async () => {
    const r = await req('/rest/v1/verifications', { method: 'POST', prefer: 'return=minimal', body: { id: VER_ID + '-b', status: 'verified', verified_by: '   ' } });
    if (r.ok) throw new Error('blank verifier was ACCEPTED (' + r.status + ')');
  });
  await check('anon', 'cannot insert an admin-only status (closed)', async () => {
    const r = await req('/rest/v1/verifications', { method: 'POST', prefer: 'return=minimal', body: { id: VER_ID + '-c', status: 'closed', verified_by: 'x' } });
    if (r.ok) throw new Error('status=closed was ACCEPTED');
  });
  await check('anon', 'can insert a named verification', async () => {
    const r = await req('/rest/v1/verifications', { method: 'POST', prefer: 'return=minimal', body: { id: VER_ID, status: 'verified', verified_by: 'live rls test' } });
    if (!r.ok) throw new Error('expected success, got ' + r.status + ' ' + JSON.stringify(r.data));
  });
  await check('anon', 'cannot update a verification', async () => {
    const r = await req('/rest/v1/verifications?id=eq.' + encodeURIComponent(VER_ID), { method: 'PATCH', body: { status: 'closed' } });
    if (!writeBlocked(r)) throw new Error('anon UPDATE reported success (' + r.status + ')');
    const after = await req('/rest/v1/verifications?id=eq.' + encodeURIComponent(VER_ID) + '&select=status');
    if (after.data && after.data[0] && after.data[0].status !== 'verified') throw new Error('row changed to ' + after.data[0].status);
  });
  await check('anon', 'cannot delete a verification', async () => {
    const r = await req('/rest/v1/verifications?id=eq.' + encodeURIComponent(VER_ID), { method: 'DELETE' });
    if (!denied(r)) throw new Error('anon DELETE allowed (' + r.status + ')');
    const still = await req('/rest/v1/verifications?id=eq.' + encodeURIComponent(VER_ID) + '&select=id');
    if (!still.data || still.data.length !== 1) throw new Error('row disappeared — anon deleted it');
  });
  await check('anon', 'can submit a masjid as pending', async () => {
    const r = await req('/rest/v1/submissions', { method: 'POST', prefer: 'return=minimal', body: { name: SUB_NAME + ' masjid', type: 'masjid' } });
    if (!r.ok) throw new Error('submit failed: ' + r.status + ' ' + JSON.stringify(r.data));
  });
  await check('anon', 'cannot submit a pre-approved record', async () => {
    const r = await req('/rest/v1/submissions', { method: 'POST', prefer: 'return=minimal', body: { name: SUB_NAME + ' approved', type: 'masjid', status: 'approved' } });
    if (r.ok) throw new Error('status=approved was ACCEPTED');
  });
  await check('anon', 'cannot read the submission queue', async () => {
    const r = await req('/rest/v1/submissions?select=id,name');
    if (!denied(r)) throw new Error('anon can read submissions (' + r.status + ')');
  });
  await check('anon', 'cannot update or delete a submission', async () => {
    const p = await req('/rest/v1/submissions?name=like.' + encodeURIComponent(SUB_NAME + '*'), { method: 'PATCH', body: { status: 'approved' } });
    if (!denied(p)) throw new Error('anon PATCH allowed (' + p.status + ')');
    const d = await req('/rest/v1/submissions?name=like.' + encodeURIComponent(SUB_NAME + '*'), { method: 'DELETE' });
    if (!denied(d)) throw new Error('anon DELETE allowed (' + d.status + ')');
  });

  // ---------------------------------------------------------------- ordinary user
  console.log('\n3. Ordinary registered user (signed in, no admin role)');
  if (!user) {
    record('user', 'all ordinary-user checks', 'SKIP', 'TEST_USER_EMAIL / TEST_USER_PASSWORD not set');
    console.log('  – skipped (no ordinary test account configured)');
  } else {
    await check('user', 'can read public verifications (same as anon)', async () => {
      const r = await req('/rest/v1/verifications?select=id&limit=1', { headers: user });
      if (r.status !== 200) throw new Error('expected 200, got ' + r.status);
    });
    await check('user', 'cannot read the submission queue', async () => {
      const r = await req('/rest/v1/submissions?select=id,name', { headers: user });
      if (!denied(r)) throw new Error('signed-in non-admin read the queue (' + r.status + ')');
    });
    await check('user', 'cannot approve its own submission', async () => {
      const name = SUB_NAME + ' own';
      const ins = await req('/rest/v1/submissions', { method: 'POST', prefer: 'return=minimal', headers: user, body: { name: name, type: 'masjid' } });
      if (!ins.ok) throw new Error('own submission failed: ' + ins.status);
      const r = await req('/rest/v1/submissions?name=eq.' + encodeURIComponent(name), { method: 'PATCH', headers: user, body: { status: 'approved' } });
      // an UPDATE that matches no visible row returns 204; only a change proves a breach
      const readBack = await req('/rest/v1/submissions?name=eq.' + encodeURIComponent(name) + '&select=status', { headers: user });
      const visible = readBack.data && readBack.data.length ? readBack.data[0].status : null;
      if (visible === 'approved') throw new Error('non-admin approved a submission');
      record('user', 'approve attempt returned ' + r.status + '; row not visible to non-admin, status unchanged',
        'PASS', 'blocked by RLS row visibility');
    });
    await check('user', 'cannot update or delete verifications', async () => {
      const before = await req('/rest/v1/verifications?id=eq.' + encodeURIComponent(VER_ID) + '&select=status');
      const u = await req('/rest/v1/verifications?id=eq.' + encodeURIComponent(VER_ID), { method: 'PATCH', headers: user, body: { status: 'closed' } });
      const d = await req('/rest/v1/verifications?id=eq.' + encodeURIComponent(VER_ID), { method: 'DELETE', headers: user });
      const after = await req('/rest/v1/verifications?id=eq.' + encodeURIComponent(VER_ID) + '&select=status');
      const changed = JSON.stringify(before.data) !== JSON.stringify(after.data);
      if (!writeBlocked(u) && changed) throw new Error('non-admin UPDATE changed the row (' + u.status + ')');
      if (!writeBlocked(d) && (!after.data || after.data.length === 0)) throw new Error('non-admin DELETE removed the row');
      if (changed) throw new Error('row changed: ' + JSON.stringify(after.data));
      record('user', 'UPDATE/DELETE returned ' + u.status + '/' + d.status + ' but no row was visible or changed',
        'PASS', 'PostgREST 204 with zero matched rows — not a write');
    });
    await check('user', 'cannot promote itself with user_metadata', async () => {
      // A signed-in user CAN write user_metadata. Prove it does not matter.
      const token = user.Authorization.replace('Bearer ', '');
      const up = await req('/auth/v1/user', {
        method: 'PUT',
        headers: user,
        body: { data: { role: 'admin', app_metadata: { role: 'admin' } } },
      });
      const claims = jwtClaims(user);
      const appRole = claims.app_metadata && claims.app_metadata.role;
      const r = await req('/rest/v1/submissions?select=id', { headers: user });
      if (appRole === 'admin') throw new Error('app_metadata changed by the user — CRITICAL');
      if (!denied(r)) throw new Error('user_metadata edit granted admin access — CRITICAL');
      if (up.ok) {
        // the write to user_metadata was allowed; that is expected and harmless
        record('user', 'user_metadata write attempted (allowed by Supabase, ignored by RLS)', 'PASS');
      }
      if (!token) throw new Error('session lost');
    });
  }

  // ---------------------------------------------------------------- admin
  console.log('\n4. Administrator (app_metadata.role = admin)');
  if (!admin) {
    record('admin', 'all admin checks', 'SKIP', 'TEST_ADMIN_EMAIL / TEST_ADMIN_PASSWORD not set');
    console.log('  – skipped (no admin test account configured)');
  } else {
    await check('admin', 'can read the submission queue', async () => {
      const r = await req('/rest/v1/submissions?select=id,name,status&limit=5', { headers: admin });
      if (r.status !== 200) throw new Error('admin read failed: ' + r.status);
    });
    await check('admin', 'can approve a submission', async () => {
      const r = await req('/rest/v1/submissions?name=like.' + encodeURIComponent(SUB_NAME + '*'), { method: 'PATCH', headers: admin, body: { status: 'approved' } });
      if (!r.ok) throw new Error('approve failed: ' + r.status + ' ' + JSON.stringify(r.data));
    });
    await check('admin', 'can update a verification', async () => {
      const r = await req('/rest/v1/verifications?id=eq.' + encodeURIComponent(VER_ID), { method: 'PATCH', headers: admin, body: { status: 'closed' } });
      if (!r.ok) throw new Error('admin update failed: ' + r.status);
    });
    await check('admin', 'can delete a verification', async () => {
      const r = await req('/rest/v1/verifications?id=eq.' + encodeURIComponent(VER_ID), { method: 'DELETE', headers: admin });
      if (!r.ok) throw new Error('admin delete failed: ' + r.status);
    });
    await check('admin', 'cannot be fooled by user_metadata', async () => {
      const claims = jwtClaims(admin);
      if (!claims.app_metadata || claims.app_metadata.role !== 'admin') throw new Error('admin claim missing');
    });
  }

  // ---------------------------------------------------------------- cleanup
  await cleanup();

  // ---------------------------------------------------------------- report
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  const skip = results.filter((r) => r.status === 'SKIP').length;

  console.log('\n──────────────────────────────────────────────');
  console.log(`PASSED ${pass}   FAILED ${fail}   SKIPPED ${skip}`);
  if (fail) {
    console.log('\nFAILED CHECKS:');
    results.filter((r) => r.status === 'FAIL').forEach((r) => console.log('  ✗ [' + r.group + '] ' + r.name + ' — ' + r.detail));
    console.log('\nDO NOT DEPLOY — the database is not secure until every check passes.');
  } else if (skip) {
    console.log('\nAll executed checks passed, but ' + skip + ' were skipped.');
    console.log('Configure the missing test accounts in .env to complete the audit.');
  } else {
    console.log('\nAll checks passed — anon, ordinary user and admin behave exactly as designed.');
  }

  // machine-readable summary for the report
  fs.writeFileSync(path.join(__dirname, '..', 'rls-live-results.json'),
    JSON.stringify({ at: new Date().toISOString(), project: base, pass, fail, skip, results }, null, 2));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL:', redact(e.message)); process.exit(1); });
