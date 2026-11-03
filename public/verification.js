/* NZ Masjid Finder — community verification layer.
 *
 * Two stores, one API:
 *   • Supabase (free tier) when public/config.js has a URL + anon key — shared
 *     between devices and visible to the admin dashboard.
 *   • localStorage otherwise / when offline — the app keeps working, and the
 *     queued writes are pushed to Supabase on the next successful load.
 *
 * A record is "verified" ONLY when a person confirms the details against the
 * masjid's own source and their name + that source URL are stored with it.
 */
(() => {
  'use strict';

  const KEY = 'nzmasjidfinder.verifications.v1';
  const QUEUE_KEY = 'nzmasjidfinder.verifyQueue.v1';
  const MODE_KEY = 'nzmasjidfinder.verifyMode';
  const SUB_KEY = 'nzmasjidfinder.submissions.v1';

  const SB = window.NZSupabase || { enabled: false };

  const readJson = (k, fallback) => {
    try { return JSON.parse(localStorage.getItem(k) || JSON.stringify(fallback)); }
    catch (e) { return fallback; }
  };
  const writeJson = (k, v) => {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn('storage full', e); }
  };

  let cache = readJson(KEY, {});          // id -> record
  let queue = readJson(QUEUE_KEY, []);    // pending Supabase writes
  let synced = false;
  let lastError = null;

  const nowIso = () => new Date().toISOString();

  const persist = () => writeJson(KEY, cache);
  const persistQueue = () => writeJson(QUEUE_KEY, queue);

  function mergeRemote(remoteMap) {
    Object.keys(remoteMap || {}).forEach((id) => {
      const remote = remoteMap[id];
      const local = cache[id];
      // most recent write wins
      if (!local || String(remote.updated_at || '') >= String(local.updated_at || local.verified_at || '')) {
        cache[id] = remote;
      }
    });
    persist();
  }

  async function flushQueue() {
    if (!SB.enabled || !queue.length) return;
    const remaining = [];
    for (const rec of queue) {
      try {
        await SB.upsertVerification(rec);
      } catch (e) {
        remaining.push(rec);
        lastError = e.message;
      }
    }
    queue = remaining;
    persistQueue();
  }

  const api = {
    get backend() {
      return SB.enabled ? (synced ? 'supabase' : 'supabase-offline') : 'local';
    },
    get lastError() { return lastError; },

    /** Load shared records (no-op when Supabase is not configured). */
    async sync() {
      if (!SB.enabled) return { mode: 'local' };
      try {
        const remote = await SB.listVerifications();
        mergeRemote(remote);
        synced = true;
        lastError = null;
        await flushQueue();
        return { mode: 'supabase', count: Object.keys(remote).length, queued: queue.length };
      } catch (e) {
        synced = false;
        lastError = e.message;
        return { mode: 'local', error: e.message, queued: queue.length };
      }
    },

    getAll: () => cache,
    get: (id) => cache[id] || null,

    isVerifying: () => localStorage.getItem(MODE_KEY) === '1',
    setVerifying(on) { localStorage.setItem(MODE_KEY, on ? '1' : '0'); },

    /** Store locally, then push to Supabase (queued if offline). */
    save(rec) {
      cache[rec.id] = rec;
      persist();
      if (SB.enabled) {
        queue = queue.filter((r) => r.id !== rec.id).concat([rec]);
        persistQueue();
        SB.upsertVerification(rec)
          .then(() => { queue = queue.filter((r) => r.id !== rec.id); persistQueue(); synced = true; })
          .catch((e) => { lastError = e.message; synced = false; });
      }
      return rec;
    },

    confirm(id, opts) {
      const o = opts || {};
      const prev = cache[id] || {};
      return api.save({
        id,
        status: 'verified',
        verified_by: (o.by || '').trim() || 'Anonymous',
        verified_at: nowIso(),
        source_url: (o.source || '').trim() || null,
        jummah_times: (o.jummah || '').trim() || prev.jummah_times || null,
        note: (o.note || '').trim() || null,
        updated_at: nowIso(),
        history: (prev.history || []).concat([{
          action: 'verified',
          at: nowIso(),
          by: (o.by || 'Anonymous').trim(),
          source: (o.source || '').trim() || null,
        }]),
      });
    },

    report(id, opts) {
      const o = opts || {};
      const prev = cache[id] || {};
      return api.save(Object.assign({}, prev, {
        id,
        status: o.kind || 'needs_review',
        reported_by: (o.by || '').trim() || 'Anonymous',
        reported_at: nowIso(),
        report_note: (o.note || '').trim() || null,
        verified_by: null,
        verified_at: null,
        updated_at: nowIso(),
        history: (prev.history || []).concat([{
          action: 'reported:' + (o.kind || 'needs_review'),
          at: nowIso(),
          by: (o.by || 'Anonymous').trim(),
          note: (o.note || '').trim() || null,
        }]),
      }));
    },

    undo(id) {
      const prev = cache[id];
      if (!prev) return null;
      return api.save(Object.assign({}, prev, {
        status: 'unverified',
        verified_by: null,
        verified_at: null,
        updated_at: nowIso(),
      }));
    },

    clearAll() {
      cache = {};
      persist();
      try { localStorage.removeItem(SUB_KEY); } catch (e) { /* ignore */ }
    },

    /** Merge stored verification into a raw dataset record. */
    decorate(m) {
      const v = cache[m.id];
      if (!v) return m;
      const verified = v.status === 'verified';
      return Object.assign({}, m, {
        verified,
        status: v.status,
        verified_by: verified ? v.verified_by : null,
        verified_at: verified ? v.verified_at : null,
        jummah_times: v.jummah_times || m.jummah_times,
        verification: v,
      });
    },

    stats(ids) {
      let verified = 0, flagged = 0;
      ids.forEach((id) => {
        const v = cache[id];
        if (!v) return;
        if (v.status === 'verified') verified += 1;
        else if (v.status) flagged += 1;
      });
      return { verified, flagged };
    },

    exportJson(masjids) {
      return {
        exported_at: nowIso(),
        app: 'NZ Masjid Finder',
        backend: api.backend,
        records: Object.keys(cache).map((id) => {
          const v = cache[id];
          const m = masjids.find((x) => x.id === id);
          return Object.assign({}, v, {
            name: (m && m.name) || null,
            address: (m && m.address && m.address.formatted) || null,
            lat: m && m.lat,
            lon: m && m.lon,
          });
        }),
      };
    },

    // ---------------------------------------------------------- submissions
    /** Community-submitted masjids. Supabase when available, else local queue. */
    async submitMasjid(sub) {
      if (SB.enabled) {
        try {
          const row = await SB.createSubmission(sub);
          return { stored: 'supabase', record: row };
        } catch (e) {
          lastError = e.message;
        }
      }
      const local = readJson(SUB_KEY, []);
      const row = Object.assign({ id: 'local-' + Date.now(), status: 'pending', created_at: nowIso() }, sub);
      local.unshift(row);
      writeJson(SUB_KEY, local);
      return { stored: 'local', record: row };
    },

    localSubmissions: () => readJson(SUB_KEY, []),
  };

  window.NZVerification = api;
})();
