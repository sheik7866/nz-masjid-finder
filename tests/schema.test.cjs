// Security tests for supabase/schema.sql
//
// These are STATIC policy tests: they parse the SQL and assert the properties
// the security model depends on. They do not run against a live database —
// see tests/rls-live.test.cjs for the live harness.
//
// Run: "$ABACUSAI_BOT_NODE" tests/schema.test.cjs
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const raw = fs.readFileSync(path.join(__dirname, '../supabase/schema.sql'), 'utf8');
const sql = raw.replace(/--[^\n]*/g, '');       // strip comments for assertions
const lower = sql.toLowerCase();
const flat = lower.replace(/\s+/g, ' ');   // whitespace-insensitive view

let pass = 0;
const ok = (name, fn) => { fn(); pass += 1; console.log('  ✓', name); };

const policy = (name) => {
  const re = new RegExp('create policy "' + name + '"[\\s\\S]*?;', 'i');
  const m = sql.match(re);
  return m ? m[0] : null;
};
const allPolicies = [...sql.matchAll(/create policy "([^"]+)"[\s\S]*?;/gi)].map((m) => ({ name: m[1], body: m[0] }));

// ---------------------------------------------------------------- 9. RLS
ok('RLS is enabled AND forced on both tables', () => {
  ['verifications', 'submissions'].forEach((t) => {
    assert.ok(flat.includes('alter table public.' + t + ' enable row level security'), t + ': enable rls');
    assert.ok(flat.includes('alter table public.' + t + ' force row level security'), t + ': force rls');
  });
});

ok('no table is left without RLS', () => {
  const created = [...lower.matchAll(/create table if not exists public\.(\w+)/g)].map((m) => m[1]);
  assert.ok(created.length >= 2, 'tables found');
  created.forEach((t) => {
    assert.ok(flat.includes('alter table public.' + t + ' enable row level security'), t + ' has RLS');
  });
});

// ---------------------------------------------------------------- 4 & 5. admin definition
ok('admin is defined ONLY by app_metadata.role = admin', () => {
  assert.ok(/auth\.jwt\(\)\s*->\s*'app_metadata'\s*->>\s*'role'/i.test(flat),
    'is_admin() reads app_metadata.role');
  assert.ok(/= 'admin'/i.test(flat), 'compared to the literal admin');
});

ok('user_metadata is never used for authorisation', () => {
  // comments may warn about it; executable SQL must not touch it
  const noStrings = sql.replace(/'[^']*'/g, "''");   // strip string literals too
  assert.ok(!/user_metadata/i.test(noStrings), 'no SQL statement may read user_metadata');
  assert.ok(!/raw_user_meta_data/i.test(noStrings), 'no SQL statement may read raw_user_meta_data');
});

ok('every admin policy calls is_admin() — none falls back to "any signed-in user"', () => {
  // Intentional public reads (badges and approved listings) are excluded: both
  // are read-only views of data that is meant to be public. Every write policy,
  // and the admin-only reads, must gate on is_admin().
  const PUBLIC_READS = ['verifications public read', 'submissions approved read'];
  const adminPolicies = allPolicies.filter((p) => /for (update|delete|select)/i.test(p.body) &&
    PUBLIC_READS.indexOf(p.name) === -1);
  assert.ok(adminPolicies.length >= 4, 'expected admin policies, found ' + adminPolicies.length);
  adminPolicies.forEach((p) => {
    assert.ok(/is_admin\(\)/.test(p.body), p.name + ' must gate on is_admin()');
    assert.ok(!/using \(true\)\s*with check \(true\)/i.test(p.body), p.name + ' must not be using(true)');
  });
});

ok('no policy grants update/delete to the bare authenticated role without is_admin()', () => {
  allPolicies.forEach((p) => {
    if (!/for (update|delete)/i.test(p.body)) return;
    assert.ok(/is_admin\(\)/.test(p.body), p.name + ' (update/delete) must use is_admin()');
  });
});

ok('is_admin() is not SECURITY DEFINER (no privilege escalation surface)', () => {
  const fn = sql.match(/create or replace function public\.is_admin\(\)[\s\S]*?\$\$;/i)[0];
  assert.ok(!/security definer/i.test(fn), 'must stay SECURITY INVOKER');
  assert.ok(/set search_path = ''/i.test(fn), 'must pin search_path');
});

// ---------------------------------------------------------------- 1. anon cannot insert 'verified' anonymously
ok('anon INSERT of a verification requires a verifier or reporter name', () => {
  const p = policy('verifications community insert');
  assert.ok(p, 'policy exists');
  assert.ok(/btrim/i.test(p), 'whitespace-only names are rejected by the policy');
});

ok('a whitespace-only name cannot pass as a verifier (live bug found 2026-11-03)', () => {
  assert.ok(/constraint verified_by_not_blank/i.test(sql));
  assert.ok(/length\(btrim\(verified_by\)\) > 0/i.test(sql));
  assert.ok(/constraint reported_by_not_blank/i.test(sql));
});

ok('legacy blank-name rows are sanitised BEFORE the constraint is added (23514 fix)', () => {
  const updateAt = flat.indexOf("update public.verifications set history");
  const addAt = flat.indexOf('add constraint verified_by_not_blank');
  assert.ok(updateAt !== -1, 'migration UPDATE present');
  assert.ok(addAt !== -1, 'constraint add present');
  assert.ok(updateAt < addAt, 'UPDATE must run before ADD CONSTRAINT or the script fails with 23514');
  assert.ok(/where \(verified_by is not null and length\(btrim\(verified_by\)\) = 0\)/.test(flat), 'only blank rows touched');
  assert.ok(/status = case when status = 'verified' then 'unverified' else status end/.test(flat),
    'a blank-name verification is demoted, never silently kept');
  assert.ok(/sanitised:blank_verifier/.test(flat), 'the change is recorded in history');
});

ok('"a name is required" lives in the INSERT policy, not a table constraint (23514 fix)', () => {
  assert.ok(!/constraint community_write_needs_a_name\s+check/i.test(flat),
    'a table-wide constraint would block admin UPDATEs and the repair migration');
  assert.ok(/drop constraint if exists community_write_needs_a_name/.test(flat),
    'legacy installs must have it removed');
  const p = policy('verifications community insert');
  assert.ok(/is not null/.test(p) && /btrim/i.test(p), 'the rule is enforced on insert');
});

ok('the migration runs after the legacy constraint is dropped, before the new one is added', () => {
  const dropLegacy = flat.indexOf('drop constraint if exists community_write_needs_a_name');
  const repair = flat.indexOf('update public.verifications set history');
  const addNew = flat.indexOf('add constraint verified_by_not_blank');
  assert.ok(dropLegacy !== -1 && repair !== -1 && addNew !== -1);
  assert.ok(dropLegacy < repair, 'legacy constraint dropped before the repair UPDATE');
  assert.ok(repair < addNew, 'repair before the new constraints are validated');
});

ok('the migration is idempotent (safe to re-run)', () => {
  assert.ok(/drop constraint if exists verified_by_not_blank/.test(flat));
  assert.ok(/drop constraint if exists reported_by_not_blank/.test(flat));
});

ok('a verification row cannot be "verified" without verified_by (table constraint)', () => {
  assert.ok(/constraint verified_needs_a_name/i.test(sql));
  assert.ok(/status <> 'verified' or coalesce\(verified_by, ''\) <> ''/i.test(sql));
});

ok('community inserts are limited to non-admin statuses', () => {
  const p = policy('verifications community insert');
  assert.ok(/status in \('verified', 'needs_review'\)/i.test(p), 'status whitelist on insert');
  assert.ok(!/status in \([^)]*'closed'[^)]*\)/i.test(p), 'closed/moved/outdated are admin-only transitions');
});

ok('anon cannot UPDATE an existing verification into "verified"', () => {
  const anonUpdate = allPolicies.filter((p) => /for update/i.test(p.body) && /to [^;]*\banon\b/i.test(p.body));
  assert.strictEqual(anonUpdate.length, 0, 'no policy lets anon update');
});

// ---------------------------------------------------------------- 2. submissions only pending
ok('submissions can only be inserted as pending', () => {
  const p = policy('submissions public insert');
  assert.ok(/with check \(status = 'pending'\)/i.test(p));
});

ok('only APPROVED submissions are publicly readable — pending queue stays admin-only', () => {
  const publicReads = allPolicies.filter((p) => /for select/i.test(p.body) &&
    /to [^;]*\banon\b/i.test(p.body) && /on public\.submissions/i.test(p.body));
  assert.strictEqual(publicReads.length, 1, 'exactly one public read policy, for approved rows');
  assert.ok(/using \(status = 'approved'\)/i.test(publicReads[0].body),
    'the public read policy must expose only status=approved');
  const adminRead = policy('submissions admin read');
  assert.ok(adminRead && /to authenticated/i.test(adminRead), 'admin keeps full read via is_admin()');
});

ok('submission input is bounded', () => {
  assert.ok(/length\(btrim\(name\)\) between 1 and 160/i.test(sql));
  assert.ok(/lat between -90 and 90/i.test(sql));
  assert.ok(/lon between -180 and 180/i.test(sql));
  assert.ok(/check \(type in \('masjid','halal','event'\)\)/i.test(sql));
});

// ---------------------------------------------------------------- 3 & 7. ordinary users get nothing extra
ok('ordinary authenticated users get the same minimal grants as anon', () => {
  const grants = [...flat.matchAll(/grant ([^;]+) on public\.(\w+) to ([^;]+);/g)]
    .map((m) => ({ privs: m[1].replace(/\s+/g, ' ').trim(), table: m[2], roles: m[3].replace(/\s+/g, ' ').trim() }));
  const verifyAnon = grants.find((g) => g.table === 'verifications' && g.roles === 'anon, authenticated');
  assert.ok(verifyAnon, 'shared grant for verifications');
  assert.strictEqual(verifyAnon.privs, 'select, insert');
  const subAnon = grants.find((g) => g.table === 'submissions' && g.roles === 'anon, authenticated');
  assert.ok(subAnon, 'shared grant for submissions');
  assert.strictEqual(subAnon.privs, 'select, insert', 'public needs SELECT so the approved-only policy can serve approved rows');
});

ok('no GRANT gives anon UPDATE or DELETE anywhere', () => {
  [...flat.matchAll(/grant ([^;]+) on public\.(\w+) to ([^;]+);/g)].forEach((m) => {
    const roles = m[3];
    if (!/\banon\b/.test(roles)) return;
    assert.ok(!/update/.test(m[1]), 'anon UPDATE grant found');
    assert.ok(!/delete/.test(m[1]), 'anon DELETE grant found');
  });
});

ok('privileges are revoked before they are granted (no inherited access)', () => {
  assert.ok(flat.includes('revoke all on public.verifications from anon, authenticated'));
  assert.ok(flat.includes('revoke all on public.submissions from anon, authenticated'));
  const revokeAt = flat.indexOf('revoke all on public.verifications');
  const grantAt = flat.indexOf('grant select, insert on public.verifications');
  assert.ok(revokeAt !== -1 && grantAt !== -1 && revokeAt < grantAt, 'revoke comes first');
});

ok('an ordinary user cannot approve their own submission (no update path without is_admin)', () => {
  const p = policy('submissions admin update');
  assert.ok(p);
  assert.ok(/using \(public\.is_admin\(\)\)/i.test(p));
  assert.ok(/with check \(public\.is_admin\(\)\)/i.test(p), 'WITH CHECK also requires admin');
});

// ---------------------------------------------------------------- 8. rerunnable
ok('every policy this script creates is dropped first (rerunnable)', () => {
  const created = allPolicies.map((p) => p.name);
  created.forEach((name) => {
    const dropped = new RegExp('drop policy if exists "' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"', 'i');
    assert.ok(dropped.test(sql), 'missing drop for policy ' + name);
  });
});

ok('every drop policy statement targets a real table', () => {
  [...sql.matchAll(/drop policy if exists "[^"]+" on public\.(\w+)/gi)].forEach((m) => {
    assert.ok(['verifications', 'submissions'].includes(m[1]), 'unknown table ' + m[1]);
  });
});

ok('objects are created idempotently', () => {
  assert.ok(/create table if not exists/i.test(sql));
  assert.ok(/create index if not exists/i.test(sql));
  assert.ok(/create or replace function/i.test(sql));
  assert.ok(/add column if not exists/i.test(sql), 'legacy projects migrate safely');
});

// ---------------------------------------------------------------- secrets
ok('no service_role key or JWT is committed in the front end', () => {
  ['config.js', 'supabase.js', 'verification.js', 'admin.js', 'app.js', 'views.js'].forEach((f) => {
    const src = fs.readFileSync(path.join(__dirname, '../public', f), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');
    assert.ok(!/eyJ[A-Za-z0-9_-]{20,}/.test(code), f + ' contains a JWT-like key');
    assert.ok(!/service_role\s*[:=]\s*['"]/.test(code), f + ' assigns a service_role key');
  });
});

ok('the app never sends a status to the submissions endpoint', () => {
  const src = fs.readFileSync(path.join(__dirname, '../public/supabase.js'), 'utf8');
  const create = src.match(/async createSubmission[\s\S]*?\n    },/)[0];
  // the DB forces 'pending'; the client must not send a status column at all
  assert.ok(!/status\s*:\s*sub\.status/.test(create), 'client must not forward a submitted status');
  assert.ok(/const row = \{[\s\S]*?name: sub\.name/.test(create));
});

// ---------------------------------------------------------------- self-check present
ok('the script ships a self-check query for grants and RLS', () => {
  assert.ok(/information_schema\.role_table_grants/i.test(sql));
  assert.ok(/relforcerowsecurity/i.test(sql));
});

console.log(`\n${pass} checks passed`);
