/* NZ Masjid Finder — runtime configuration.
 *
 * Paste your FREE Supabase project values here (Project Settings → API):
 *   url     : https://xxxxxxxxxxxx.supabase.co
 *   anonKey : the "anon / public" key (safe in the browser — Row Level Security
 *             decides what it may read and write; never put the service_role key here)
 *
 * Leave them blank and the app still works fully: verifications and submissions
 * are then kept in this browser only (localStorage), offline-friendly.
 */
window.NZ_CONFIG = {
  // Publishable ("anon") key — designed to be public. Row Level Security in
  // supabase/schema.sql is what protects the data. Never put the secret /
  // service_role key here.
  supabaseUrl: 'https://nvpmpygmtsextdmcnoiq.supabase.co',
  supabaseAnonKey: 'sb_publishable_MBCmnFU_-Sft1Xuc8JCCvw_val1ETQd',

  // Where community "missing masjid" submissions are reviewed.
  // Only an account whose app_metadata carries {"role":"admin"} is an admin —
  // see public.is_admin() in supabase/schema.sql. Signing in alone grants nothing.
  adminHint: 'Sign in with an account that has the admin role in Supabase → Authentication.',
};
