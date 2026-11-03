# NZ Masjid Finder — Security Report

**Project:** `nvpmpygmtsextdmcnoiq.supabase.co`
**Date:** 3 November 2026
**Scope:** Supabase Row Level Security, table grants, admin authorisation, and the
client's behaviour against the live database.
**Status: VERIFIED — 26/26 live checks pass, 0 skipped, 0 failed.**
Three identities (anonymous, ordinary user, administrator) were exercised against
the live database and behaved exactly as designed. Nothing has been deployed and
no paid service has been activated.

No secret key was used, printed or stored during this audit. The only credential
involved is the **publishable** key, which is designed to be public.

---

## 1. Results

### Static audit — `tests/schema.test.cjs` — 29/29 PASS

| # | Check | Result |
|---|---|---|
| 1 | RLS enabled **and forced** on both tables | PASS |
| 2 | No table left without RLS | PASS |
| 3 | Admin defined only by `auth.jwt() -> 'app_metadata' ->> 'role' = 'admin'` | PASS |
| 4 | `user_metadata` / `raw_user_meta_data` never read by any statement | PASS |
| 5 | Every update/delete/select policy calls `is_admin()` | PASS |
| 6 | `is_admin()` is SECURITY INVOKER with pinned `search_path` | PASS |
| 7 | Insert requires a real (trimmed) verifier or reporter name | PASS |
| 8 | `status = 'verified'` impossible without `verified_by` (constraint) | PASS |
| 9 | Community inserts limited to `verified` / `needs_review` | PASS |
| 10 | Submissions insert forced to `pending` | PASS |
| 11 | Submissions not publicly readable | PASS |
| 12 | Input bounded (name 1–160, lat/lon ranges, type whitelist) | PASS |
| 13 | anon and authenticated share the same minimal grants | PASS |
| 14 | No GRANT gives anon UPDATE or DELETE | PASS |
| 15 | `revoke all` runs before grants | PASS |
| 16 | Legacy table constraint retired before repair (23514 fix) | PASS |
| 17 | Migration repairs blank-name rows before adding constraints | PASS |
| 18 | Every created policy is dropped by name first (re-runnable) | PASS |
| 19 | No JWT or service_role key in any client file | PASS |
| 20 | Client never sends a submission status | PASS |
| 21–29 | Supporting checks (indexes, self-check queries, ordering, idempotency) | PASS |

### Live anonymous audit — `tests/rls-live.test.cjs` — 11/11 PASS

Run against the real project with only the publishable key.

| Check | Expected | Actual | Result |
|---|---|---|---|
| Read public verification records | 200 | 200 | PASS |
| Insert verification with no name | denied | 401 RLS | PASS |
| Insert verification with blank name `"   "` | denied | 401 RLS | PASS |
| Insert admin-only status `closed` | denied | 401 RLS | PASS |
| Insert named verification | allowed | 201 | PASS |
| Update a verification | denied | 401 no grant | PASS |
| Delete a verification | denied | 401 no grant | PASS |
| Submit a masjid (pending) | allowed | 201 | PASS |
| Submit pre-approved | denied | 401 RLS | PASS |
| Read submission queue | denied | 401 no grant | PASS |
| Update / delete a submission | denied | 401 no grant | PASS |

### Ordinary-user audit — 9/9 PASS

Run with a real signed-in account (`sheikrazil786987@gmail.com`), whose JWT
carries `app_metadata: {provider, providers}` and no `role` claim —
i.e. a genuine non-admin.

| Check | Expected | Actual | Result |
|---|---|---|---|
| Can read public verifications | 200 | 200 | PASS |
| Cannot read the submission queue | denied | 200 + `[]` (0 rows visible) | PASS |
| Cannot approve its own submission | no change | 204 no-op, status unchanged | PASS |
| Cannot update a verification | no change | 204 no-op, row unchanged | PASS |
| Cannot delete a verification | row remains | 204 no-op, row remains | PASS |
| `is_admin()` for this user | false | `false` | PASS |
| `user_metadata` write accepted by Supabase | yes, but ignored | written, no effect | PASS |
| Cannot self-promote via `user_metadata` | denied | still blocked | PASS |
| Cannot insert a submission with a status | denied | blocked | PASS |

**Important finding about how PostgREST reports denial.** An UPDATE or DELETE that
matches **zero visible rows** returns `204 No Content` — the same code as a
successful write. A naive test reads that as "allowed". The first run of this
suite did exactly that and produced two false failures. The test now proves
blockage two ways: the row is invisible to the non-admin (0 rows returned), and
the stored row is byte-identical afterwards. The verification record
`node/12501085511` was checked directly and is unchanged (`verified`, verifier
"Sheik Razil", Jumu'ah "Salah: 1.40pm").

### Administrator audit — 5/5 PASS

Run with `sheik.m.razil@gmail.com`, whose JWT was confirmed to carry
`app_metadata: {provider: 'email', providers: ['email'], role: 'admin'}`.

| Check | Expected | Actual | Result |
|---|---|---|---|
| Admin claim present in JWT | `role: admin` | present | PASS |
| Can read the submission queue | 200 + rows | 200 | PASS |
| Can approve a submission | 200 | 200 | PASS |
| Can update a verification | 200 | 200 | PASS |
| Can delete a verification | 200 | 200 | PASS |
| Cannot be fooled by `user_metadata` | admin from `app_metadata` only | PASS | PASS |

### Final tally

```
PASSED 26   FAILED 0   SKIPPED 0
All checks passed — anon, ordinary user and admin behave exactly as designed.
```

---

## 2. Defects found and fixed during the audit

| # | Defect | Severity | Fixed by |
|---|---|---|---|
| 1 | `auth.role() = 'authenticated'` made **every signed-in user an admin** | Critical | `public.is_admin()` reading `app_metadata` |
| 2 | anon could insert `status: 'verified'` with any name, and had a broader grant set | High | insert policy whitelist + explicit `revoke`/`grant` |
| 3 | Blank verifier `"   "` accepted as a name (found live, 201) | High | `verified_by_not_blank` / `reported_by_not_blank` + trimmed policy |
| 4 | Migration failed with 23514 on legacy blank-name rows | Medium | repair UPDATE runs before constraints |
| 5 | `community_write_needs_a_name` was a table constraint, blocking the repair | Medium | rule moved to the INSERT policy |
| 6 | Client asked for the inserted submission row back → `permission denied` | High | `Prefer: return=minimal` on submissions and verification upserts |

---

## 3. Requirement coverage

| Requirement | Status | Evidence |
|---|---|---|
| 1. Anon can never insert an anonymous `verified` | **VERIFIED** | live 401 on blank/no name |
| 2. Community submissions only as pending | **VERIFIED** | live 201 pending / 401 approved |
| 3. Ordinary authenticated users get no admin rights | **VERIFIED** | 9/9 live checks as a real non-admin |
| 4. Only `app_metadata` admins read/approve/update/delete | **VERIFIED** | 5/5 live checks as a real admin |
| 5. `user_metadata` never trusted | **VERIFIED** | static (0 references) + live self-promotion attempt failed |
| 6. Public has no UPDATE/DELETE | **VERIFIED** | live 401 ×4 |
| 7. No self-approval of submissions | **VERIFIED** | live: non-admin approve attempt changes nothing |
| 8. SQL safely re-runnable | **VERIFIED** | ran twice on the live project |
| 9. RLS on every table | **VERIFIED** | enabled + forced, self-check query |
| 10. Security tests for 3 identities | **VERIFIED** | 26 live checks, 0 skipped |

---

## 4. Outstanding actions

1. ~~Complete the three-identity audit.~~ **Done — 26/26 pass, 0 skipped.**
2. **Delete the probe rows** with `supabase/cleanup-probes.sql`. The script now
   also removes `rlstest-…` verification ids and `rls-test …` / `authprobe …` /
   `ownprobe …` / `visprobe …` / `attackprobe …` submissions left by test runs.
   It lists what will be deleted and what will be kept before deleting.
3. **Dashboard settings** (not verifiable via API): leaked-password protection on,
   min password 8+, confirm email on, sign-ups off if only you create admins,
   anonymous sign-ins off, service_role key never in client code, Security
   Advisor run, backups confirmed.
4. **Rotate the test passwords.** `sheikrazil786987@gmail.com` (ordinary test) and
   `sheik.m.razil@gmail.com` (admin) both had passwords used during this audit.
   Change them, or delete the ordinary test account, before the app goes public.
   Section 3 of `supabase/admin-role.sql` revokes admin; remember the 1-hour JWT
   caveat if you ever revoke it.

---

## 5. Preserved data

Nothing in this audit touched a genuine record. The real verification on
`node/12501085511` — *Abu Bakr Siddiqui Musalla - Masjid*, verified by
"Sheik Razil", Jumu'ah "Salah: 1.40pm", source `https://abst.co.nz/` — is intact
with its full history. The cleanup SQL only matches `probe/…`, `probe2/…` and
test-named submissions; genuine ids are OSM ids (`node/…`, `way/…`,
`relation/…`) and can never match those prefixes.

---

## 6. Honest limitations

- All 26 live checks ran against the live project with three real identities, but
  this is a functional RLS audit, not a penetration test. No load testing, no
  dependency scanning, no fuzzing of the API surface.
- The admin account used here is a real account with a real password; that
  password must be rotated (see Outstanding actions 4).
- This audit does not cover client-side logic beyond the database boundary, nor
  hosting/Cloudflare configuration, because nothing is deployed yet.
- Ten test rows remain in `verifications` (`probe/…`, `probe2/…`, `rlstest-…`)
  and a handful in `submissions`; run `supabase/cleanup-probes.sql`. The single
  genuine record `node/12501085511` is untouched.
