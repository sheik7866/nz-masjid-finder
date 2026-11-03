/* NZ Masjid Finder — admin dashboard + community submission form.
 *
 * Opened from the header: "＋ Add masjid" (anyone) and "Admin" (sign-in).
 * Works with Supabase when configured; falls back to the browser queue so the
 * screens are testable without a project.
 */
(() => {
  'use strict';

  const V = window.NZVerification || { localSubmissions: () => [], submitMasjid: async () => ({ stored: 'local' }) };
  const SB = window.NZSupabase || { enabled: false, isSignedIn: () => false };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const $ = (id) => document.getElementById(id);

  const KIND = { mosque: 'Masjid', centre: 'Islamic centre', musalla: 'Musalla', other: 'Islamic place' };

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
      <p class="hint">Submissions are reviewed before they appear on the map. We never publish prayer times nobody has confirmed.</p>
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
      $('subStatus').textContent = 'Submitting…';
      const res = await V.submitMasjid(data);
      $('subStatus').innerHTML = res.stored === 'supabase'
        ? '✅ Submitted — thank you. It is in the review queue.'
        : '✅ Saved on this device. Connect Supabase (config.js) to send submissions to the shared review queue.';
      form.reset();
      toast('Submission saved');
    });
  }

  // ------------------------------------------------------------ admin
  function adminShell(inner) {
    const mode = V.backend === 'supabase' ? 'Supabase connected' : 'Browser-only (no Supabase configured)';
    return `<div class="adm">
      <p class="admbar">Storage: <b>${esc(mode)}</b>
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
      const subs = V.localSubmissions();
      openModal('Admin — review queue', adminShell(`<p class="hint">Supabase is not configured, so this shows only what was submitted on this device.</p>${subsHtml(subs)}`));
      return;
    }
    if (!SB.isSignedIn()) {
      openModal('Admin sign-in', signInHtml());
      wireSignIn();
      return;
    }
    openModal('Admin — review queue', adminShell('<p class="hint">Loading…</p>'));
    try {
      const [subs, vers] = await Promise.all([
        SB.listSubmissions().catch(() => []),
        SB.listVerifications().catch(() => ({})),
      ]);
      const flagged = Object.keys(vers).map((k) => vers[k]).filter((v) => v.status && v.status !== 'verified');
      const verified = Object.keys(vers).map((k) => vers[k]).filter((v) => v.status === 'verified');
      const wrap = $('modalWrap').querySelector('.modal-body');
      wrap.innerHTML = adminShell(`
        <div class="admstats">
          <span><b>${subs.filter((s) => s.status === 'pending').length}</b> pending submissions</span>
          <span><b>${flagged.length}</b> flagged listings</span>
          <span><b>${verified.length}</b> verified</span>
        </div>
        <h3>Community submissions</h3>
        ${subsHtml(subs)}
        <h3>Flagged listings</h3>
        ${flaggedHtml(flagged)}
      `);
      wireAdminActions();
      const so = $('signOut');
      if (so) so.addEventListener('click', () => { SB.signOut(); toast('Signed out'); closeModal(); });
    } catch (e) {
      const wrap = $('modalWrap').querySelector('.modal-body');
      wrap.innerHTML = adminShell(`<p class="hint" style="color:#a8402a">Could not load: ${esc(e.message)}</p>`);
    }
  }

  function subsHtml(subs) {
    if (!subs || !subs.length) return '<p class="hint">No submissions yet.</p>';
    return '<ul class="admList">' + subs.map((s) => `
      <li class="admItem">
        <div class="admTop"><b>${esc(s.name)}</b><span class="badge ${s.status === 'pending' ? 'unverified' : 'verified'}">${esc(s.status)}</span></div>
        <p class="addr">${esc([s.address, s.city, s.postcode].filter(Boolean).join(', ') || 'No address given')}
          ${s.lat && s.lon ? ` · <a href="https://www.google.com/maps?q=${s.lat},${s.lon}" target="_blank" rel="noopener">map</a>` : ''}</p>
        ${s.contact ? `<p class="addr">☎ ${esc(s.contact)}</p>` : ''}
        ${s.website ? `<p class="addr"><a href="${esc(s.website)}" target="_blank" rel="noopener">${esc(s.website)}</a></p>` : ''}
        ${s.notes ? `<p class="addr">📝 ${esc(s.notes)}</p>` : ''}
        <p class="addr">${esc(s.type || 'masjid')} · by ${esc(s.submitted_by || 'unknown')} · ${esc((s.created_at || '').slice(0, 10))}</p>
        ${s.status === 'pending' && s.id && !String(s.id).startsWith('local-') ? `<div class="vbtns">
          <button class="vbtn confirm" data-sub="${esc(s.id)}" data-status="approved" type="button">Approve</button>
          <button class="vbtn report" data-sub="${esc(s.id)}" data-status="rejected" type="button">Reject</button>
        </div>` : ''}
      </li>`).join('') + '</ul>';
  }

  function flaggedHtml(list) {
    if (!list || !list.length) return '<p class="hint">Nothing flagged.</p>';
    return '<ul class="admList">' + list.map((v) => `
      <li class="admItem">
        <div class="admTop"><b>${esc(v.id)}</b><span class="badge unverified">${esc(v.status)}</span></div>
        ${v.report_note ? `<p class="addr">⚠ ${esc(v.report_note)}</p>` : ''}
        <p class="addr">reported by ${esc(v.reported_by || '?')} · ${esc((v.reported_at || '').slice(0, 10))}</p>
      </li>`).join('') + '</ul>';
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
          toast('Submission ' + status);
          await openAdmin();
        } catch (e) {
          toast('Failed: ' + e.message);
          btn.disabled = false;
        }
      });
    });
  }

  // ------------------------------------------------------------ boot
  window.NZAdmin = { openAdmin, openAddMasjid: () => { openModal('Add a missing masjid', addMasjidHtml()); wireAddMasjid(); } };

  document.addEventListener('DOMContentLoaded', () => {
    const addBtn = $('addBtn');
    const admBtn = $('adminPanelBtn');
    if (addBtn) addBtn.addEventListener('click', window.NZAdmin.openAddMasjid);
    if (admBtn) admBtn.addEventListener('click', openAdmin);
  });
})();
