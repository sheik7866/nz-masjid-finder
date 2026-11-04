/* NZ Masjid Finder — shared-data store.
 *
 * ONE source of truth: the Supabase tables `verifications` and `submissions`
 * (see supabase/schema.sql). localStorage is ONLY an offline cache:
 * every shared write goes to Supabase first, and Supabase wins every merge.
 *
 * Rules:
 *   1. Community writes (verify/report + submissions) use the community INSERT
 *      path. They FAIL against the database when offline — they are queued and
 *      retried on the next successful sync, never silently kept local.
 *   2. Admin writes (update/delete/approve) REQUIRE a signed-in admin; the
 *      database enforces is_admin(). No admin action can happen offline.
 *   3. Loads always come from Supabase when reachable (sync on boot, auto
 *      refresh every 60 s, Realtime subscription, and refresh on tab focus).
 *   4. The cache only saves a successful server response. Stale local data can
 *      never overwrite newer server data: last-write-wins on updated_at.
 */
(() => {
  'use strict';

  const KEY = 'nzmasjidfinder.verifications.v1';      // offline cache (server wins)
  const QUEUE_KEY = 'nzmasjidfinder.verifyQueue.v2';
  const SUBQ_KEY = 'nzmasjidfinder.submitQueue.v2';
  const MODE_KEY = 'nzmasjidfinder.verifyMode';
  const LAST_SYNC_KEY = 'nzmasjidfinder.lastSync.v1';
  const APPROVED_KEY = 'nzmasjidfinder.approved.v1';     // last good approved list

  const SB = window.NZSupabase || { enabled: false };

  const readJson = (k, fallback) => {
    try {
      const raw = localStorage.getItem(k);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  };
  const writeJson = (k, v) => {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn('storage full', e); }
  };

  let cache = readJson(KEY, {});          // id -> server row (last good sync)
  let queue = readJson(QUEUE_KEY, []);    // verification writes not yet accepted
  let subQueue = readJson(SUBQ_KEY, []);  // submissions not yet accepted
  let approved = readJson(APPROVED_KEY, []); // last good APPROVED submissions list
  let synced = false;
  let lastSync = readJson(LAST_SYNC_KEY, null);
  let lastError = null;
  let realtimeOn = false;

  const nowIso = () => new Date().toISOString();
  const persist = () => writeJson(KEY, cache);
  const persistQueue = () => { writeJson(QUEUE_KEY, queue); writeJson(SUBQ_KEY, subQueue); };

  // ---------------------------------------------------------- merge
  /** Supabase always wins. Local rows that share an id are dropped in favour of
   *  the server row; queued writes keep only fields the server has not changed. */
  function mergeRemote(remoteMap) {
    const merged = {};
    Object.keys(remoteMap || {}).forEach((id) => { merged[id] = remoteMap[id]; });
    cache = merged;
    persist();
    // drop queue entries whose id+content the server already holds
    queue = queue.filter((rec) => {
      const s = cache[rec.id];
      return !s || String(s.updated_at || '') < String(rec.updated_at || '');
    });
    persistQueue();
  }

  // ---------------------------------------------------------- write paths
  async function pushVerification(rec) {
    if (!SB.enabled) throw new Error('Supabase is not configured');
    try {
      // Community INSERT first...
      await SB.createVerification(rec);
      return { stored: 'supabase', via: 'insert' };
    } catch (e) {
      if (e.status === 409 || (e.body && (e.body.code === '23505' || /duplicate/i.test(e.message || '')))) {
        // ...row exists, so this is an admin UPDATE — the database decides.
        await SB.updateVerification(rec.id, rec);
        return { stored: 'supabase', via: 'update' };
      }
      throw e;   // genuine failure (offline, 401, constraint) -> queue
    }
  }

  async function flushQueues() {
    if (!SB.enabled) return { flushed: 0, left: queue.length + subQueue.length };
    let flushed = 0;
    const remainingV = [];
    for (const rec of queue) {
      try { await pushVerification(rec); flushed += 1; }
      catch (e) { remainingV.push(rec); lastError = e.message; }
    }
    queue = remainingV;
    const remainingS = [];
    for (const sub of subQueue) {
      try { await SB.createSubmission(sub); flushed += 1; }
      catch (e) { remainingS.push(sub); lastError = e.message; }
    }
    subQueue = remainingS;
    persistQueue();
    return { flushed, left: queue.length + subQueue.length };
  }

  const api = {
    get backend() {
      if (!SB.enabled) return 'local';
      return synced ? 'supabase' : 'supabase-offline';
    },
    get lastError() { return lastError; },
    get lastSyncAt() { return lastSync; },
    get realtime() { return realtimeOn; },
    queues() { return { verifications: queue.length, submissions: subQueue.length }; },

    /** APPROVED community submissions — the shared, public list. */
    approvedSubmissions: () => approved.slice(),
    approvedCountHint: () => approved.length,

    /** Load shared records. Flush pending writes FIRST (they become server
     *  rows), then re-read so the cache reflects what the server accepted. */
    async sync() {
      if (!SB.enabled) return { mode: 'local' };
      try {
        await flushQueues();
        const [remote, approvedList] = await Promise.all([
          SB.listVerifications(),
          SB.listApprovedSubmissions ? SB.listApprovedSubmissions().catch(() => approved) : Promise.resolve(approved),
        ]);
        mergeRemote(remote);
        approved = Array.isArray(approvedList) ? approvedList : approved;
        writeJson(APPROVED_KEY, approved);
        // re-read queued rows the server has not yet acknowledged: after a
        // flush that failed its follow-up read, a blind merge would drop rows
        // the server actually holds. Instead, re-apply queued rows that are
        // newer than what the server returned (last-write-wins both ways).
        queue.forEach((rec) => {
          const s = cache[rec.id];
          if (!s || String(rec.updated_at || '') >= String(s.updated_at || '')) {
            cache[rec.id] = Object.assign({}, rec);
          }
        });
        persist();
        synced = true;
        lastSync = nowIso();
        writeJson(LAST_SYNC_KEY, lastSync);
        lastError = null;
        document.dispatchEvent(new CustomEvent('nz:sync', { detail: api.syncState() }));
        return { mode: 'supabase', count: Object.keys(remote).length, queued: queue.length + subQueue.length };
      } catch (e) {
        synced = false;
        lastError = e.message;
        return { mode: 'local', error: e.message, queued: queue.length + subQueue.length };
      }
    },

    syncState() {
      return {
        backend: api.backend,
        at: lastSync,
        shared: Object.keys(cache).length,
        approved: approved.length,
        queued: queue.length + subQueue.length,
        error: lastError,
        realtime: realtimeOn,
      };
    },

    /** Subscribe to live changes (Realtime); falls back to polling. */
    async subscribe(tables) {
      if (!SB.enabled || !SB.realtime || realtimeOn) return false;
      try {
        const list = Array.isArray(tables) && tables.length ? tables : ['verifications', 'submissions'];
        await Promise.all(list.map((t) => SB.realtime.subscribe(t, () => api.sync())));
        realtimeOn = true;
        document.dispatchEvent(new CustomEvent('nz:sync', { detail: api.syncState() }));
        return true;
      } catch (e) {
        realtimeOn = false;
        return false;
      }
    },

    getAll: () => cache,
    get: (id) => cache[id] || null,

    isVerifying: () => localStorage.getItem(MODE_KEY) === '1',
    setVerifying(on) { localStorage.setItem(MODE_KEY, on ? '1' : '0'); },

    /** Shared write. Sends to Supabase; queues ONLY while offline/unreachable. */
    async write(rec) {
      const stamped = Object.assign({}, rec, { updated_at: nowIso() });
      if (!SB.enabled || (typeof navigator !== 'undefined' && !navigator.onLine)) {
        queue = queue.filter((r) => r.id !== stamped.id).concat([stamped]);
        persistQueue();
        return { stored: 'queued', reason: SB.enabled ? 'offline' : 'no-supabase' };
      }
      try {
        const res = await pushVerification(stamped);
        cache[stamped.id] = Object.assign({}, stamped);
        persist();
        document.dispatchEvent(new CustomEvent('nz:sync', { detail: api.syncState() }));
        return res;
      } catch (e) {
        lastError = e.message;
        throw e;
      }
    },

    /** Backward-compatible local save (queued, then flushed by sync()). */
    save(rec) {
      const stamped = Object.assign({}, rec, { updated_at: nowIso() });
      queue = queue.filter((r) => r.id !== stamped.id).concat([stamped]);
      persistQueue();
      // opportunistically push; failures stay queued
      api.write(stamped).catch(() => {});
      return stamped;
    },

    async confirm(id, opts) {
      const o = opts || {};
      const prev = cache[id] || {};
      return api.write({
        id,
        status: 'verified',
        verified_by: (o.by || '').trim() || 'Anonymous',
        verified_at: nowIso(),
        source_url: (o.source || '').trim() || null,
        jummah_times: (o.jummah || '').trim() || prev.jummah_times || null,
        note: (o.note || '').trim() || null,
        history: (prev.history || []).concat([{
          action: 'verified',
          at: nowIso(),
          by: (o.by || 'Anonymous').trim(),
          source: (o.source || '').trim() || null,
        }]),
      });
    },

    async report(id, opts) {
      const o = opts || {};
      const prev = cache[id] || {};
      return api.write(Object.assign({}, prev, {
        id,
        status: o.kind || 'needs_review',
        reported_by: (o.by || '').trim() || 'Anonymous',
        reported_at: nowIso(),
        report_note: (o.note || '').trim() || null,
        verified_by: null,
        verified_at: null,
        history: (prev.history || []).concat([{
          action: 'reported:' + (o.kind || 'needs_review'),
          at: nowIso(),
          by: (o.by || 'Anonymous').trim(),
          note: (o.note || '').trim() || null,
        }]),
      }));
    },

    /** Admin only (needs signed-in admin); never queued. */
    async adminUpdate(id, patch) {
      if (!SB.enabled) throw new Error('Supabase is not configured');
      const row = Object.assign({}, patch, { updated_at: nowIso() });
      const res = await SB.updateVerification(id, row);
      cache[id] = Object.assign({}, cache[id] || { id }, row);
      persist();
      document.dispatchEvent(new CustomEvent('nz:sync', { detail: api.syncState() }));
      return res;
    },

    /** Admin only (needs signed-in admin); never queued. */
    async adminDelete(id) {
      if (!SB.enabled) throw new Error('Supabase is not configured');
      await SB.deleteVerification(id);
      delete cache[id];
      persist();
      document.dispatchEvent(new CustomEvent('nz:sync', { detail: api.syncState() }));
      return true;
    },

    clearAll() {
      // Only clears local offline artefacts — shared rows are never deleted here.
      queue = [];
      subQueue = [];
      persistQueue();
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
    /** Community submissions go to Supabase. No silent local queue of approved-looking rows. */
    async submitMasjid(sub) {
      if (!SB.enabled || (typeof navigator !== 'undefined' && !navigator.onLine)) {
        subQueue.unshift(Object.assign({ created_at: nowIso() }, sub));
        persistQueue();
        return { stored: 'queued', reason: SB.enabled ? 'offline' : 'no-supabase' };
      }
      try {
        const row = await SB.createSubmission(sub);
        document.dispatchEvent(new CustomEvent('nz:sync', { detail: api.syncState() }));
        return { stored: 'supabase', record: row };
      } catch (e) {
        lastError = e.message;
        throw e;
      }
    },

    /** Local submissions are ONLY failed offline writes. Empty when synced. */
    localSubmissions: () => subQueue.slice(),
  };

  // ------------------------------------------------------------ live refresh
  // Guarded: verification.js must also load under plain Node (tests) and in
  // workers, where document/window do not exist.
  function liveRefresh() {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;
    if (!document.addEventListener) return;
    // Realtime subscription as soon as the module is up
    setTimeout(() => api.subscribe().catch(() => {}), 1500);
    // auto refresh (covers Realtime gaps + suspended tabs)
    setInterval(() => {
      if (document.visibilityState === 'visible') api.sync().then(renderHook).catch(() => {});
    }, 60000);
    // refresh when the user comes back to the app
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') api.sync().then(renderHook).catch(() => {});
    });
    if (window.addEventListener) window.addEventListener('online', () => api.sync().then(renderHook).catch(() => {}));
    // realtime pushes land here too
    document.addEventListener('nz:data', () => api.sync().then(renderHook).catch(() => {}));
  }
  if (typeof document !== 'undefined' && document.readyState === 'loading' && document.addEventListener) {
    document.addEventListener('DOMContentLoaded', liveRefresh);
  } else {
    liveRefresh();
  }

  function renderHook() {
    document.dispatchEvent(new CustomEvent('nz:masjids-changed'));
  }

  window.NZVerification = api;
})();
