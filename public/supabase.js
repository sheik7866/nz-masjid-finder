/* NZ Masjid Finder — Supabase REST client (no SDK, no build step, free tier).
 *
 * Talks to the PostgREST endpoint directly with fetch(). Row Level Security in
 * supabase/schema.sql is what actually protects the data, so the anon key is
 * safe to ship in the browser.
 *
 * Endpoints used:
 *   GET    /rest/v1/verifications?select=*            public read (badges)
 *   POST   /rest/v1/verifications                     verify / report (upsert)
 *   PATCH  /rest/v1/verifications?id=eq.<id>          admin edit
 *   GET    /rest/v1/submissions?select=*              admin only
 *   POST   /rest/v1/submissions                       anyone (community form)
 *   PATCH  /rest/v1/submissions?id=eq.<uuid>          admin approve/reject/merge
 *   POST   /auth/v1/token?grant_type=password         admin sign-in
 */
(() => {
  'use strict';

  const cfg = window.NZ_CONFIG || {};
  const url = (cfg.supabaseUrl || '').replace(/\/+$/, '');
  const anonKey = cfg.supabaseAnonKey || '';
  const SESSION_KEY = 'nzmasjidfinder.supabase.session';

  const enabled = Boolean(url && anonKey);

  const getSession = () => {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (e) { return null; }
  };
  const setSession = (s) => {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  };

  const token = () => (getSession() && getSession().access_token) || anonKey;

  function headers(extra) {
    return Object.assign({
      apikey: anonKey,
      Authorization: 'Bearer ' + token(),
      'Content-Type': 'application/json',
    }, extra || {});
  }

  async function request(path, options) {
    if (!enabled) throw new Error('Supabase is not configured');
    const opts = options || {};
    const res = await fetch(url + path, {
      method: opts.method || 'GET',
      headers: headers(opts.headers),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch (e) { data = text; }
    }
    if (!res.ok) {
      const msg = (data && (data.message || data.error_description || data.hint)) || res.statusText;
      const err = new Error(msg || ('HTTP ' + res.status));
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  }

  const q = (s) => encodeURIComponent(s);

  const api = {
    enabled,
    url,
    getSession,
    isSignedIn: () => Boolean(getSession() && getSession().access_token),

    // ---------------------------------------------------------- verifications
    async listVerifications() {
      const rows = await request('/rest/v1/verifications?select=*&order=updated_at.desc&limit=5000');
      const map = {};
      (rows || []).forEach((r) => { map[r.id] = r; });
      return map;
    },

    async upsertVerification(rec) {
      const row = {
        id: rec.id,
        status: rec.status || 'unverified',
        verified_by: rec.verified_by || null,
        verified_at: rec.verified_at || null,
        source_url: rec.source_url || null,
        jummah_times: rec.jummah_times || null,
        note: rec.note || null,
        reported_by: rec.reported_by || null,
        reported_at: rec.reported_at || null,
        report_note: rec.report_note || null,
        history: rec.history || [],
        updated_at: new Date().toISOString(),
      };
      // return=minimal: anon can read verifications, but asking for the row back
      // on an upsert it is not allowed to update would surface an RLS error.
      await request('/rest/v1/verifications?on_conflict=id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: row,
      });
      return row;
    },

    // ---------------------------------------------------------- submissions
    async createSubmission(sub) {
      const row = {
        // status is never sent: the database forces 'pending' on insert.
        name: sub.name,
        address: sub.address || null,
        city: sub.city || null,
        postcode: sub.postcode || null,
        lat: sub.lat != null ? Number(sub.lat) : null,
        lon: sub.lon != null ? Number(sub.lon) : null,
        contact: sub.contact || null,
        website: sub.website || null,
        notes: sub.notes || null,
        submitted_by: sub.submitted_by || null,
      };
      // anon has INSERT but no SELECT on submissions, so we must not ask for the
      // row back — return=representation would fail with "permission denied".
      await request('/rest/v1/submissions', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: row,
      });
      return Object.assign({ status: 'pending' }, row);
    },

    async listSubmissions(status) {
      const filter = status ? '&status=eq.' + q(status) : '';
      return request('/rest/v1/submissions?select=*' + filter + '&order=created_at.desc&limit=500');
    },

    /** Admin only — the database rejects this unless app_metadata.role = 'admin'. */
    async updateSubmission(id, patch) {
      const rows = await request('/rest/v1/submissions?id=eq.' + q(id), {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: patch,
      });
      return rows || { id: id, status: patch.status };
    },

    // ---------------------------------------------------------- auth (admin)
    async signIn(email, password) {
      const res = await fetch(url + '/auth/v1/token?grant_type=password', {
        method: 'POST',
        headers: { apikey: anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error_description || data.msg || data.message || 'Sign-in failed');
      setSession(data);
      return data;
    },

    signOut() { setSession(null); },
  };

  window.NZSupabase = api;
})();
