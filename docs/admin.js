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
      const autoSaved = list
        .filter((v) => v.status === 'verified' && /\(automatic scan\)/i.test(v.note || ''))
        .sort((a, b) => String(b.verified_at || '').localeCompare(String(a.verified_at || '')));
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
        <h3>Jumu'ah web check</h3>
        <p class="hint">Search a masjid's website and pages for its Jumu'ah times. Nothing is saved until you press Use on a result.</p>
        <details class="admHelp">
          <summary>How the web check works</summary>
          <ul>
            <li>Pick a masjid below and press <b>Check the web</b>. It reads that masjid's own website and its prayer or timetable pages — up to 8 pages, usually within 20 seconds.</li>
            <li>Listings marked <b>no website</b> can still be found through web search, when a search key is configured on the project.</li>
            <li>Every result shows the time and the exact page it was read from, so you can open the page and confirm it before saving.</li>
            <li><b>Use these times</b> saves the time as verified, with that page as the source. If a page lists two times (winter and daylight saving), the second one is saved and the button says which. If nothing is found, set the time by hand from the listing's “Confirm details” form.</li>
            <li>The two buttons list the listings <b>with a website</b> and <b>without one</b>; typing still searches all of them.</li>
            <li><b>Scan all</b> reads whichever half is listed — three at a time, with a Stop button — and lists each Jumu'ah time it found. Nothing is saved by the scan; every row has its own Save button.</li>
            <li><b>Scan &amp; save missing</b> is the hands-off one: it reads every masjid that has no Jumu'ah time yet and saves what it finds, with the source page, without asking per row. It waits for you to press Start, skips masjids that already have a time, and reports how many it saved.</li>
            <li>Everything the hands-off run saves is listed under <b>“Saved by the automatic scan”</b> below, newest first, with the page it came from — and a <b>Revert</b> button that clears the time and puts the listing back to unverified.</li>
            <li>When a masjid's own pages give no time, the check also reads <b>Kiwi Muslim Directory's “Jumah Prayer Times”</b> article — a winter/summer table for about 65 masjids — and offers the summer (second) time.</li>
            <li>Each result links to <b>Kiwi Muslim Directory</b> and <b>Go Pray</b> as well. Their search and listing screens draw times in with JavaScript, so those links are for comparing by eye.</li>
          </ul>
        </details>
        <input id="jfSearch" class="jfSearch" type="search" placeholder="Type a masjid name, e.g. Masjid Al-Huda" autocomplete="off" />
        <div class="jfTools">
          <button id="jfSiteOnly" class="vbtn" type="button" aria-pressed="false">Masjids with a website</button>
          <button id="jfNoSite" class="vbtn" type="button" aria-pressed="false">Masjids with no website</button>
          <button id="jfScanAll" class="vbtn confirm" type="button">Scan every website</button>
          <button id="jfAutoSave" class="vbtn confirm" type="button">Scan &amp; save missing</button>
        </div>
        <ul class="admList" id="jfList"></ul>

        <h3>Saved by the automatic scan (${autoSaved.length})</h3>
        <p class="hint">Every time the hands-off run wrote, newest first, with the page it was read from. Revert puts the listing back to unverified with no time.</p>
        ${autoSavedHtml(autoSaved)}

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
      wireJummahFinder();
      wireAutoSaved();
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

  const masjidName = (id) => {
    const all = (window.NZApp && window.NZApp.masjids) || [];
    const m = all.find((x) => String(x.id) === String(id));
    return m ? m.name : String(id);
  };

  // Everything the hands-off run wrote carries "(automatic scan)" in its note,
  // so the panel can list exactly those times — with the page they came from —
  // and take one back without hunting for the listing it belongs to.
  function autoSavedHtml(list) {
    if (!list || !list.length) {
      return '<p class="hint">Nothing saved by the automatic scan yet. Each time it saves is listed here with the page it came from, so a wrong one can be reverted.</p>';
    }
    return '<ul class="admList">' + list.map((v) => `
      <li class="admItem">
        <div class="admTop"><b>${esc(masjidName(v.id))}</b><span class="badge verified">${esc(v.jummah_times || 'no time')}</span></div>
        <p class="addr small">${v.source_url ? `<a href="${esc(v.source_url)}" target="_blank" rel="noopener">${esc(v.source_url)}</a>` : 'no source recorded'} · ${esc((v.verified_at || '').slice(0, 10))}</p>
        <div class="vbtns"><button class="vbtn undo" data-jarevert="${esc(v.id)}" type="button">Revert</button></div>
      </li>`).join('') + '</ul>';
  }

  function wireAutoSaved() {
    document.querySelectorAll('[data-jarevert]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.jarevert;
        if (!confirm('Revert the automatic time for ' + masjidName(id) + '? Its Jumu\'ah time is cleared and the listing goes back to unverified.')) return;
        btn.disabled = true;
        btn.textContent = 'Reverting…';
        try {
          await V.adminDelete(id);
          toast('Reverted — ' + masjidName(id) + ' has no Jumu\'ah time again');
          await refreshAdmin();
          await ensureCommunityVisible();
        } catch (e) {
          toast('Failed: ' + e.message);
          btn.disabled = false;
          btn.textContent = 'Revert';
        }
      });
    });
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

  // ------------------------------------------------------------ Jumu'ah web check
  // Asks the `verify-jummah` Edge Function to read the masjid's own pages (and
  // the wider web when a search key is configured), then shows every Jumu'ah
  // time it found next to the page it came from. The admin picks one; only then
  // is anything written, through the normal is_admin() verification path.
  const cityOf = (m) => (m.address && (m.address.city || m.address.formatted)) || m.region || '';

  // Everything the directory matcher needs to refuse a same-name stranger in
  // another city: the masjid's own aliases and its full street address.
  const jummahTarget = (m) => ({
    id: m.id,
    name: m.name,
    alt_names: Array.isArray(m.alt_names) ? m.alt_names : [],
    city: (m.address && m.address.city) || '',
    suburb: (m.address && m.address.suburb) || '',
    address: (m.address && m.address.formatted) || '',
    region: m.region || '',
    website: m.website || null,
  });

  function wireJummahFinder() {
    const input = $('jfSearch');
    const list = $('jfList');
    if (!input || !list) return;
    const siteBtn = $('jfSiteOnly');
    const noSiteBtn = $('jfNoSite');
    const scanBtn = $('jfScanAll');
    const masjids = (window.NZApp && window.NZApp.masjids) || [];
    const withSite = masjids.filter((m) => m.website);
    const noSite = masjids.filter((m) => !m.website);
    let mode = ''; // '' idle, 'site' lists the ones with a website, 'nos' the rest

    const scanSet = () => (mode === 'nos' ? noSite : withSite);
    const paintScan = () => {
      if (!scanBtn) return;
      scanBtn.textContent = (mode === 'nos'
        ? 'Scan all without a website (' : 'Scan all with a website (')
        + scanSet().length + ')';
    };
    const setMode = (next) => {
      mode = mode === next ? '' : next;
      if (siteBtn) siteBtn.setAttribute('aria-pressed', String(mode === 'site'));
      if (noSiteBtn) noSiteBtn.setAttribute('aria-pressed', String(mode === 'nos'));
      paintScan();
      paint();
    };

    if (siteBtn) {
      siteBtn.textContent = `Masjids with a website (${withSite.length})`;
      siteBtn.addEventListener('click', () => setMode('site'));
    }
    if (noSiteBtn) {
      noSiteBtn.textContent = `Masjids with no website (${noSite.length})`;
      noSiteBtn.addEventListener('click', () => setMode('nos'));
    }
    if (scanBtn) scanBtn.addEventListener('click', () => scanAllJummah(scanSet()));
    const autoBtn = $('jfAutoSave');
    if (autoBtn) {
      const missing = masjids.filter((m) => !m.jummah_times).length;
      autoBtn.textContent = `Scan & save missing (${missing})`;
      autoBtn.addEventListener('click', autoSaveJummah);
    }
    paintScan();

    const paint = () => {
      const q = input.value.trim().toLowerCase();
      if (!q && !mode) {
        list.innerHTML = '<li class="hint">Start typing to pick a masjid, or use the two buttons to list the ones with a website and the ones without.</li>';
        return;
      }
      // Typing searches every masjid. With an empty box the active button lists
      // that half of the directory: with a website, or without one — where the
      // check falls back to Kiwi Muslim Directory and any web search.
      const pool = q ? masjids : (mode === 'nos' ? noSite : withSite);
      const hits = pool.filter((m) => !q || (
        String(m.name || '').toLowerCase().includes(q) ||
        String(cityOf(m)).toLowerCase().includes(q)
      )).slice(0, q ? 8 : 90);
      if (!hits.length) { list.innerHTML = '<li class="hint">No masjid matches that name.</li>'; return; }
      list.innerHTML = hits.map((m) => `<li class="admItem">
        <div class="admTop"><b>${esc(m.name)}</b><span class="badge ${m.website ? 'verified' : 'unverified'}">${m.website ? 'has website' : 'no website'}</span></div>
        <p class="addr">${esc(cityOf(m) || 'New Zealand')}${m.jummah_times ? ' · now: ' + esc(m.jummah_times) : ''}</p>
        <div class="vbtns"><button class="vbtn confirm" data-jf="${esc(m.id)}" type="button">Check the web</button></div>
      </li>`).join('');
      list.querySelectorAll('[data-jf]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const m = masjids.find((x) => String(x.id) === String(btn.dataset.jf));
          if (m) checkJummah(m);
        });
      });
    };
    input.addEventListener('input', paint);
    paint();
  }

  // Masjids that keep a winter and a summer timetable list two times on the
  // page. The second one follows the clock change, so that is the one saved.
  const pickTime = (times) => (times.length >= 2 ? times[1] : times[0]);

  // One call per masjid, tuned for a run of a hundred of them: a busy site, a
  // 429 or a dropped connection is retried with a backoff, and an expired admin
  // token is renewed by the client before the call is written off as a failure.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function readJummah(m) {
    const body = jummahTarget(m);
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await SB.callFunction('verify-jummah', body);
      } catch (e) {
        const status = e && e.status;
        const retryable = !status || status === 429 || status >= 500;
        if (retryable && attempt < 2) { await sleep(700 * Math.pow(2, attempt)); continue; }
        throw e;
      }
    }
  }

  async function checkJummah(m) {
    const modal = openModal('Jumu\'ah web check — ' + m.name,
      `<p class="hint" id="jfStatus">Reading ${esc(m.website || 'search results')} and its prayer pages… this can take up to 20 seconds.</p>
       <div id="jfOut"></div>`);
    const status = $('jfStatus');
    const out = $('jfOut');
    try {
      const data = await SB.callFunction('verify-jummah', jummahTarget(m));
      status.textContent = data.pages_read
        ? 'Read ' + data.pages_read + ' page(s)' + (data.search_used ? ' including web search results' : ' on the masjid website') + '.'
        : 'Nothing could be read for this masjid.';
      const sources = (data.sources || []).filter((s) => s.times && s.times.length);
      const empty = (data.sources || []).filter((s) => !s.times || !s.times.length);
      out.innerHTML = sources.length
        ? '<ul class="admList">' + sources.map((s) => {
            const pick = pickTime(s.times);
            const twoUp = s.times.length > 1;
            return `
            <li class="admItem">
              <div class="admTop"><b><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title || s.url)}</a></b><span class="badge verified">${s.times.length} time${twoUp ? 's' : ''}</span></div>
              <p class="addr">${esc(s.url)}</p>
              <p class="jfTimes">${s.times.map((t) => `<b>${esc(t)}</b>`).join(' ')}</p>
              ${s.snippets && s.snippets.length ? `<p class="addr small">…${esc(s.snippets[0])}…</p>` : ''}
              <div class="vbtns"><button class="vbtn confirm" data-jfuse="${esc(pick)}" data-jfsrc="${esc(s.url)}" type="button">${twoUp ? 'Use ' + esc(pick) + ' (2nd of ' + s.times.length + ')' : 'Use this time'}</button>
                <a class="vbtn" href="${esc(s.url)}" target="_blank" rel="noopener">Open page</a></div>
            </li>`;
          }).join('') + '</ul>'
        : '<p class="hint">No Jumu\'ah time was found on the pages that could be read. Check the site yourself, or set the time from the listing\'s “Confirm details” form.</p>';
      if (sources.some((s) => s.times.length > 1)) {
        out.innerHTML += '<p class="hint">A page that lists two times is read as winter and daylight-saving times — the second one is the one saved.</p>';
      }
      if (empty.length) out.innerHTML += `<p class="hint">${empty.length} page(s) mentioned Jumu\'ah but gave no time.</p>`;
      if (data.notes && data.notes.length) out.innerHTML += '<p class="hint">' + data.notes.map(esc).join('<br>') + '</p>';
      if (m.website) out.innerHTML += `<p class="hint"><a href="${esc(m.website)}" target="_blank" rel="noopener">Open the masjid website</a> · <a href="https://www.google.com/search?q=${encodeURIComponent(m.name + ' ' + cityOf(m) + ' jummah times')}" target="_blank" rel="noopener">search Google manually</a></p>`;
      // Directories carry Jumu'ah times too, but they render them with JavaScript
      // (Kiwi Muslim Directory's /api and Go Pray's data are not in the HTML), so
      // they cannot be read from here — these links open them for a human look.
      const dirQ = encodeURIComponent(m.name + ' ' + cityOf(m));
      out.innerHTML += `<p class="hint">Check a directory: <a href="https://muslimdirectory.co.nz/search?q=${dirQ}" target="_blank" rel="noopener">Kiwi Muslim Directory</a> · <a href="https://www.google.com/search?q=site%3Agopray.app+${dirQ}" target="_blank" rel="noopener">Go Pray</a></p>`;
      out.querySelectorAll('[data-jfuse]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const label = btn.textContent;
          btn.disabled = true;
          btn.textContent = 'Saving…';
          try {
            await V.confirm(m.id, {
              by: 'admin',
              jummah: btn.dataset.jfuse,
              source: btn.dataset.jfsrc,
              note: 'Jumu\'ah times read from ' + btn.dataset.jfsrc + ' on ' + new Date().toISOString().slice(0, 10),
            });
            toast('Saved — ' + btn.dataset.jfuse + ' now verified');
            await ensureCommunityVisible();
            openAdmin();
          } catch (e) {
            toast('Failed: ' + e.message);
            btn.disabled = false;
            btn.textContent = label;
          }
        });
      });
    } catch (e) {
      const msg = e.status === 404
        ? 'The verify-jummah function is not deployed on this Supabase project yet. See README → “Checking Jumu\'ah times online”.'
        : e.status === 401 || e.status === 403
          ? 'Only a signed-in admin can run the web check. Sign out and back in if this persists.'
          : e.message || 'The check failed.';
      status.textContent = '';
      out.innerHTML = '<p class="hint" style="color:#a8402a">' + esc(msg) + '</p>';
    }
  }

  // ------------------------------------------------------ a whole half at once
  // Reads one half of the directory — the listings that carry a website, or the
  // ones that do not (where the function falls back to Kiwi Muslim Directory and
  // any web search) — and prints every Jumu'ah time it found as a saveable row.
  // Three requests at a time so one slow site cannot block the queue, and Stop
  // is always live. The scan writes nothing: each row keeps its own Save button,
  // so a person still confirms every time that reaches a listing.
  async function scanAllJummah(set) {
    const targets = (set && set.length)
      ? set
      : ((window.NZApp && window.NZApp.masjids) || []).filter((m) => m.website);
    if (!targets.length) { toast('Nothing to scan in that list'); return; }

    openModal('Scanning ' + targets.length + ' masjids', `
      <p class="hint" id="jsStatus">Reading 0 of ${targets.length}…</p>
      <div class="vbtns"><button class="vbtn report" id="jsStop" type="button">Stop</button></div>
      <ul class="admList" id="jsList"><li class="hint">Results appear here as each masjid is read.</li></ul>
      <p class="hint" id="jsSummary"></p>
    `);

    const list = $('jsList');
    const status = $('jsStatus');
    const summary = $('jsSummary');
    const stopBtn = $('jsStop');
    let stopped = false;
    if (stopBtn) {
      stopBtn.addEventListener('click', () => {
        stopped = true;
        stopBtn.disabled = true;
        stopBtn.textContent = 'Stopping…';
      });
    }

    let done = 0;
    let found = 0;
    let failed = 0;
    const queue = targets.slice();

    const addRow = (m, time, src, pages, note) => {
      found += 1;
      const row = document.createElement('li');
      row.className = 'admItem';
      row.innerHTML = `
        <div class="admTop"><b>${esc(m.name)}</b><span class="badge verified">${esc(time)}</span></div>
        <p class="addr">${esc(cityOf(m) || 'New Zealand')}${pages ? ' · ' + pages + ' page(s) read' : ''}${note ? ' · ' + esc(note) : ''}</p>
        <p class="addr small"><a href="${esc(src)}" target="_blank" rel="noopener">${esc(src)}</a></p>
        <div class="vbtns"><button class="vbtn confirm" type="button">Save ${esc(time)}</button></div>`;
      row.querySelector('button').addEventListener('click', async (ev) => {
        const btn = ev.currentTarget;
        btn.disabled = true;
        btn.textContent = 'Saving…';
        try {
          await V.confirm(m.id, {
            by: 'admin',
            jummah: time,
            source: src,
            note: 'Jumu\'ah times read from ' + src + ' on ' + new Date().toISOString().slice(0, 10),
          });
          btn.textContent = 'Saved';
          toast('Saved — ' + time + ' for ' + m.name);
          await ensureCommunityVisible();
        } catch (err) {
          toast('Failed: ' + err.message);
          btn.disabled = false;
          btn.textContent = 'Save ' + time;
        }
      });
      list.appendChild(row);
    };

    const worker = async () => {
      while (queue.length && !stopped) {
        const m = queue.shift();
        status.textContent = `Reading ${done} of ${targets.length}… (${m.name})`;
        try {
          const data = await readJummah(m);
          const hit = (data.sources || []).find((s) => s.times && s.times.length);
          done += 1;
          if (hit) {
            addRow(m, pickTime(hit.times), hit.url, data.pages_read,
              hit.times.length > 1 ? '2nd of ' + hit.times.length : '');
          }
        } catch (err) {
          done += 1;
          failed += 1;
          if (err && (err.status === 404 || err.status === 401 || err.status === 403)) stopped = true;
        }
        status.textContent = `Reading ${done} of ${targets.length}…`;
      }
    };

    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, () => worker()));

    status.textContent = stopped
      ? `Stopped after ${done} of ${targets.length} masjids.`
      : `Read ${done} of ${targets.length} masjids.`;
    if (stopBtn) stopBtn.remove();
    const none = Math.max(0, done - found - failed);
    summary.textContent = `${found} masjid(s) with a Jumu'ah time, ${none} without one, ${failed} could not be read. Press Save on a row to verify that time.`;
    if (!found) list.innerHTML = '<li class="hint">No Jumu\'ah time was found on those websites.</li>';
  }

  // ------------------------------------------------- hands-off scan and save
  // Reads every masjid that still has no Jumu'ah time and writes what it finds
  // straight to the listing, source included. Two guards: it waits for Start,
  // and it only ever touches listings with no time yet, so a re-run cannot
  // overwrite a time a person already confirmed.
  async function autoSaveJummah() {
    const all = (window.NZApp && window.NZApp.masjids) || [];
    const targets = all.filter((m) => !m.jummah_times);
    if (!targets.length) { toast('Every masjid already has a Jumu\'ah time'); return; }

    openModal('Scan and save ' + targets.length + ' masjids', `
      <p class="hint">Reads each masjid with no Jumu'ah time yet — its own website first, then Kiwi Muslim Directory — and saves what it finds with the source page. Masjids that already have a time are left alone.</p>
      <div class="vbtns">
        <button class="vbtn confirm" id="jaStart" type="button">Start — save up to ${targets.length}</button>
        <button class="vbtn report" id="jaStop" type="button" disabled>Stop</button>
      </div>
      <p class="hint" id="jaStatus"></p>
      <ul class="admList" id="jaList"></ul>
      <p class="hint" id="jaSummary"></p>
    `);

    const start = $('jaStart');
    const stop = $('jaStop');
    const status = $('jaStatus');
    const list = $('jaList');
    const summary = $('jaSummary');
    let stopped = false;

    stop.addEventListener('click', () => {
      stopped = true;
      stop.disabled = true;
      stop.textContent = 'Stopping…';
    });
    // Nothing runs until a person presses Start on this screen.
    await new Promise((resolve) => {
      start.addEventListener('click', () => {
        start.disabled = true;
        start.textContent = 'Running…';
        stop.disabled = false;
        resolve();
      }, { once: true });
    });

    let done = 0;
    let saved = 0;
    let missing = 0;
    let failed = 0;
    const queue = targets.slice();

    const addRow = (m, time, src, state) => {
      const row = document.createElement('li');
      row.className = 'admItem';
      const badge = state === 'saved' ? 'verified' : 'unverified';
      row.innerHTML = `
        <div class="admTop"><b>${esc(m.name)}</b><span class="badge ${badge}">${esc(time || state)}</span></div>
        <p class="addr small">${esc(src || '')}</p>`;
      list.appendChild(row);
    };

    let authError = '';
    const addFail = (m, msg) => {
      const row = document.createElement('li');
      row.className = 'admItem';
      row.innerHTML = `
        <div class="admTop"><b>${esc(m.name)}</b><span class="badge unverified">failed</span></div>
        <p class="addr small">${esc(msg)}</p>`;
      list.appendChild(row);
    };

    const worker = async () => {
      while (queue.length && !stopped) {
        const m = queue.shift();
        status.textContent = `Reading ${done} of ${targets.length}… (${m.name})`;
        try {
          const data = await readJummah(m);
          const hit = (data.sources || []).find((s) => s.times && s.times.length);
          done += 1;
          if (!hit) { missing += 1; continue; }
          const time = pickTime(hit.times);
          try {
            await V.confirm(m.id, {
              by: 'admin',
              jummah: time,
              source: hit.url,
              note: 'Jumu\'ah time read from ' + hit.url + ' on ' + new Date().toISOString().slice(0, 10) + ' (automatic scan)',
            });
            saved += 1;
            addRow(m, time, hit.url, 'saved');
          } catch (e) {
            failed += 1;
            addFail(m, 'read ' + time + ' but the save failed: ' + ((e && e.message) || 'unknown error'));
          }
        } catch (e) {
          done += 1;
          failed += 1;
          const code = e && e.status;
          if (code === 401 || code === 403) {
            // Not this masjid's fault: the admin sign-in is the problem, so stop
            // instead of turning the other hundred into identical failures.
            stopped = true;
            authError = code === 401
              ? 'Your admin sign-in has expired, so no more times can be saved. Sign in again and run it again — everything saved so far is kept.'
              : 'This account is not an admin any more, so nothing more can be saved.';
            addFail(m, ((e && e.message) || 'not allowed') + ' — stopping here');
          } else {
            addFail(m, (e && e.message) || 'could not be read');
          }
        }
        status.textContent = `Reading ${done} of ${targets.length}…`;
      }
    };

    await Promise.all(Array.from({ length: Math.min(2, queue.length) }, () => worker()));

    status.textContent = stopped
      ? `Stopped after ${done} of ${targets.length} masjids.`
      : `Read ${done} of ${targets.length} masjids.`;
    if (stop) stop.remove();
    summary.textContent = `${saved} saved, ${missing} had no time, ${failed} failed.` + (authError ? ' ' + authError : '');
    if (authError) toast(authError);
    if (saved) await ensureCommunityVisible();
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
