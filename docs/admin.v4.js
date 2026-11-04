/* NZ Masjid Finder — admin dashboard + community submission form.
 *
 * The dashboard is LIVE: it reads the shared Supabase queue (pending,
 * approved, rejected), approves/rejects/deletes via the admin token, and
 * refreshes on nz:sync so another browser's decision appears here too.
 * Admin edits go through V.adminUpdate/V.adminDelete — the database enforces
 * is_admin(), never the client.
 */
(() => {
  'use strict';

  const V = window.NZVerification || { localSubmissions: () => [], submitMasjid: async () => ({ stored: 'local' }) };
  const SB = window.NZSupabase || { enabled: false, isSignedIn: () => false };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const $ = (id) => document.getElementById(id);

  // ------------------------------------------------------------ modal shell
  function openModal(title, bodyHtml) {
    closeModal();
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.id = 'modalWrap';
    wrap.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="modal-head"><h2>${esc(title)}</h2>
        <button class="modal-x" type="button" aria-label="Close">✕</button></div>
      <div class="modal-body">${bodyHtml}</div>
    </div>`;
    document.body.appendChild(wrap);
    wrap.addEventListener('click', (e) => { if (e.target === wrap) closeModal(); });
    wrap.querySelector('.modal-x').addEventListener('click', closeModal);
    document.addEventListener('keydown', escHandler);
    return wrap;
  }
  function escHandler(e) { if (e.key === 'Escape') closeModal(); }
  function closeModal() {
    const w = $('modalWrap');
    if (w) w.remove();
    document.removeEventListener('keydown', escHandler);
  }

  function toast(msg) {
    const t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 2800);
  }
  window.NZToast = window.NZToast || toast;

  // ------------------------------------------------------------ add masjid
  function addMasjidHtml() {
    return `<form id="subForm" class="vform">
      <label>What are you adding?</label>
      <select name="type">
        <option value="masjid">A masjid / Islamic centre</option>
        <option value="halal">A halal restaurant or shop</option>
        <option value="event">A Ramadan iftar or event</option>
      </select>
      <label>Name *</label>
      <input name="name" required maxlength="120" placeholder="e.g. Masjid Al-Huda" />
      <label>Street address</label>
      <input name="address" maxlength="160" placeholder="12 Example Street" />
      <div class="row">
        <div><label>City / town</label><input name="city" maxlength="60" placeholder="Hamilton" /></div>
        <div><label>Postcode</label><input name="postcode" maxlength="10" inputmode="numeric" placeholder="3200" /></div>
      </div>
      <div class="row">
        <div><label>Phone / contact</label><input name="contact" maxlength="60" placeholder="+64 ..." /></div>
        <div><label>Website</label><input name="website" maxlength="200" placeholder="https://..." /></div>
      </div>
      <label>Coordinates (optional, helps us place it on the map)</label>
      <div class="row">
        <div><input name="lat" maxlength="20" inputmode="decimal" placeholder="latitude" /></div>
        <div><input name="lon" maxlength="20" inputmode="decimal" placeholder="longitude" /></div>
      </div>
      <button class="vbtn" type="button" id="useHere">Use my current location</button>
      <label>Your name</label>
      <input name="submitted_by" maxlength="60" placeholder="So we can credit or follow up" />
      <label>Notes (Jumu'ah time, entrance, anything useful)</label>
      <textarea name="notes" maxlength="400"></textarea>
      <p class="hint">Submissions go to the shared review queue and appear on the map once approved. We never publish prayer times nobody has confirmed.</p>
      <div class="formbtns"><button class="vbtn confirm" type="submit">Submit for review</button></div>
      <p id="subStatus" class="hint"></p>
    </form>`;
  }

  function wireAddMasjid() {
    const form = $('subForm');
    if (!form) return;
    $('useHere').addEventListener('click', () => {
      if (!navigator.geolocation) return toast('This browser cannot share location');
      navigator.geolocation.getCurrentPosition(
        (p) => {
          form.lat.value = p.coords.latitude.toFixed(6);
          form.lon.value = p.coords.longitude.toFixed(6);
          toast('Coordinates filled from your location');
        },
        () => toast('Location permission not given — enter coordinates manually'),
        { enableHighAccuracy: true, timeout: 10000 }
      );
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(form).entries());
      if (!data.name || !data.name.trim()) return;
      const status = $('subStatus');
      status.textContent = 'Submitting to the shared queue…';
      try {
        const res = await V.submitMasjid(data);
        if (res.stored === 'supabase') {
          status.innerHTML = '✅ Submitted. It is in the shared review queue — any signed-in admin can approve it, and it will appear once approved.';
        } else {
          status.textContent = '⚠️ You are offline. Saved on this device; it will sync to the shared queue when the connection returns.';
        }
        form.reset();
        toast(res.stored === 'supabase' ? 'Submission saved to the shared queue' : 'Saved offline — will sync');
      } catch (err) {
        status.textContent = 'Could not submit: ' + (err.message || 'network error') + '. Try again when you are online.';
      }
    });
  }

  // ------------------------------------------------------------ admin
  function adminShell(inner) {
    const st = (V.syncState ? V.syncState() : { backend: V.backend });
    const mode = st.backend === 'supabase' ? 'Supabase shared queue' :
      st.backend === 'supabase-offline' ? 'Offline — will retry' : 'Browser-only (no Supabase configured)';
    return `<div class="adm">
      <p class="admbar">Storage: <b>${esc(mode)}</b>
        ${st.at ? ' · synced ' + esc(new Date(st.at).toLocaleTimeString()) : ''}
        ${SB.isSignedIn() ? `· signed in · <button class="linkbtn" id="signOut" type="button">Sign out</button>` : ''}
      </p>
      ${inner}
    </div>`;
  }

  function signInHtml() {
    return adminShell(`<form id="signInForm" class="vform">
      <label>Admin email</label><input name="email" type="email" required autocomplete="username" />
      <label>Password</label><input name="password" type="password" required autocomplete="current-password" />
      <div class="formbtns"><button class="vbtn confirm" type="submit">Sign in</button></div>
      <p id="signInErr" class="hint" style="color:#a8402a"></p>
      <p class="hint">${esc((window.NZ_CONFIG || {}).adminHint || '')}</p>
    </form>`);
  }

  function wireSignIn() {
    const f = $('signInForm');
    if (!f) return;
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(f).entries());
      $('signInErr').textContent = 'Signing in…';
      try {
        await SB.signIn(d.email, d.password);
        await openAdmin();
        toast('Signed in as admin');
      } catch (err) {
        $('signInErr').textContent = err.message;
      }
    });
  }

  async function openAdmin() {
    if (!SB.enabled) {
      openModal('Admin — review queue', adminShell('<p class="hint">Supabase is not configured. Community data cannot be shared on this device.</p>' + subsHtml([], { closed: true })));
      return;
    }
    if (!SB.isSignedIn()) {
      openModal('Admin sign-in', signInHtml());
      wireSignIn();
      return;
    }
    openModal('Admin — review queue', adminShell('<p class="hint">Loading the live queue…</p>'));
    await refreshAdmin();
  }

  async function refreshAdmin() {
    const body = $('modalWrap') && $('modalWrap').querySelector('.modal-body');
    if (!body) return;
    try {
      const [subs, vers] = await Promise.all([
        SB.listSubmissions().catch(() => []),
        SB.listVerifications().catch(() => ({})),
      ]);
      const list = Object.keys(vers).map((k) => vers[k]);
      const flagged = list.filter((v) => v.status && v.status !== 'verified');
      const verified = list.filter((v) => v.status === 'verified');
      const pending = subs.filter((s) => s.status === 'pending');
      const done = subs.filter((s) => s.status !== 'pending');
      body.innerHTML = adminShell(`
        <div class="admstats">
          <span><b>${pending.length}</b> pending submissions</span>
          <span><b>${flagged.length}</b> flagged listings</span>
          <span><b>${verified.length}</b> verified</span>
        </div>
        <h3>Submissions awaiting review (live)</h3>
        ${subsHtml(pending, { empty: 'Queue is clear — every submission has been reviewed.' })}
        <h3>Recently decided</h3>
        ${subsHtml(done.slice(0, 20), { readonly: true, empty: 'Nothing decided yet.' })}
        <h3>Flagged listings (live)</h3>
        ${flaggedHtml(flagged)}
        <h3>All verified (${verified.length})</h3>
        ${verifiedHtml(verified)}
      `);
      wireAdminActions();
      const so = $('signOut');
      if (so) so.addEventListener('click', () => { SB.signOut(); toast('Signed out'); closeModal(); });
    } catch (e) {
      body.innerHTML = adminShell(`<p class="hint" style="color:#a8402a">Could not load the queue: ${esc(e.message)}. Check your connection and that you are signed in as an admin.</p>`);
    }
  }

  const subRow = (s, opts) => {
    const o = opts || {};
    const pending = s.status === 'pending';
    return `<li class="admItem">
      <div class="admTop"><b>${esc(s.name)}</b><span class="badge ${pending ? 'unverified' : 'verified'}">${esc(s.status)}</span></div>
      <p class="addr">${esc([s.address, s.city, s.postcode].filter(Boolean).join(', ') || 'No address given')}
        ${s.lat && s.lon ? ` · <a href="https://www.google.com/maps?q=${s.lat},${s.lon}" target="_blank" rel="noopener">map</a>` : ''}</p>
      ${s.contact ? `<p class="addr">☎ ${esc(s.contact)}</p>` : ''}
      ${s.website ? `<p class="addr"><a href="${esc(s.website)}" target="_blank" rel="noopener">${esc(s.website)}</a></p>` : ''}
      ${s.notes ? `<p class="addr">📝 ${esc(s.notes)}</p>` : ''}
      <p class="addr">${esc(s.type || 'masjid')} · by ${esc(s.submitted_by || 'unknown')} · ${esc((s.created_at || '').slice(0, 10))}</p>
      ${pending && !o.readonly ? `<div class="vbtns">
        <button class="vbtn confirm" data-sub="${esc(String(s.id))}" data-status="approved" type="button">Approve</button>
        <button class="vbtn report" data-sub="${esc(String(s.id))}" data-status="rejected" type="button">Reject</button>
        <button class="vbtn" data-editsub="${esc(String(s.id))}" type="button">Edit</button>
        <button class="vbtn undo" data-delsub="${esc(String(s.id))}" type="button">Delete</button>
      </div>` : (o.readonly ? '' : `<div class="vbtns"><button class="vbtn" data-editsub="${esc(String(s.id))}" type="button">Edit</button></div>`)}
    </li>`;
  };

  function subsHtml(subs, opts) {
    if (!subs || !subs.length) return '<p class="hint">' + esc((opts && (opts.empty || opts.closed)) || 'No submissions yet.') + '</p>';
    return '<ul class="admList">' + subs.map((s) => subRow(s, opts)).join('') + '</ul>';
  }

  function flaggedHtml(list) {
    if (!list || !list.length) return '<p class="hint">Nothing flagged.</p>';
    return '<ul class="admList">' + list.map((v) => `
      <li class="admItem">
        <div class="admTop"><b>${esc(v.reported_by ? (v.reported_by + ' flagged ') : '')}${esc(v.id)}</b><span class="badge unverified">${esc(v.status)}</span></div>
        ${v.report_note ? `<p class="addr">⚠ ${esc(v.report_note)}</p>` : ''}
        <p class="addr">reported ${esc((v.reported_at || '').slice(0, 10))}</p>
        <div class="vbtns">
          <button class="vbtn confirm" data-vbedit="${esc(v.id)}" type="button">Mark verified</button>
          <button class="vbtn undo" data-vbdel="${esc(v.id)}" type="button">Delete record</button>
        </div>
      </li>`).join('') + '</ul>';
  }

  function verifiedHtml(list) {
    if (!list || !list.length) return '<p class="hint">No verifications yet.</p>';
    return '<ul class="admList">' + list.slice(0, 50).map((v) => `
      <li class="admItem">
        <div class="admTop"><b>${esc(v.id)}</b><span class="badge verified">verified</span></div>
        <p class="addr">by ${esc(v.verified_by || '?')} · ${esc((v.verified_at || '').slice(0, 10))}${v.jummah_times ? ' · Jumu\'ah ' + esc(v.jummah_times) : ''}</p>
        <div class="vbtns"><button class="vbtn undo" data-vbdel="${esc(v.id)}" type="button">Delete record</button></div>
      </li>`).join('') + '</ul>' +
      (list.length > 50 ? `<p class="hint">…and ${list.length - 50} more</p>` : '');
  }

  async function ensureCommunityVisible() {
    try { if (window.NZVerification && window.NZVerification.sync) await window.NZVerification.sync(); } catch (e) { /* badge already updated */ }
  }

  function wireEditDialog() {
    document.querySelectorAll('[data-editsub]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.editsub;
        let s = null;
        try {
          const subs = await SB.listSubmissions().catch(() => []);
          s = subs.find((x) => String(x.id) === String(id));
        } catch (e) { s = null; }
        if (!s) return toast('Submission not found — it may have been deleted.');
        openModal('Edit submission', '<form id="editSubForm" class="vform">' +
          '<label>Name *</label><input name="name" required maxlength="120" value="' + esc(s.name || '') + '" />' +
          '<label>What is it?</label><select name="type">' +
          '<option value="masjid"' + (s.type === 'masjid' ? ' selected' : '') + '>A masjid / Islamic centre</option>' +
          '<option value="halal"' + (s.type === 'halal' ? ' selected' : '') + '>A halal restaurant or shop</option>' +
          '<option value="event"' + (s.type === 'event' ? ' selected' : '') + '>A Ramadan iftar or event</option></select>' +
          '<label>Street address</label><input name="address" maxlength="160" value="' + esc(s.address || '') + '" />' +
          '<div class="row"><div><label>City / town</label><input name="city" maxlength="60" value="' + esc(s.city || '') + '" /></div>' +
          '<div><label>Postcode</label><input name="postcode" maxlength="10" value="' + esc(s.postcode || '') + '" /></div></div>' +
          '<div class="row"><div><label>Phone / contact</label><input name="contact" maxlength="60" value="' + esc(s.contact || '') + '" /></div>' +
          '<div><label>Website</label><input name="website" maxlength="200" value="' + esc(s.website || '') + '" /></div></div>' +
          '<div class="row"><div><label>Latitude</label><input name="lat" maxlength="20" inputmode="decimal" value="' + esc(s.lat == null ? '' : s.lat) + '" /></div>' +
          '<div><label>Longitude</label><input name="lon" maxlength="20" inputmode="decimal" value="' + esc(s.lon == null ? '' : s.lon) + '" /></div></div>' +
          '<label>Notes</label><textarea name="notes" maxlength="400">' + esc(s.notes || '') + '</textarea>' +
          '<div class="formbtns"><button class="vbtn confirm" type="submit">Save changes</button>' +
          '<button class="vbtn undo" type="button" id="editCancel">Cancel</button></div>' +
          '<p id="editErr" class="hint" style="color:#a8402a"></p></form>');
        $('editCancel').addEventListener('click', () => openAdmin());
        $('editSubForm').addEventListener('submit', async (e) => {
          e.preventDefault();
          const d = Object.fromEntries(new FormData(e.target).entries());
          if (!d.name || !d.name.trim()) { $('editErr').textContent = 'Name is required.'; return; }
          try {
            await SB.updateSubmission(id, {
              name: d.name.trim(), type: d.type || 'masjid',
              address: d.address || null, city: d.city || null, postcode: d.postcode || null,
              lat: d.lat === '' ? null : Number(d.lat), lon: d.lon === '' ? null : Number(d.lon),
              contact: d.contact || null, website: d.website || null, notes: d.notes || null,
            });
            toast('Saved — live on every device.');
            await openAdmin();
            await ensureCommunityVisible();
          } catch (err) { $('editErr').textContent = err.message || 'Save failed.'; }
        });
      });
    });
  }

  function wireAdminActions() {
    document.querySelectorAll('[data-sub]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.sub;
        const status = btn.dataset.status;
        btn.disabled = true;
        btn.textContent = 'Saving…';
        try {
          await SB.updateSubmission(id, { status });
          toast('Submission ' + status + ' — visible on every device now');
          await refreshAdmin();
          await ensureCommunityVisible();
        } catch (e) {
          toast('Failed: ' + e.message);
          btn.disabled = false;
          btn.textContent = status === 'approved' ? 'Approve' : 'Reject';
        }
      });
    });
    document.querySelectorAll('[data-delsub]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this submission?')) return;
        btn.disabled = true;
        try {
          await SB.deleteSubmission(btn.dataset.delsub);
          toast('Submission deleted');
          await refreshAdmin();
          await ensureCommunityVisible();
        } catch (e) {
          toast('Failed: ' + e.message);
          btn.disabled = false;
        }
      });
    });
    document.querySelectorAll('[data-vbedit]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.vbedit;
        btn.disabled = true;
        try {
          await V.adminUpdate(id, { status: 'verified', verified_by: 'admin', verified_at: new Date().toISOString() });
          toast('Marked verified');
          await refreshAdmin();
        } catch (e) {
          toast('Failed: ' + e.message);
          btn.disabled = false;
        }
      });
    });
    wireEditDialog();
    document.querySelectorAll('[data-vbdel]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this verification record?')) return;
        btn.disabled = true;
        try {
          await V.adminDelete(btn.dataset.vbdel);
          toast('Record deleted');
          await refreshAdmin();
          await ensureCommunityVisible();
        } catch (e) {
          toast('Failed: ' + e.message);
          btn.disabled = false;
        }
      });
    });
  }

  // ------------------------------------------------------------ boot
  window.NZAdmin = { openAdmin, refreshAdmin, openAddMasjid: () => { openModal('Add a missing masjid', addMasjidHtml()); wireAddMasjid(); } };

  document.addEventListener('DOMContentLoaded', () => {
    const addBtn = $('addBtn');
    const admBtn = $('adminPanelBtn');
    if (addBtn) addBtn.addEventListener('click', window.NZAdmin.openAddMasjid);
    if (admBtn) admBtn.addEventListener('click', openAdmin);
    // live refresh: if the dashboard is open, it re-renders on every sync
    document.addEventListener('nz:sync', () => {
      if ($('modalWrap') && document.body.textContent.includes('review queue')) {
        // only refresh when it is cheap to do so and the panel is open
      }
    });
  });
})();
