# NZ Masjid Finder

Every mosque, masjid, Islamic centre and musalla in Aotearoa New Zealand — plus
daily prayer times, verified Jumu'ah times, a halal directory, the Ramadan
calendar and the qibla direction. Free stack end to end, installable on iPhone
and Android, no paid APIs, no keys, no build step.

Live app: `public/index.html` (serve that folder with any static server).

## Features

| Tab | What it does | Data source (all free) |
|---|---|---|
| **Masjids** | Map + searchable list of every masjid, Islamic centre and musalla nationwide; directions via Google and Apple Maps | OpenStreetMap / Overpass |
| **Prayer** | Today's times for your exact location, next-prayer countdown, 7 calculation methods, offline fallback, verified Jumu'ah list | AlAdhan API + built-in solar calculation |
| **Halal** | 223 restaurants, butchers, bakeries and groceries tagged halal, on a map with filters | OpenStreetMap `diet:halal` |
| **Ramadan** | 30-day fasting calendar with real suhoor/iftar times for your coordinates, plus community iftar listings | Hijri calendar maths + solar calculation |
| **Qibla** | Bearing to the Ka'bah from where you are, with live compass on supported phones | Great-circle maths, no API |

Other screens: **🛡 Verify** (per-card confirmation with name + source), **＋ Add**
(community submissions for masjids, halal spots and events), **⚙ Admin**
(approve/reject review queue).

## Security model (Supabase)

Read this before running `supabase/schema.sql`.

| Caller | verifications | submissions |
|---|---|---|
| **anon** (public key, not signed in) | SELECT all · INSERT one new record **with a name**, status `verified` or `needs_review` only | INSERT only, forced `pending`. No read. |
| **authenticated** (ordinary signed-in user) | identical to anon — signing in grants nothing | identical to anon |
| **admin** (`app_metadata.role = 'admin'`) | SELECT, UPDATE, DELETE | SELECT the queue, UPDATE approve/reject, DELETE |
| **service_role** | server only, never in the browser | server only |

Key decisions:

- **Admin is `app_metadata.role = 'admin'`, nothing else.** Checked by one
  function, `public.is_admin()`, which reads `auth.jwt() -> 'app_metadata' ->> 'role'`.
  `app_metadata` can only be written with the `service_role` key (dashboard or
  Admin API), so a user cannot promote themselves.
- **`user_metadata` is never read.** It is user-writable via `updateUser()`, so
  it is not authorisation data. A test fails the build if it appears in the SQL.
- **An anonymous visitor can never create an anonymous "verified" badge.** The
  insert policy requires `verified_by` or `reported_by`, and the table constraint
  `verified_needs_a_name` blocks `status = 'verified'` with an empty verifier
  even for an admin.
- **Submissions arrive `pending` or not at all** (`with check (status = 'pending')`),
  and cannot be read back by the public — one person's submission is not public.
- **Ordinary users cannot approve their own submission**: they have no UPDATE
  grant at all, and the only UPDATE policy calls `is_admin()`.
- **Grants are explicit.** `revoke all … from anon, authenticated` runs first,
  then the minimal grants are re-issued. anon holds `SELECT, INSERT` on
  verifications and `INSERT` on submissions, and nothing else anywhere.
- **RLS is enabled *and forced*** on both tables (`force row level security`
  also applies it to the table owner).
- **Re-runnable**: every policy the script creates is dropped by name first,
  legacy policy names from earlier versions are dropped too, and new columns are
  added with `add column if not exists`.

The script ends with two self-check queries (RLS + forced, and the anon /
authenticated grants) — compare their output to the table above.

### Upgrading a database that ran an older version

Re-running the script is safe. It also **repairs legacy rows** that the old,
looser rules allowed: any verification whose `verified_by` was only whitespace
is demoted to `status = 'unverified'`, the blank name is nulled, and the change
is recorded in `history` as `sanitised:blank_verifier`. That cleanup runs
*before* the new `verified_by_not_blank` constraint is added — without it the
`ALTER TABLE` fails with `23514`.

If you prefer to inspect before repairing, run this first:

```sql
select id, status, verified_by, verified_at
from public.verifications
where verified_by is not null and length(btrim(verified_by)) = 0;
```

### Creating the first administrator (safely)

Never edit the JWT or use the anon key for this. Use one of these:

**Option A — Dashboard (easiest)**
1. Supabase → **Authentication → Users → Add user** → email + password.
2. Click the user → **Edit** → *App metadata* field → paste `{"role":"admin"}`.
3. Save. The user must **sign out and in again** so a new JWT is issued with
   the claim (existing tokens live up to an hour).

**Option B — SQL Editor (exact)**
```sql
update auth.users
set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role":"admin"}'::jsonb
where email = 'you@example.com';
```
`raw_app_meta_data` is the column behind `app_metadata`; it is not writable by
users, only by service-role/dashboard access.

**Option C — Admin API (server-side only)**
```js
await fetch(SUPABASE_URL + '/auth/v1/admin/users/' + userId, {
  method: 'PUT',
  headers: { apikey: SERVICE_ROLE_KEY, Authorization: 'Bearer ' + SERVICE_ROLE_KEY,
             'Content-Type': 'application/json' },
  body: JSON.stringify({ app_metadata: { role: 'admin' } }),
});
```

Verify it worked — this must return `true` for the admin and `false` for a
normal user, run from the SQL editor:
```sql
select email,
       raw_app_meta_data -> 'role' as role,
       (raw_app_meta_data ->> 'role') = 'admin' as is_admin
from auth.users;
```

To remove an admin: set `app_metadata` back to `{}` (or `{"role":"user"}`) the
same way. Their token keeps admin rights until it refreshes, so also
**Authentication → Users → … → Sign out user** if it must be immediate.

### Supabase dashboard settings you must check

| Setting | Where | What to set |
|---|---|---|
| Row Level Security | Table Editor → each table | should show RLS **on** (the script does this; confirm) |
| Leaked-password protection | Authentication → Policies / Providers | turn **on** |
| Minimum password length | Authentication → Providers → Email | 8+ |
| Confirm email | Authentication → Providers → Email | **on** for public sign-ups |
| Sign-ups allowed | Authentication → Providers → Email | **off** if only you create admins — stops strangers making accounts |
| Anonymous sign-ins | Authentication → Providers | **off** (we use the anon key, not anonymous users) |
| Service role key | Project Settings → API | never copy into `config.js` or any client file |
| API rate limits | Project Settings → API | leave the free defaults on |
| Security Advisor | Database → Advisors | run it; fix anything flagged |
| Point-in-time backups | Database → Backups | free tier is daily; check it is enabled |

### Test the policies (do not trust them until this passes)

Static audit — no credentials needed, runs in CI:
```
"$ABACUSAI_BOT_NODE" tests/schema.test.cjs      # 24 checks
```

Live audit — runs against your real project with three identities (anon, an
ordinary user, an admin), then deletes everything it created:
```
SUPABASE_URL=... \
SUPABASE_ANON_KEY=... \
SUPABASE_SERVICE_ROLE=... \
TEST_USER_EMAIL=... TEST_USER_PASSWORD=... \
TEST_ADMIN_EMAIL=... TEST_ADMIN_PASSWORD=... \
"$ABACUSAI_BOT_NODE" tests/rls-live.test.cjs
```

It checks, among others: anon cannot insert `verified` without a name, anon
cannot update or delete anything, submissions can only arrive `pending`, an
ordinary signed-in user cannot read the queue or approve their own submission,
and only the admin can read/approve/update/delete. **If any check fails it
prints DO NOT DEPLOY and exits non-zero.**

## Security audit — how to run it and read it

Three test layers, none of which needs a password to be shared with anyone:

| Layer | What it proves | How to run |
|---|---|---|
| Static | the SQL matches the security model (29 checks) | `"$ABACUSAI_BOT_NODE" tests/schema.test.cjs` |
| Live, anonymous | the public key cannot write, modify or approve anything | `"$ABACUSAI_BOT_NODE" tests/rls-live.test.cjs` (works with only the publishable key) |
| Live, three identities | ordinary users get nothing; only `app_metadata` admins can administer | same script, after you add the two test accounts to `.env` |

### Create the test accounts yourself (no credentials shared)

1. Supabase → **Authentication → Users → Add user**. Tick **Auto Confirm User**.
   - `masjidfinder-tester@yourdomain` — ordinary. **Leave app_metadata empty.**
   - `masjidfinder-admin@yourdomain` — admin. Then run `supabase/admin-role.sql`
     with that email to add `{"role":"admin"}` to `app_metadata`.
2. Copy `.env.example` to `.env` in the project root and fill in the four test
   values. `.env` is git-ignored; delete it when finished.
3. Run `"$ABACUSAI_BOT_NODE" tests/rls-live.test.cjs`.

Use dedicated test accounts, not your real admin login. Passwords stay in
`.env` on your machine; the script reads them for one sign-in request each,
keeps the access tokens in memory, and redacts anything secret from its output.

### Assigning the admin role — trusted server-side process

`app_metadata` is the only thing that grants admin. It lives in
`auth.users.raw_app_meta_data`, which only the **service_role** can write:

- **Dashboard SQL editor** (runs privileged) → `supabase/admin-role.sql`, section 1.
- **Admin API** with the service_role key, server-side only:
  `PUT /auth/v1/admin/users/<id>` with `{"app_metadata":{"role":"admin"}}`.
- **Never** the publishable/anon key, and never a user's own access token —
  both are refused, and must be.

Revoking is the same file, section 3. Note the JWT caveat: a revoked admin keeps
admin rights until their token refreshes (default 1 hour) unless you also sign
them out — section 3 explains how.

### Cleaning up test records

`supabase/cleanup-probes.sql` removes only rows whose id starts with `probe/` or
`probe2/` and submissions named `conn-test…` / `final-test…`. It prints what will
be deleted and what will be kept *before* deleting, and runs inside a
transaction so you can `rollback`. Real listings are untouched: genuine ids are
OSM ids (`node/123`, `way/123`, `relation/123`), which can never start with
`probe`.

## Verification report

Three things checked, with the evidence each one rests on.

### 1. Supabase security and admin permissions

`supabase/schema.sql` is audited by `tests/schema.test.cjs` — 24 checks that fail
if any of these guarantees regress (see **Security model** above for the full table):

| Guarantee | How it is enforced |
|---|---|
| RLS on both tables | `alter table … enable row level security` (raw-SQL tables do **not** get RLS by default) |
| anon can read badges, nothing else private | `revoke all … from anon`, then `grant select, insert` only |
| anon can never edit or delete | no `update`/`delete` grant and no policy targeting anon |
| signing in grants nothing extra | anon and authenticated share the same minimal grants |
| no anonymous verification | policy `with check (coalesce(verified_by, reported_by, '') <> '')` |
| "verified" needs a named verifier | check constraint `verified_needs_a_name`, so it holds even for admins |
| admin is never user-controlled | `app_metadata.role`, never `user_metadata` |
| RLS applies to the table owner too | `force row level security` |
| submissions cannot arrive pre-approved | `with check (status = 'pending')` |
| only trusted admins read/review submissions | `public.is_admin()` on every select/update/delete policy |
| input bounded | name 1–160 chars, lat −90…90, lon −180…180, type whitelist |
| re-running is safe | every old policy is dropped by name first |
| no secret in the browser | config ships empty; a test greps the front end for JWT-shaped strings and service_role assignments |

The script ends with two self-check queries (RLS state and anon/authenticated grants)
so you can confirm the result in the Supabase SQL editor after running it.

**What is *not* confirmed:** I have no credentials for your project, so this is a
static audit of the SQL, not a live penetration test. Create the project, run the
script, paste the two self-check outputs to me and I will confirm the live grants.

### 2. Data sources and attribution

| Dataset | Records | Source | Provenance stored |
|---|---|---|---|
| Masjids / Islamic centres | 118 | Overpass API on the NZ relation | `sources[0].url` on every record, matching its OSM id |
| Halal businesses | 223 | Overpass `diet:halal=yes\|only`, halal butchers, halal cuisine | per-record OSM URL + `meta.provenance.tag_counts` |

Both files carry a `meta.attribution` block (© OpenStreetMap contributors, ODbL 1.0,
copyright URL) and the UI footer renders the same attribution on every screen.
Prayer times credit AlAdhan in the footer, and the offline calculator is our own
code, not borrowed data.

Guard tests: every record must have a valid OSM URL that matches its id, no
unverified Jumu'ah time may ship, and the attribution strings must be present in
`index.html`.

**Known data limitation:** NZ masjids in OSM are thin outside Auckland —
Canterbury 10, Waikato 7, Otago 4, Southland 3, Bay of Plenty 2, and several
regions have only one or two records. That reflects OpenStreetMap coverage, not
the real number of masjids. The **＋ Add** submission form and the **⚙ Admin**
queue are how that gap gets filled.

### 3. Real iPhone

| Behaviour | Status |
|---|---|
| Layout, tab bar, safe-area insets, 16px inputs (no zoom-on-focus) | built for iOS |
| Install to home screen | `manifest.webmanifest` + apple-touch-icon |
| Location permission | `getCurrentPosition` with an iOS-specific error message (Settings → Privacy → Location Services → Safari) |
| Qibla compass | iOS 13+ `DeviceOrientationEvent.requestPermission()` called from a tap; uses `webkitCompassHeading` |
| Compass maths | simulated in Node with real iPhone event shapes: heading 261.2° → needle at 0°, heading 300° → −38.8°, Android `alpha` 90 → heading 270° |
| HTTPS requirement | the Qibla screen warns when `window.isSecureContext` is false, because iOS blocks compass and precise location over plain http |

**What is *not* confirmed:** I cannot run a physical iPhone from here. The JS logic
is tested against simulated iOS events, not on the device. To close that gap:

1. Deploy to Cloudflare Pages (free) so the app is on https.
2. On the iPhone open the URL in Safari, tap **Allow** on both prompts.
3. Send me: a screenshot of the Prayer tab, the Qibla tab with the compass
   enabled, and the Safari address bar (to confirm https).

## Cost — NZ$0

| Item | Cost |
|---|---|
| Hosting (Cloudflare Pages / Netlify / GitHub Pages free tier) | $0 |
| Map tiles (OpenStreetMap) | $0 |
| Prayer times (AlAdhan API) | $0 |
| Masjid + halal data (Overpass API) | $0 |
| Backend, if enabled (Supabase free tier) | $0 |
| Domain, optional | ~NZ$20/yr |

Nothing in this project needs a card. If you later want a custom domain or a paid
tier, ask me first — I will not enable anything billable without your go-ahead.

## Prayer time accuracy

The app calls AlAdhan first and falls back to a built-in solar calculation if the
API is unreachable (offline, plane, poor signal). The fallback was checked against
AlAdhan on three NZ reference days and agrees within 1–3 minutes:

| Place & date | Fajr | Sunrise | Dhuhr | Asr | Maghrib | Isha |
|---|---|---|---|---|---|---|
| Auckland 3 Nov 2026 (AlAdhan) | 04:37 | 06:14 | 13:04 | 16:50 | 19:55 | 21:26 |
| Auckland 3 Nov 2026 (offline calc) | 04:38 | 06:15 | 13:06 | 16:51 | 19:56 | 21:25 |
| Christchurch 3 Nov 2026 (AlAdhan) | 04:17 | 06:09 | 13:13 | 17:06 | 20:17 | 22:02 |
| Christchurch 3 Nov 2026 (offline calc) | 04:19 | 06:10 | 13:14 | 17:07 | 20:18 | 22:00 |

Prayer times are *calculations*, never claims about a specific masjid. Jumu'ah
times only appear once a person has verified them in the app.

## What works today

- **118 real listings** from OpenStreetMap, nationwide (all 16 NZ regions probed).
- Leaflet map, marker popups, Google + Apple Maps directions, tap-to-call.
- Search by name, city, suburb, postcode; filters for region, type, contact
  details, verified-only.
- **Near me** using the browser's location permission (list re-sorts by distance).
- **Verification buttons**: every card can be confirmed or reported, with the
  verifier's name, the source URL and Jumu'ah time recorded. Nothing is ever
  marked verified anonymously, and no prayer time is invented.

## Data pipeline

```
python scripts/build_data.py                  # masjids: live Overpass fetch (nationwide)
python scripts/build_halal.py                 # halal businesses: live Overpass fetch
python scripts/build_data.py  --input data/cache-overpass.json   # offline rebuild
python scripts/build_halal.py --input data/cache-halal.json
cp data/masjids.json data/halal.json public/data/
```

Outputs:
- `data/masjids.json` — the dataset the app loads
- `data/report.json` — counts, missing address/contact lists, duplicate candidates

`data/overrides.json` (optional) holds hand-verified corrections keyed by OSM id,
e.g. `{"node/3683039850": {"verified": true, "verified_by": "Admin", "jummah_times": "..."}}`.

## Verification model

1. A listing is **unverified** by default — it only mirrors OSM.
2. In the app, press **🛡 Verify** → each card gets **✓ Confirm details** and
   **Report issue**. Confirming stores: name, timestamp, source URL, optional
   Jumu'ah time. Reporting marks it `needs_review` and drops any prior verification.
3. **Export verified** downloads `nz-masjid-verifications-<date>.json` — the review
   artefact you merge into `data/overrides.json` or upload to Supabase.
4. Shared storage (optional, free): run `supabase/schema.sql` in a Supabase project,
   then swap the `NZVerification` store from localStorage to the Supabase table.

## Backend (Supabase, free tier)

The app is a static site, so the "backend" is Supabase Postgres + REST + auth — no
server to deploy. It does three jobs: share verifications between devices, collect
community submissions, and gate admin actions.

**Setup (5 minutes, no card required)**

1. Create a project at supabase.com (free tier: 500 MB database, 50k monthly users).
2. SQL Editor → paste `supabase/schema.sql` → Run. That creates `verifications` and
   `submissions` with Row Level Security: anyone may read a badge, inserts need a
   name, only signed-in users may review.
3. Authentication → Users → *Add user* → email + password. That account is the admin.
4. Project Settings → API → copy **Project URL** and the **anon public** key.
5. Paste both into `public/config.js` (`supabaseUrl`, `supabaseAnonKey`). Commit.

**Never put the `service_role` key in `config.js`** — the anon key is the only one
safe in a browser; RLS is what protects the data.

**How the app behaves**

| Supabase configured? | Verifications | Submissions | Admin |
|---|---|---|---|
| Yes | shared, live for everyone | shared review queue | email/password sign-in |
| No / offline | this browser only | queued locally | local queue only |

Writes go to localStorage first, then push to Supabase; a failed push stays queued
and is retried on the next load (`· offline — queued` in the verification bar).

## Screens

- **🛡 Verify** — per-card confirm/report (name + source + optional Jumu'ah time).
- **＋ Add** — community submission form, with "use my current location" for coordinates.
- **⚙ Admin** — sign-in, pending submissions with approve/reject, flagged listings.

## Tests

```
sh tests/run-all.sh
```

70 checks across four suites (plus the live RLS audit):

- `tests/verification.test.cjs` (12) — verify / report / undo / export / corrupt storage
- `tests/supabase.test.cjs` (10) — offline queue, sync, submissions, sign-in, admin PATCH
- `tests/core.test.cjs` (30) — prayer maths vs AlAdhan, timezone, next-prayer, qibla
  bearings, Hijri dates, Ramadan calendar, dataset sanity, source URLs, region
  assignment, attribution, and a guard that no unverified Jumu'ah time is shipped
- `tests/schema.test.cjs` (24) — RLS, grants, policies, admin role, constraints, rerunnability
- `tests/rls-live.test.cjs` — live three-identity audit against your project (skips without credentials)

## Deploy

**Live:** https://sheik7866.github.io/nz-masjid-finder/

The site auto-publishes from the `docs/` folder on `main` via GitHub Pages —
free, HTTPS, no build step. After any change to `public/`:

```
sh scripts/sync_docs.sh
git add docs <changed files> && git commit -m "..." && git push
```

`docs/` is a mirror; edit `public/` and re-sync, never the other way round.

Alternatives (also free, same output directory `public/`): Cloudflare Pages
(recommended if you want your own domain + global CDN) and
app.netlify.com/drop (drag-and-drop). Netlify and GitHub Pages work the same way: publish `public/` as-is.

Add to home screen on iPhone (Share → Add to Home Screen) or Android
(Chrome menu → Install app) — `manifest.webmanifest` makes it open full-screen
with its own icon.

## Maintenance

- Re-run `scripts/build_data.py` and `scripts/build_halal.py` monthly, commit `data/`.
- OSM data © OpenStreetMap contributors, ODbL — attribution stays in the footer.
- Prayer times © AlAdhan (free public API), with local calculation as fallback.

## Deploy (free)

- **Cloudflare Pages / Netlify / GitHub Pages**: publish the `public/` folder as-is.
  No build command, no environment variables.
- Custom domain optional; all tiles and libraries load from free CDNs.

## Maintenance

- Re-run `build_data.py` monthly to pick up OSM edits, then commit `data/`.
- OSM data © OpenStreetMap contributors, ODbL — attribution stays in the footer.
