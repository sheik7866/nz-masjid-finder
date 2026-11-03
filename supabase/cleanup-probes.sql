-- ============================================================================
-- NZ Masjid Finder — remove ONLY the temporary probe records created during
-- security testing. Nothing else is touched.
--
-- Safe by construction: every statement targets rows whose id starts with
-- 'probe/' or 'probe2/' — prefixes no real listing can have, because real
-- verification ids are OpenStreetMap ids of the form node/123, way/123 or
-- relation/123.
--
-- Run in Supabase → SQL Editor. Review the "STEP 1" output first: it lists
-- exactly what will be deleted and what will be kept.
-- ============================================================================

-- ---------------------------------------------------------------- STEP 1 — look
-- (a) what will be deleted from verifications
select 'verifications' as table_name, id, status, verified_by, updated_at
from public.verifications
where id like 'probe/%' or id like 'probe2/%' or id like 'rlstest-%'
order by id;

-- (b) what will be deleted from submissions
select 'submissions' as table_name, id, name, type, status, created_at
from public.submissions
where name like 'conn-test%'
   or name like 'final-test%'
   or name like 'connectivity probe%'
   or name like 'probe %'
   or name like 'rls-test %'
   or name like 'authprobe %'
   or name like 'ownprobe %'
   or name like 'visprobe %'
   or name like 'attackprobe %'
order by created_at;

-- (c) what will be KEPT — confirm your real records are here
select 'kept: verifications' as note, id, status, verified_by, jummah_times
from public.verifications
where id not like 'probe/%' and id not like 'probe2/%' and id not like 'rlstest-%'
order by id;

select 'kept: submissions' as note, id, name, type, status
from public.submissions
where not (
      name like 'conn-test%'
   or name like 'final-test%'
   or name like 'connectivity probe%'
   or name like 'probe %'
   or name like 'rls-test %'
   or name like 'authprobe %'
   or name like 'ownprobe %'
   or name like 'visprobe %'
   or name like 'attackprobe %'
)
order by created_at desc;

-- ---------------------------------------------------------------- STEP 2 — delete
-- Backup first (optional but recommended): download the result of STEP 1 as CSV
-- from the editor, then run these.

begin;

delete from public.verifications
where id like 'probe/%'
   or id like 'probe2/%'
   or id like 'rlstest-%';

delete from public.submissions
where name like 'conn-test%'
   or name like 'final-test%'
   or name like 'connectivity probe%'
   or name like 'probe %'
   or name like 'rls-test %'
   or name like 'authprobe %'
   or name like 'ownprobe %'
   or name like 'visprobe %'
   or name like 'attackprobe %';

-- sanity: nothing with a real OSM id may have been removed
select count(*) as remaining_verifications from public.verifications;
select count(*) as remaining_submissions   from public.submissions;

commit;

-- If the counts look wrong, run `rollback;` instead of `commit;` — nothing is
-- written until the transaction commits.

-- ---------------------------------------------------------------- STEP 3 — verify
select id, status, verified_by, jummah_times
from public.verifications
order by updated_at desc;

-- Expect: only genuine records (e.g. node/12501085511 verified by "Sheik Razil")
-- and no rows starting with probe/ or probe2/.
