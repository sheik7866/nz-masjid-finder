-- ============================================================================
-- NZ Masjid Finder — grant or revoke the trusted admin role.
--
-- WHY THIS FILE EXISTS
-- Admin is defined as the JWT claim app_metadata.role = 'admin'
-- (see public.is_admin() in schema.sql). app_metadata lives in the
-- auth.users.raw_app_meta_data column, which is writable ONLY by the
-- service_role: the Supabase dashboard SQL Editor runs as a privileged role,
-- and the Admin API runs with the service_role key. A signed-in user can never
-- write it, which is exactly why it is safe for authorisation.
--
-- Do NOT try to do this with the anon/publishable key, and never with a user's
-- own access token: it will not work, and it must not work.
--
-- Everything below is parameterised by EMAIL. Nothing here prints or stores a
-- password.
-- ============================================================================

-- ---------------------------------------------------------------- 1. GRANT
-- Change the email, then run.
update auth.users
set raw_app_meta_data =
      coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role":"admin"}'::jsonb
where email = 'sheik.m.razil@gmail.com';

-- ---------------------------------------------------------------- 2. VERIFY
-- Expect is_admin = true for exactly the admin account(s), false for everyone else.
select email,
       raw_app_meta_data -> 'role'    as app_role,
       (raw_app_meta_data ->> 'role') = 'admin' as is_admin,
       email_confirmed_at is not null as email_confirmed,
       last_sign_in_at
from auth.users
order by is_admin desc, email;

-- ---------------------------------------------------------------- 3. REVOKE
-- Removes the role. The user keeps their account, just without admin rights.
update auth.users
set raw_app_meta_data =
      coalesce(raw_app_meta_data, '{}'::jsonb) - 'role'
where email = 'sheik.m.razil@gmail.com';

-- A revoked admin keeps admin rights until their current access token expires
-- (default 1 hour) because policies read the JWT, not the table. To make it
-- immediate, also invalidate their sessions:
--   Supabase dashboard → Authentication → Users → ⋯ → "Sign out user"
-- or server-side with the service_role key:
--   POST /auth/v1/admin/users/<user-id>/logout?scope=global

-- ---------------------------------------------------------------- 4. AUDIT
-- Who can currently write to the two tables, and who is an admin.
select 'admins' as what, email as detail
from auth.users
where (raw_app_meta_data ->> 'role') = 'admin'
union all
select 'verification rows', count(*)::text from public.verifications
union all
select 'submission rows',   count(*)::text from public.submissions;

-- ---------------------------------------------------------------- 5. FIRST ADMIN, END TO END (no passwords here)
-- 1. Dashboard → Authentication → Users → "Add user".
--    Email: sheik.m.razil@gmail.com   Password: generate a long random one.
--    Tick "Auto Confirm User" so the account is usable immediately.
-- 2. Run section 1 above with that email.
-- 3. Sign in inside the app with the app's ⚙ Admin screen.
-- 4. Confirm section 2 shows is_admin = true for that account and false for all others.
--
-- For the ordinary test account do the same but SKIP step 2 — an account with
-- no app_metadata is an ordinary user, which is what the tests need.
