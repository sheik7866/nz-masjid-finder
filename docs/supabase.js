/* NZ Masjid Finder — Supabase REST client (no SDK, no build step, free tier).
 *
 * Talks to the PostgREST endpoint directly with fetch(). Row Level Security in
 * supabase/schema.sql is what actually protects the data, so the anon key is
 * safe to ship in the browser.
 *
 * Endpoints used:
 *   GET    /rest/v1/verifications?select=*            public read (badges)
 *   POST   /rest/v1/verifications                     create new row (anon community insert)
 *   PATCH  /rest/v1/verifications?id=eq.<id>          admin edit (is_admin() policy)
 *   DELETE /rest/v1/verifications?id=eq.<id>          admin delete (is_admin() policy)
 *   GET    /rest/v1/submissions?select=*              admin only
 *   POST   /rest/v1/submissions                       anyone (community form)
 *   PATCH  /rest/v1/submissions?id=eq.<uuid>          admin approve/reject/merge
 *   POST   /auth/v1/token?grant_type=password         admin sign-in
 *   WS     /realtime/v1/websocket                     live updates (supabase realtime-js protocol)
 *
 * IMPORTANT: anon has INSERT but no UPDATE on verifications, so there is no
 * "upsert" path for anonymous/community users. updateVerification() uses the
 * signed-in token (admin) and the database enforces is_admin().
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

  // ------------------------------------------------------------ realtime
  // Minimal supabase-realtime client (phoenix channels over WebSocket).
  // No dependency — implements just enough of the wire protocol to subscribe
  // to postgres_changes on the two tables. Falls back to polling where WS is
  // unavailable.
  const realtime = {
    socket: null,
    refCounter: 0,
    channels: {},     // topic -> { callbacks: [], joined: bool, ref, joinRef }
    openPromise: null,
    open(urlStr) {
      if (this.openPromise) return this.openPromise;
      this.openPromise = new Promise((resolve, reject) => {
        if (typeof WebSocket === 'undefined') return reject(new Error('no WebSocket'));
        let sock;
        try { sock = new WebSocket(urlStr); }
        catch (e) { this.openPromise = null; return reject(e); }
        this.socket = sock;
        sock.onopen = () => resolve(sock);
        sock.onerror = () => { /* onclose handles it */ };
        sock.onclose = () => {
          this.socket = null;
          this.openPromise = null;
          Object.keys(this.channels).forEach((t) => { this.channels[t].joined = false; });
          document.dispatchEvent(new CustomEvent('nz:realtime', { detail: { state: 'closed' } }));
        };
        sock.onmessage = (ev) => {
          let msg;
          try { msg = JSON.parse(ev.data); } catch (e) { return; }
          const ch = this.channels[msg.topic];
          if (msg.event === 'phx_reply' && ch) {
            if (msg.payload && msg.payload.status === 'ok') {
              ch.joined = true;
              document.dispatchEvent(new CustomEvent('nz:realtime', { detail: { state: 'open', topic: msg.topic } }));
            }
          }
          if (ch && ch.joined && (msg.event === 'postgres_changes')) {
            (msg.payload && msg.payload.data ? [msg.payload.data] : []).forEach((d) => {
              ch.callbacks.forEach((cb) => { try { cb(d); } catch (e) { console.warn(e); } });
            });
            document.dispatchEvent(new CustomEvent('nz:data', { detail: msg.payload ? msg.payload.data : {} }));
          }
        };
      });
      return this.openPromise;
    },
    nextRef() { this.refCounter += 1; return String(this.refCounter); },
    /** Subscribe to postgres changes on one table. onRow({eventType, schema, table, old, new}) */
    async subscribe(table, onRow) {
      if (!enabled) throw new Error('Supabase is not configured');
      const topic = 'realtime:' + table;
      if (!this.channels[topic]) this.channels[topic] = { callbacks: [], joined: false };
      this.channels[topic].callbacks.push(onRow);
      await this.open(url.replace(/^http/, 'ws') + '/realtime/v1/websocket?apikey=' + anonKey + '&vsn=1.0.0');
      const sock = this.socket;
      if (!sock || sock.readyState !== 1) throw new Error('realtime socket not open');
      const send = (event, ref) => sock.send(JSON.stringify({
        topic, event, payload: {
          config: {
            broadcast: { ack: false, self: false },
            presence: { key: '' },
            postgres_changes: [{ event: '*', schema: 'public', table }],
          },
        },
        ref: ref || this.nextRef(),
      }));
      send('phx_join', 'join-' + topic);
      // access token (anon key for public tables) authorises the channel
      sock.send(JSON.stringify({
        topic, event: 'access_token',
        payload: { access_token: token() },
        ref: this.nextRef(),
      }));
      return () => {
        const ch = this.channels[topic];
        if (ch) ch.callbacks = ch.callbacks.filter((cb) => cb !== onRow);
      };
    },
  };

  const api = {
    enabled,
    url,
    realtime,
    getSession,
    isSignedIn: () => Boolean(getSession() && getSession().access_token),

    // ---------------------------------------------------------- verifications
    async listVerifications() {
      const rows = await request('/rest/v1/verifications?select=*&order=updated_at.desc&limit=5000');
      const map = {};
      (rows || []).forEach((r) => { map[r.id] = r; });
      return map;
    },

    /** Field mapping for one verification row (used by create/update). */
    rowOf(rec) {
      return {
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
    },

    /** Community path: INSERT a brand-new verification row (anon-safe). */
    async createVerification(rec) {
      const row = api.rowOf(rec);
      await request('/rest/v1/verifications', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: row,
      });
      return row;
    },

    /** Admin path: UPDATE an existing row. Rejected by RLS unless is_admin(). */
    async updateVerification(id, patch) {
      const row = Object.assign({}, patch, { updated_at: new Date().toISOString() });
      delete row.id;
      const rows = await request('/rest/v1/verifications?id=eq.' + q(id), {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: row,
      });
      return rows || { id };
    },

    /** Admin path: DELETE a row. Rejected by RLS unless is_admin(). */
    async deleteVerification(id) {
      await request('/rest/v1/verifications?id=eq.' + q(id), { method: 'DELETE' });
      return true;
    },

    /** Legacy name kept for callers; routes correctly under the hood. */
    async upsertVerification(rec) {
      // Prefer a community INSERT; if the id already exists (409), escalate to
      // an admin UPDATE — the database decides, per policy, whether it is allowed.
      try {
        return await api.createVerification(rec);
      } catch (e) {
        if (e.status === 409 || (e.body && e.body.code === '23505')) {
          return api.updateVerification(rec.id, rec);
        }
        throw e;
      }
    },

    // ---------------------------------------------------------- submissions
    /** Public: approved submissions are visible to everyone — this is what an
     *  approved masjid/halal spot/event becomes on the map. */
    async listApprovedSubmissions(type) {
      const filter = type ? '&type=eq.' + q(type) : '';
      return request('/rest/v1/submissions?select=*' + filter + '&status=eq.approved&order=created_at.desc&limit=500');
    },

    async createSubmission(sub) {
      const row = {
        // status is never sent: the database forces 'pending' on insert.
        type: sub.type || 'masjid',
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

    /** Admin only — delete a submission (e.g. spam). */
    async deleteSubmission(id) {
      await request('/rest/v1/submissions?id=eq.' + q(id), { method: 'DELETE' });
      return true;
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
