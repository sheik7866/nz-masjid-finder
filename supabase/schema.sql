-- ============================================================================
-- NZ Masjid Finder — Supabase schema (free tier). Run once in the SQL Editor.
-- Safe to re-run: every object is created idempotently and every policy this
-- script owns is dropped by name before it is recreated.
--
-- ---------------------------------------------------------------------------
-- SECURITY MODEL (read this before changing anything)
-- ---------------------------------------------------------------------------
-- Roles in a PostgREST request:
--   anon           the public key in the browser, nobody signed in
--   authenticated  a real signed-in user — but NOT automatically an admin
--   service_role   server-only, bypasses RLS. Never in the browser.
--
-- What each may do:
--
--   anon
--     verifications  SELECT (public badge) + INSERT a first record with a name
--                    and status 'verified' or 'needs_review' ONLY.
--                    No UPDATE, no DELETE, cannot touch an existing row.
--     submissions    INSERT only, and only with status 'pending'.
--                    No SELECT: one person's submission is not public.
--
--   authenticated (ordinary signed-in user)
--     Exactly the same rights as anon for these two tables. Signing in
--     grants nothing extra; admin is a separate, trusted role.
--
--   authenticated + app_metadata.role = 'admin'   (the only admin definition)
--     May read the submission queue, approve/reject submissions, update and
--     delete verification records. Checked with
--     auth.jwt() -> 'app_metadata' ->> 'role' = 'admin'.
--
--   app_metadata can only be written by the service_role (dashboard / Admin
--   API), so a user cannot promote themselves. user_metadata is writable by
--   the user and is therefore NEVER used for authorisation anywhere here.
--
-- Identity of a submission (who submitted it) is the auth user id in
-- submitted_by, not a typed name, so an ordinary user cannot edit or approve
-- their own submission — they have no UPDATE right at all.
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- helpers
-- Single source of truth for "is this caller a trusted admin?".
-- SECURITY INVOKER + STABLE so it is inlined by the planner and cheap.
-- Reads app_metadata from the signed JWT only. Never user_metadata.
create or replace function public.is_admin()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin',
    false
  );
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated;

comment on function public.is_admin() is
  'True only when the JWT app_metadata.role claim is "admin". app_metadata is '
  'service_role-writable only; user_metadata is deliberately ignored.';

-- ---------------------------------------------------------------- tables
create table if not exists public.verifications (
  id             text primary key,              -- OSM id, e.g. 'node/3683039850'
  status         text not null default 'unverified'
                 check (status in ('verified','needs_review','closed','moved','outdated','unverified')),
  verified_by    text,
  verified_at    timestamptz,
  source_url     text,
  jummah_times   text,
  note           text,
  reported_by    text,
  reported_at    timestamptz,
  report_note    text,
  history        jsonb not null default '[]'::jsonb,
  updated_at     timestamptz not null default now(),
  -- a record can never claim to be verified without a named verifier
  constraint verified_needs_a_name
    check (status <> 'verified' or coalesce(verified_by, '') <> ''),
  -- whitespace is not a name: "   " must be rejected, not stored
  constraint verified_by_not_blank
    check (verified_by is null or length(btrim(verified_by)) > 0),
  constraint reported_by_not_blank
    check (reported_by is null or length(btrim(reported_by)) > 0)
);

create table if not exists public.submissions (
  id             uuid primary key default gen_random_uuid(),
  name           text not null check (length(btrim(name)) between 1 and 160),
  type           text not null default 'masjid'
                 check (type in ('masjid','halal','event')),
  address        text,
  city           text,
  postcode       text,
  lat            double precision check (lat is null or (lat between -90 and 90)),
  lon            double precision check (lon is null or (lon between -180 and 180)),
  contact        text,
  website        text,
  notes          text,
  submitted_by   text,          -- auth.uid()::text for signed-in submissions
  status         text not null default 'pending'
                 check (status in ('pending','approved','rejected','merged')),
  created_at     timestamptz not null default now()
);

-- additive migrations for projects that ran an older version of this script
-- (a live project that installed an earlier version needs these constraints
--  added; they are idempotent)
alter table public.verifications
  drop constraint if exists verified_by_not_blank,
  drop constraint if exists reported_by_not_blank;

-- Older versions put the "a name is required" rule in a TABLE constraint,
-- which also applied to admin UPDATEs and made the repair below impossible
-- (23514: community_write_needs_a_name). The rule belongs in the INSERT policy,
-- which is where it now lives, so the table constraint is retired.
alter table public.verifications
  drop constraint if exists community_write_needs_a_name;

-- Clean up legacy rows BEFORE the new constraints are validated, otherwise the
-- ALTER TABLE fails with 23514 on data written by the old policy.
-- A whitespace-only name is not a verification: the record goes back to
-- 'unverified' and the blank name is nulled, with the reason kept in history.
update public.verifications
set history = coalesce(history, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
      'action', 'sanitised:blank_verifier',
      'at', now(),
      'detail', 'whitespace-only verifier name removed by schema migration')),
    status      = case when status = 'verified' then 'unverified' else status end,
    verified_by = null,
    verified_at = null,
    updated_at  = now()
where (verified_by is not null and length(btrim(verified_by)) = 0)
   or (reported_by is not null and length(btrim(reported_by)) = 0);

alter table public.verifications
  add constraint verified_by_not_blank
    check (verified_by is null or length(btrim(verified_by)) > 0),
  add constraint reported_by_not_blank
    check (reported_by is null or length(btrim(reported_by)) > 0);

alter table public.submissions
  add column if not exists type text not null default 'masjid';
alter table public.verifications
  add column if not exists history jsonb not null default '[]'::jsonb;

-- ---------------------------------------------------------------- RLS on
alter table public.verifications enable row level security;
alter table public.submissions   enable row level security;
alter table public.verifications force row level security;
alter table public.submissions   force row level security;

-- ---------------------------------------------------------------- drop every policy we own
-- (policy names are unique per table; listed so re-runs are clean, including
--  names used by earlier versions of this script)
drop policy if exists "verifications public read"        on public.verifications;
drop policy if exists "verifications community insert"   on public.verifications;
drop policy if exists "verifications admin update"       on public.verifications;
drop policy if exists "verifications admin delete"       on public.verifications;
drop policy if exists "submissions public insert"        on public.submissions;
drop policy if exists "submissions approved read"        on public.submissions;
drop policy if exists "submissions admin read"           on public.submissions;
drop policy if exists "submissions admin update"         on public.submissions;
drop policy if exists "submissions admin delete"         on public.submissions;
-- legacy names from the first version of this script
drop policy if exists "verifications are public to read" on public.verifications;
drop policy if exists "anyone can verify with a name"    on public.verifications;
drop policy if exists "admins can update verifications"  on public.verifications;
drop policy if exists "verifications first write"        on public.verifications;
drop policy if exists "verifications admin write"        on public.verifications;
drop policy if exists "anyone can submit a masjid"       on public.submissions;
drop policy if exists "only admins read submissions"     on public.submissions;
drop policy if exists "only admins review submissions"   on public.submissions;

-- ---------------------------------------------------------------- verifications
-- Public read: powers the "Verified" badge. Nothing private is stored here.
create policy "verifications public read"
  on public.verifications for select
  to anon, authenticated
  using (true);

-- Community write: one NEW record, with a name, and only a non-admin status.
-- The "name is required" rule lives HERE (not as a table constraint) so that an
-- admin UPDATE can retire or repair a record whose name is being cleared.
-- 'verified' is allowed here because the verifier must type their own name and
-- it is stored with the row (verified_by) — but a record can never be inserted
-- as 'verified' with an empty name (see verified_needs_a_name).
-- Anything that already exists must go through an admin UPDATE.
create policy "verifications community insert"
  on public.verifications for insert
  to anon, authenticated
  with check (
    -- first insert needs a real (non-blank) name and a non-admin status only.
    -- admins updating the same row afterwards may touch any field, because
    -- UPDATE is governed by "verifications admin update", not this policy,
    -- and PostgREST upserts authenticate against this policy: a plain anon or
    -- signed-in user can never merge into an existing row that is not theirs.
    coalesce(nullif(btrim(coalesce(verified_by, '')), ''), nullif(btrim(coalesce(reported_by, '')), '')) is not null
    and status in ('verified', 'needs_review')
  );

-- Admin only: change or remove.
create policy "verifications admin update"
  on public.verifications for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy "verifications admin delete"
  on public.verifications for delete
  to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------- submissions
-- Anyone may submit, but only ever as 'pending'. A submission can therefore
-- never arrive approved, and anon/authenticated cannot read it back.
create policy "submissions public insert"
  on public.submissions for insert
  to anon, authenticated
  with check (status = 'pending');

-- Public: anyone may read APPROVED submissions — that is what makes an
-- approved masjid/halal spot/event visible on every device. Only status,
-- name and place fields of approved rows are exposed through this policy;
-- selecting the full row is acceptable because contact/notes are public once
-- approved. Pending/rejected rows stay admin-only (see below).
create policy "submissions approved read"
  on public.submissions for select
  to anon, authenticated
  using (status = 'approved');

-- Admin only: read the queue, approve/reject, clean up.
create policy "submissions admin read"
  on public.submissions for select
  to authenticated
  using (public.is_admin());

create policy "submissions admin update"
  on public.submissions for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy "submissions admin delete"
  on public.submissions for delete
  to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------- privileges
-- RLS only filters rows that a role already has a GRANT on, so the grants are
-- part of the security model. anon and authenticated get the same minimal set;
-- admins are distinguished by the policy, not by a broader grant.
revoke all on public.verifications from anon, authenticated;
revoke all on public.submissions   from anon, authenticated;

grant select, insert on public.verifications to anon, authenticated;
grant select, insert on public.submissions   to anon, authenticated;

-- Admins still need UPDATE/DELETE to exist as a privilege for the policy to
-- matter, but only rows passing is_admin() are visible to them.
grant update, delete on public.verifications to authenticated;
grant select, update, delete on public.submissions to authenticated;

-- ---------------------------------------------------------------- indexes
create index if not exists verifications_status_idx on public.verifications (status);
create index if not exists submissions_status_idx   on public.submissions (status, created_at desc);
create index if not exists submissions_type_idx     on public.submissions (type, created_at desc);

-- ---------------------------------------------------------------- self-check
-- Run this after the script. Expected output:
--   * both tables: rls_enabled = true, rls_forced = true
--   * anon:        verifications = INSERT,SELECT | submissions = INSERT
--   * authenticated: verifications = DELETE,INSERT,SELECT,UPDATE
--                    submissions   = DELETE,INSERT,SELECT,UPDATE
--   * the policy list shows is_admin() on every admin policy
select c.relname                                        as table_name,
       c.relrowsecurity                                 as rls_enabled,
       c.relforcerowsecurity                            as rls_forced,
       coalesce(string_agg(
         p.polname || ' (' || array_to_string(p.polroles::regrole[], ',') || ')',
         ' | ' order by p.polname), '(no policies)')    as policies
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
left join pg_policy p on p.polrelid = c.oid
where n.nspname = 'public' and c.relname in ('verifications','submissions')
group by c.relname, c.relrowsecurity, c.relforcerowsecurity;

select table_name, grantee,
       string_agg(privilege_type, ',' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in ('verifications','submissions')
  and grantee in ('anon','authenticated')
group by table_name, grantee
order by table_name, grantee;
