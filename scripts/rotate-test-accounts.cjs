#!/usr/bin/env node
// Rotate the two Supabase test accounts and delete the rows left by the
// security tests, using the service_role key. Compliments
// supabase/cleanup-probes.sql (same filters) for people who would rather run a
// command than paste SQL.
//
//   node scripts/rotate-test-accounts.cjs --dry-run   # show what would change
//   node scripts/rotate-test-accounts.cjs             # rotate + clean up
//
// Needs (from .env, git-ignored, or the process environment):
//   SUPABASE_URL              https://<project>.supabase.co
//   SUPABASE_SERVICE_ROLE     service_role key — server-side only
//   TEST_USER_EMAIL           ordinary test account   (default below)
//   TEST_ADMIN_EMAIL          admin test account      (default below)
//
// The service key is never printed. New passwords are written to .env (mode
// 600) and only shown masked, so a terminal scrollback or CI log does not end
// up holding them. Nothing is rotated or deleted until every check passes, and
// the script refuses to delete a row whose id looks like a real OSM listing.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');
const DEFAULT_USER_EMAIL = 'sheikrazil786987@gmail.com';
const DEFAULT_ADMIN_EMAIL = 'sheik.m.razil@gmail.com';

// ------------------------------------------------------------------ arguments
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log([
    'Usage: node scripts/rotate-test-accounts.cjs [--dry-run] [--no-rotate] [--no-cleanup]',
    '',
    '  --dry-run      list the accounts and probe rows, change nothing',
    '  --no-rotate    only delete the probe rows',
    '  --no-cleanup   only rotate the passwords',
    '',
    'Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE (see the header).',
  ].join('\n'));
  process.exit(0);
}
const DRY_RUN = args.includes('--dry-run');
const DO_ROTATE = !args.includes('--no-rotate');
const DO_CLEANUP = !args.includes('--no-cleanup');

// ------------------------------------------------------------------ env loading
function loadEnv() {
  if (!fs.existsSync(ENV_PATH)) return;
  fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) return;
    const value = m[2].replace(/^['"]|['"]$/g, '');
    if (!process.env[m[1]]) process.env[m[1]] = value;
  });
}
loadEnv();

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE } = process.env;
const USER_EMAIL = process.env.TEST_USER_EMAIL || DEFAULT_USER_EMAIL;
const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL || DEFAULT_ADMIN_EMAIL;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  console.error([
    'Nothing to do: SUPABASE_URL and SUPABASE_SERVICE_ROLE are not set.',
    '',
    'Add the service_role key to the environment (or to the git-ignored .env),',
    'then run this again. The key is server-side only: never put it in',
    'public/config.js, a commit, a chat message or a screenshot.',
  ].join('\n'));
  process.exit(1);
}

const base = SUPABASE_URL.replace(/\/+$/, '');
const authHeaders = {
  apikey: SUPABASE_SERVICE_ROLE,
  Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE,
  'Content-Type': 'application/json',
};

// Never let a secret reach stdout, even through an error message.
function redact(text) {
  let out = String(text == null ? '' : text);
  [SUPABASE_SERVICE_ROLE].filter(Boolean).forEach((s) => { out = out.split(s).join('[redacted]'); });
  return out;
}

async function api(pathname, { method = 'GET', body, prefer } = {}) {
  const headers = Object.assign({}, authHeaders);
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(base + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch (e) { data = text; } }
  if (!res.ok) {
    const detail = data && (data.message || data.msg || data.hint || data.error_description);
    const err = new Error(method + ' ' + pathname.split('?')[0] + ' -> HTTP ' + res.status +
      (detail ? ': ' + detail : ''));
    err.status = res.status;
    throw err;
  }
  return data;
}

// ------------------------------------------------------------------ users
async function listUsers() {
  const users = [];
  for (let page = 1; page <= 20; page += 1) {
    const batch = await api('/auth/v1/admin/users?page=' + page + '&per_page=1000');
    const rows = Array.isArray(batch) ? batch : (batch && batch.users) || [];
    users.push(...rows);
    if (rows.length < 1000) break;
  }
  return users;
}

function findUser(users, email) {
  const wanted = String(email || '').trim().toLowerCase();
  return users.find((u) => String(u.email || '').toLowerCase() === wanted) || null;
}

function newPassword() {
  // 24 URL-safe characters: strong, and safe to paste into .env unchanged.
  return crypto.randomBytes(18).toString('base64url');
}

function mask(value) {
  const s = String(value || '');
  return s.length < 8 ? '********' : s.slice(0, 3) + '…' + s.slice(-2);
}

async function rotateOne(user, email) {
  const password = newPassword();
  await api('/auth/v1/admin/users/' + encodeURIComponent(user.id), {
    method: 'PUT',
    body: { password },
  });
  // Old sessions keep their access token otherwise (1 hour by default).
  try {
    await api('/auth/v1/admin/users/' + encodeURIComponent(user.id) + '/logout?scope=global', { method: 'POST' });
  } catch (e) {
    console.warn('  ! could not sign out ' + email + ' (' + e.message + ') — old sessions expire on their own');
  }
  return password;
}

// ------------------------------------------------------------------ env writer
function upsertEnv(values) {
  const template = path.join(ROOT, '.env.example');
  let text = '';
  if (fs.existsSync(ENV_PATH)) text = fs.readFileSync(ENV_PATH, 'utf8');
  else if (fs.existsSync(template)) text = fs.readFileSync(template, 'utf8');
  if (text && !text.endsWith('\n')) text += '\n';

  Object.keys(values).forEach((key) => {
    const line = key + '=' + values[key];
    const re = new RegExp('^\\s*' + key + '\\s*=.*$', 'm');
    if (re.test(text)) text = text.replace(re, line);
    else text += line + '\n';
  });

  fs.writeFileSync(ENV_PATH, text, { mode: 0o600 });
  try { fs.chmodSync(ENV_PATH, 0o600); } catch (e) { /* best effort on odd filesystems */ }
}

// ------------------------------------------------------------------ probe rows
// Same filters as supabase/cleanup-probes.sql: probe ids and test submission
// names. Everything is selected first and deleted by exact id, so a bad
// pattern can only ever narrow the list, never widen it.
const VERIFICATION_FILTERS = ['id.like.probe/*', 'id.like.probe2/*', 'id.like.rlstest-*'];
const SUBMISSION_FILTERS = [
  'name.like.conn-test*',
  'name.like.final-test*',
  'name.like.connectivity probe*',
  'name.like.probe *',
  'name.like.rls-test *',
  'name.like.authprobe *',
  'name.like.ownprobe *',
  'name.like.visprobe *',
  'name.like.attackprobe *',
];

async function findProbeRows(table, filters) {
  const query = 'select=id&or=' + encodeURIComponent('(' + filters.join(',') + ')');
  const rows = await api('/rest/v1/' + table + '?' + query);
  return (Array.isArray(rows) ? rows : []).map((r) => r.id);
}

function looksLikeRealListing(id) {
  return /^(node|way|relation)\//.test(String(id));
}

async function deleteByIds(table, ids) {
  let deleted = 0;
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const list = chunk.map((id) => '"' + String(id).replace(/"/g, '\\"') + '"').join(',');
    const rows = await api('/rest/v1/' + table + '?id=in.' + encodeURIComponent('(' + list + ')'), {
      method: 'DELETE',
      prefer: 'return=representation',
    });
    deleted += Array.isArray(rows) ? rows.length : chunk.length;
  }
  return deleted;
}

// ------------------------------------------------------------------ main
const CLEANUP_PLAN = [
  { table: 'verifications', filters: VERIFICATION_FILTERS },
  { table: 'submissions', filters: SUBMISSION_FILTERS },
];

/** Read-only: list what would be deleted, and refuse on anything suspicious. */
async function planCleanup() {
  console.log('=== probe rows ===');
  const targets = [];
  for (const { table, filters } of CLEANUP_PLAN) {
    const ids = await findProbeRows(table, filters);
    const real = ids.filter(looksLikeRealListing);
    if (real.length) {
      console.error('  Refusing to continue: ' + real.length + ' id(s) in ' + table +
        ' look like real OSM listings: ' + real.slice(0, 5).join(', '));
      process.exit(2);
    }
    targets.push({ table, ids });
    console.log('  ' + table + ': ' + ids.length + ' row(s) match the probe filters');
    ids.slice(0, 20).forEach((id) => console.log('    - ' + id));
    if (ids.length > 20) console.log('    … ' + (ids.length - 20) + ' more');
  }
  if (DRY_RUN) console.log('  dry run: nothing deleted');
  console.log('');
  return targets;
}

(async () => {
  console.log('Project: ' + base);
  console.log(DRY_RUN ? 'Mode: dry run — nothing will be changed\n' : 'Mode: rotate + clean up\n');

  // Plan (and refuse) before touching anything, so a suspicious row means no
  // password is rotated either.
  const targets = DO_CLEANUP ? await planCleanup() : [];

  if (DO_ROTATE) {
    console.log('=== test accounts ===');
    const users = await listUsers();
    const wanted = [
      { email: USER_EMAIL, label: 'ordinary' },
      { email: ADMIN_EMAIL, label: 'admin' },
    ];
    const found = [];
    wanted.forEach(({ email, label }) => {
      const user = findUser(users, email);
      if (!user) {
        console.log('  · ' + email + ' (' + label + '): NOT FOUND — create it in Authentication → Users');
        return;
      }
      found.push({ user, email, label });
      console.log('  · ' + email + ' (' + label + ', id ' + String(user.id).slice(0, 8) + '…): found');
    });

    if (!found.length) {
      console.log('  No test accounts matched — nothing to rotate.');
    } else if (DRY_RUN) {
      found.forEach(({ email }) => console.log('  would set a new password for ' + email));
    } else {
      const values = {};
      for (const { user, email, label } of found) {
        const password = await rotateOne(user, email);
        values[label === 'admin' ? 'TEST_ADMIN_PASSWORD' : 'TEST_USER_PASSWORD'] = password;
        if (label === 'admin' && email.toLowerCase() === DEFAULT_ADMIN_EMAIL.toLowerCase()) {
          values.TEST_ADMIN_EMAIL = email;
        }
        console.log('  ✓ ' + email + ': password rotated (' + mask(password) + '), sessions signed out');
      }
      if (!values.TEST_USER_EMAIL && findUser(users, USER_EMAIL)) values.TEST_USER_EMAIL = USER_EMAIL;
      upsertEnv(values);
      console.log('  New passwords written to .env (mode 600) as TEST_USER_PASSWORD / TEST_ADMIN_PASSWORD.');
      console.log('  They are shown masked here on purpose — open .env to read them, and delete it when done.');
    }
    console.log('');
  }

  if (DO_CLEANUP && !DRY_RUN) {
    console.log('=== deleting ===');
    for (const { table, ids } of targets) {
      if (!ids.length) continue;
      const deleted = await deleteByIds(table, ids);
      console.log('  ✓ ' + table + ': deleted ' + deleted + ' row(s)');
    }
    for (const { table, filters } of CLEANUP_PLAN) {
      const left = await findProbeRows(table, filters);
      console.log('  ' + table + ' remaining probe rows: ' + left.length);
      if (left.length) process.exitCode = 3;
    }
  }

  console.log('\nDone.');
})().catch((e) => {
  console.error('FAILED: ' + redact(e && e.message ? e.message : e));
  process.exit(1);
});
