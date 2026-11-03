/* NZ Masjid Finder — app shell: tabs, shared state, and the Masjid map. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  const App = {
    masjids: [],
    halal: [],
    meta: {},
    userPos: null,
    place: { lat: -36.8485, lon: 174.7633, label: 'Auckland' },
    maps: {},          // id -> L.Map
    layers: {},        // id -> L.LayerGroup
    esc, $,
  };
  window.NZApp = App;

  // ------------------------------------------------------------ tabs
  const TABS = ['map', 'prayer', 'halal', 'ramadan', 'qibla'];

  function showTab(name) {
    if (!TABS.includes(name)) name = 'map';
    document.querySelectorAll('.view').forEach((v) => {
      v.hidden = v.id !== 'view-' + name;
    });
    document.querySelectorAll('.tab').forEach((t) => {
      const on = t.dataset.tab === name;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', String(on));
    });
    if (location.hash.slice(1) !== name) history.replaceState(null, '', '#' + name);
    // Leaflet needs a nudge when its container becomes visible
    const map = App.maps[name];
    if (map) setTimeout(() => map.invalidateSize(), 60);
    document.dispatchEvent(new CustomEvent('nz:tab', { detail: { tab: name } }));
  }
  App.showTab = showTab;

  document.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => showTab(t.dataset.tab));
  });
  window.addEventListener('hashchange', () => showTab(location.hash.slice(1) || 'map'));

  // ------------------------------------------------------------ helpers
  const KIND_LABEL = { mosque: 'Masjid', centre: 'Islamic centre', musalla: 'Musalla', other: 'Islamic place' };

  function distanceKm(a, b) {
    if (!a || !b) return null;
    const R = 6371, toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b[0] - a[0]);
    const dLon = toRad(b[1] - a[1]);
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  const fmtKm = (km) => (km == null ? '' : km < 1 ? Math.round(km * 1000) + ' m' : km.toFixed(1) + ' km');
  App.distanceKm = distanceKm;

  function directionsLinks(m) {
    const label = encodeURIComponent(m.name);
    return {
      google: 'https://www.google.com/maps/dir/?api=1&destination=' + m.lat + ',' + m.lon + '&travelmode=driving',
      apple: 'https://maps.apple.com/?daddr=' + m.lat + ',' + m.lon + '&q=' + label + '&dirflg=d',
      osm: 'https://www.openstreetmap.org/directions?to=' + m.lat + '%2C' + m.lon,
    };
  }
  App.directionsLinks = directionsLinks;

  const telHref = (p) => 'tel:' + p.replace(/[^\d+]/g, '');

  function baseMap(id, center, zoom) {
    if (App.maps[id]) return App.maps[id];
    const map = L.map(id, { zoomControl: true, scrollWheelZoom: true }).setView(center || [-41.2, 172.9], zoom || 5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    App.maps[id] = map;
    App.layers[id] = L.layerGroup().addTo(map);
    return map;
  }
  App.baseMap = baseMap;

  const pin = (color) => L.divIcon({
    className: 'pin-wrap',
    html: '<span class="pin" style="background:' + color + '"></span>',
    iconSize: [22, 22], iconAnchor: [11, 22], popupAnchor: [0, -20],
  });
  App.pin = pin;

  // ------------------------------------------------------------ location
  function requestLocation() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error('Geolocation unavailable'));
      navigator.geolocation.getCurrentPosition(
        (p) => {
          App.userPos = [p.coords.latitude, p.coords.longitude];
          App.place = { lat: p.coords.latitude, lon: p.coords.longitude, label: 'Your location' };
          document.dispatchEvent(new CustomEvent('nz:location', { detail: App.place }));
          resolve(App.place);
        },
        (err) => {
          // iOS gives a clearer reason than the default — surface it
          const msg = err.code === 1
            ? 'Location is blocked. On iPhone: Settings → Privacy & Security → Location Services → Safari → While Using, then reload.'
            : (err.code === 3 ? 'Location timed out. Move somewhere with a clearer view of the sky and try again.' : err.message);
          reject(new Error(msg));
        },
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
      );
    });
  }
  App.requestLocation = requestLocation;

  // ------------------------------------------------------------ masjid map view
  function masjidCard(m) {
    const dir = directionsLinks(m);
    const d = App.userPos ? distanceKm(App.userPos, [m.lat, m.lon]) : null;
    const phone = m.phones && m.phones[0];
    const addr = (m.address && m.address.formatted) || (m.lat.toFixed(4) + ', ' + m.lon.toFixed(4));
    return '<h3>' + esc(m.name) + '</h3>' +
      '<p class="addr">' + esc(addr) + (m.region ? ' · ' + esc(m.region) : '') + '</p>' +
      '<div class="badges">' +
        '<span class="badge kind">' + esc(KIND_LABEL[m.kind] || 'Islamic place') + '</span>' +
        (m.verified ? '<span class="badge verified">✓ Verified</span>' : '<span class="badge unverified">Unverified</span>') +
        (d != null ? '<span class="badge dist">' + fmtKm(d) + ' away</span>' : '') +
      '</div>' +
      '<div class="actions">' +
        '<a class="mapdir" href="' + dir.google + '" target="_blank" rel="noopener">Google Maps</a>' +
        '<a href="' + dir.apple + '" target="_blank" rel="noopener">Apple Maps</a>' +
        (phone ? '<a href="' + esc(telHref(phone)) + '">' + esc(phone) + '</a>' : '') +
        (m.website ? '<a href="' + esc(m.website) + '" target="_blank" rel="noopener">Website</a>' : '') +
      '</div>' +
      (m.jummah_times ? '<p class="addr" style="margin:8px 0 0"><b>Jumu\'ah:</b> ' + esc(m.jummah_times) + '</p>' : '') +
      (window.NZMapExtra ? window.NZMapExtra.verifySection(m) : '');
  }
  App.masjidCard = masjidCard;

  const state = { query: '', region: '', kind: '', onlyContact: false, onlyVerified: false, activeId: null, openForm: {} };
  App.masjidState = state;

  function filtered() {
    const tokens = state.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const list = App.masjids.filter((m) => {
      if (state.region && m.region !== state.region) return false;
      if (state.kind && m.kind !== state.kind) return false;
      if (state.onlyVerified && !m.verified) return false;
      if (state.onlyContact && !((m.phones && m.phones.length) || m.website || m.email)) return false;
      if (!tokens.length) return true;
      const hay = [m.name].concat(m.alt_names || [], [
        m.address && m.address.formatted, m.address && m.address.suburb,
        m.address && m.address.city, m.address && m.address.postcode, m.region, m.denomination,
      ]).filter(Boolean).join(' ').toLowerCase();
      return tokens.every((t) => hay.indexOf(t) !== -1);
    });
    if (App.userPos) {
      list.sort((a, b) => distanceKm(App.userPos, [a.lat, a.lon]) - distanceKm(App.userPos, [b.lat, b.lon]));
    } else {
      list.sort((a, b) => a.name.localeCompare(b.name));
    }
    return list;
  }
  App.filteredMasjids = filtered;

  function renderMasjidList(fit) {
    const items = filtered();
    const countEl = $('mCount');
    if (countEl) countEl.textContent = items.length + ' of ' + App.masjids.length;
    const list = $('mList');
    if (!list) return;
    if (!items.length) {
      list.innerHTML = '';
      const empty = $('mEmpty');
      if (empty) { empty.hidden = false; }
      return;
    }
    const empty = $('mEmpty');
    if (empty) empty.hidden = true;
    list.innerHTML = items.map((m) =>
      '<li class="card' + (m.id === state.activeId ? ' active' : '') + '" data-id="' + esc(m.id) + '">' +
      masjidCard(m) + '</li>').join('');

    const layer = App.layers.masjidMap;
    if (!layer) return;
    layer.clearLayers();
    items.forEach((m) => {
      L.marker([m.lat, m.lon], { icon: pin(m.verified ? '#0d5c4b' : '#8a6d1f'), title: m.name })
        .bindPopup('<h3>' + esc(m.name) + '</h3><p>' + esc((m.address && m.address.formatted) || '') + '</p>' +
          '<div class="actions"><a class="mapdir" href="' + directionsLinks(m).google +
          '" target="_blank" rel="noopener">Google</a><a href="' + directionsLinks(m).apple +
          '" target="_blank" rel="noopener">Apple</a></div>')
        .on('click', () => { state.activeId = m.id; renderMasjidList(false); })
        .addTo(layer);
    });
    if (fit) {
      if (items.length === 1) App.maps.masjidMap.setView([items[0].lat, items[0].lon], 14);
      else if (items.length) App.maps.masjidMap.fitBounds(L.latLngBounds(items.map((m) => [m.lat, m.lon])), { padding: [30, 30], maxZoom: 13 });
    }
  }
  App.renderMasjidList = renderMasjidList;

  function wireMasjidView() {
    const q = $('mQuery');
    if (!q) return;
    let t;
    q.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => { state.query = q.value; renderMasjidList(true); }, 180);
    });
    $('mClear').addEventListener('click', () => { q.value = ''; state.query = ''; renderMasjidList(true); });
    $('mRegion').addEventListener('change', (e) => { state.region = e.target.value; renderMasjidList(true); });
    $('mKind').addEventListener('change', (e) => { state.kind = e.target.value; renderMasjidList(true); });
    $('mContact').addEventListener('change', (e) => { state.onlyContact = e.target.checked; renderMasjidList(true); });
    $('mVerified').addEventListener('change', (e) => { state.onlyVerified = e.target.checked; renderMasjidList(true); });
    $('mNear').addEventListener('click', () => {
      requestLocation().then(() => {
        state.region = '';
        $('mRegion').value = '';
        L.circleMarker(App.userPos, { radius: 8, color: '#fff', weight: 2, fillColor: '#1d6ee0', fillOpacity: 1 })
          .addTo(App.maps.masjidMap).bindPopup('You are here');
        renderMasjidList(true);
      }).catch((e) => alert(e.message + '\n\nYou can still search by city, suburb or postcode.'));
    });
    $('mList').addEventListener('click', (e) => {
      if (e.target.closest('a, button, form')) return;
      const card = e.target.closest('.card');
      if (!card) return;
      state.activeId = card.dataset.id;
      renderMasjidList(false);
      const m = App.masjids.find((x) => x.id === state.activeId);
      if (m) App.maps.masjidMap.flyTo([m.lat, m.lon], 14, { duration: 0.5 });
    });
  }

  // ------------------------------------------------------------- sync readout
  function updateBackendBadge() {
    const V = window.NZVerification;
    const backendEl = $('backendState');
    if (!V || !backendEl) return;
    const st = (V.syncState ? V.syncState() : { backend: V.backend, shared: 0, queued: 0 });
    if (st.backend === 'supabase') {
      backendEl.textContent = '· shared: ' + st.shared + ' record(s)' +
        (st.queued ? ' · ' + st.queued + ' queued' : '') +
        (st.realtime ? ' · live' : '');
    } else if (st.backend === 'supabase-offline') {
      backendEl.textContent = '· offline — showing last shared data (' + (st.queued || 0) + ' change(s) queued)';
    } else {
      backendEl.textContent = '· this device only (Supabase not configured)';
    }
    updateStats();
  }

  // ------------------------------------------------------------ boot
  async function boot() {
    const metaEl = $('meta');
    try {
      const [mRes, hRes] = await Promise.all([
        fetch('data/masjids.json', { cache: 'no-cache' }),
        fetch('data/halal.json', { cache: 'no-cache' }).catch(() => null),
      ]);
      const mDoc = await mRes.json();
      const V = window.NZVerification;
      if (V && V.sync) await V.sync();
      try { if (V && V.subscribe) await V.subscribe(); } catch (e) { /* realtime optional */ }
      updateBackendBadge();
      App.masjids = (mDoc.masjids || []).map((m) => (V ? V.decorate(m) : m));
      App.meta = mDoc.meta || {};
      if (hRes && hRes.ok) {
        const hDoc = await hRes.json();
        App.halal = hDoc.businesses || [];
        App.halalMeta = hDoc.meta || {};
      }
      if (metaEl) metaEl.textContent = App.masjids.length + ' masjids · ' + App.halal.length + ' halal spots';

      const regions = {};
      App.masjids.forEach((m) => { regions[m.region] = (regions[m.region] || 0) + 1; });
      const sel = $('mRegion');
      if (sel) {
        Object.entries(regions).sort((a, b) => b[1] - a[1]).forEach(([r, n]) => {
          const o = document.createElement('option');
          o.value = r; o.textContent = r + ' (' + n + ')';
          sel.appendChild(o);
        });
      }

      baseMap('masjidMap');
      renderMasjidList(true);
      wireMasjidView();
    } catch (err) {
      if (metaEl) metaEl.textContent = 'Data failed to load';
      console.error(err);
    }
    showTab(location.hash.slice(1) || 'map');
  }

  document.addEventListener('DOMContentLoaded', boot);
})();

/* ---------------------------------------------------------------- verify hooks
 * The verification UI lives in app.js (it needs the list renderer); the
 * storage/queueing lives in verification.js.
 */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  function toast(msg) {
    const t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 2800);
  }
  window.NZToast = toast;

  const relTime = (iso) => {
    if (!iso) return '';
    const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
    if (d <= 0) return 'today';
    if (d === 1) return 'yesterday';
    if (d < 31) return d + ' days ago';
    const mo = Math.round(d / 30);
    return mo < 12 ? mo + ' month' + (mo > 1 ? 's' : '') + ' ago' : Math.round(d / 365) + ' year(s) ago';
  };

  function verifyBoxHtml(m) {
    const v = m.verification;
    const dir = window.NZApp.directionsLinks(m);
    if (v && v.status === 'verified') {
      return '<div class="vbox">' +
        '<p class="vline">✓ Confirmed by <b>' + esc(v.verified_by) + '</b> ' + esc(relTime(v.verified_at)) +
        (v.source_url ? ' · <a href="' + esc(v.source_url) + '" target="_blank" rel="noopener">source</a>' : ' · <i>no source link</i>') +
        '</p><div class="vbtns">' +
        '<button class="vbtn undo" data-act="undo" data-id="' + esc(m.id) + '" type="button">Undo</button>' +
        '<button class="vbtn report" data-act="report" data-id="' + esc(m.id) + '" type="button">Report a change</button>' +
        '</div></div>';
    }
    const flagged = v && v.status && v.status !== 'unverified';
    return '<div class="vbox">' +
      (flagged ? '<p class="vline">⚠ Reported by <b>' + esc(v.reported_by || 'Anonymous') + '</b> ' + esc(relTime(v.reported_at)) +
        (v.report_note ? ' — “' + esc(v.report_note) + '”' : '') + '</p>' : '') +
      '<p class="vline">Check the address, phone and Jumu\'ah time against the masjid\'s own website or a phone call before confirming.' +
      (m.website ? ' <a href="' + esc(m.website) + '" target="_blank" rel="noopener">Open their site ↗</a>' : '') + '</p>' +
      '<div class="vbtns">' +
      '<button class="vbtn confirm" data-act="confirm" data-id="' + esc(m.id) + '" type="button">✓ Confirm details</button>' +
      '<button class="vbtn report" data-act="report" data-id="' + esc(m.id) + '" type="button">Report issue</button>' +
      '<a class="vbtn" href="' + dir.google + '" target="_blank" rel="noopener">Check on map</a>' +
      '</div></div>';
  }

  function formHtml(m, act) {
    const confirm = act === 'confirm';
    const saved = JSON.parse(localStorage.getItem('nzmasjidfinder.verifier') || '{}');
    return '<form class="vform" data-form="' + act + '" data-id="' + esc(m.id) + '">' +
      '<label>Your name (recorded on the listing)</label>' +
      '<input name="by" required maxlength="60" value="' + esc(saved.name || '') + '" placeholder="e.g. Ahmed R." />' +
      (confirm
        ? '<label>Source you checked</label>' +
          '<input name="source" type="url" maxlength="300" value="' + esc(m.website || '') + '" placeholder="https://their-website.co.nz" />' +
          '<label>Jumu\'ah time (only if verified — otherwise leave blank)</label>' +
          '<input name="jummah" maxlength="120" value="' + esc(m.jummah_times || '') + '" placeholder="e.g. Khutbah 1:15pm, Salah 1:45pm" />'
        : '<label>What\'s wrong?</label>' +
          '<select name="kind">' +
          '<option value="needs_review">Something is wrong</option>' +
          '<option value="closed">Closed / no longer exists</option>' +
          '<option value="moved">Moved location</option>' +
          '<option value="outdated">Outdated contact details</option>' +
          '</select>') +
      '<label>Note (optional)</label>' +
      '<textarea name="note" maxlength="300" placeholder="' + (confirm ? 'e.g. Address and phone match their site' : 'e.g. Phone number is disconnected') + '"></textarea>' +
      '<p class="hint">' + (confirm ? 'Your name and source are stored with the listing so verification is never anonymous.' : 'This marks the listing unverified and sends it to the review queue.') + '</p>' +
      '<div class="formbtns">' +
      '<button class="vbtn ' + (confirm ? 'confirm' : 'report') + '" type="submit">' + (confirm ? 'Save verification' : 'Send report') + '</button>' +
      '<button class="vbtn undo" type="button" data-act="cancel" data-id="' + esc(m.id) + '">Cancel</button>' +
      '</div></form>';
  }

  window.NZMapExtra = {
    verifySection(m) {
      const V = window.NZVerification;
      const st = window.NZApp.masjidState;
      if (!V || (!V.isVerifying() && !m.verification)) return '';
      const form = st.openForm[m.id];
      return form ? formHtml(m, form) : verifyBoxHtml(m);
    },
  };

  function refresh(id) {
    const App = window.NZApp;
    const V = window.NZVerification;
    const idx = App.masjids.findIndex((m) => m.id === id);
    if (idx >= 0) {
      const base = Object.assign({}, App.masjids[idx]);
      delete base.verification; delete base.verified; delete base.status;
      delete base.verified_by; delete base.verified_at; delete base.jummah_times;
      App.masjids[idx] = V.decorate(base);
    }
    delete App.masjidState.openForm[id];
    updateStats();
    updateBackendBadge();
    App.renderMasjidList(false);
  }

  function updateStats() {
    const V = window.NZVerification;
    const App = window.NZApp;
    if (!V) return;
    const s = V.stats(App.masjids.map((m) => m.id));
    const el = $('verifyStats');
    if (el) el.textContent = s.verified + ' verified · ' + s.flagged + ' flagged · ' + (App.masjids.length - s.verified - s.flagged) + ' unchecked';
  }

  document.addEventListener('DOMContentLoaded', () => {
    const V = window.NZVerification;
    const App = window.NZApp;
    const btn = $('adminBtn');
    if (!btn || !V) return;

    btn.setAttribute('aria-pressed', String(V.isVerifying()));
    $('verifyBar').hidden = !V.isVerifying();
    updateStats();

    btn.addEventListener('click', () => {
      const on = !V.isVerifying();
      V.setVerifying(on);
      btn.setAttribute('aria-pressed', String(on));
      $('verifyBar').hidden = !on;
      App.masjidState.openForm = {};
      updateStats();
      App.renderMasjidList(false);
      toast(on ? 'Verification mode on — tap “Confirm details” on a card' : 'Verification mode off');
    });

    $('exportBtn').addEventListener('click', () => {
      const payload = V.exportJson(App.masjids);
      if (!payload.records.length) return toast('Nothing verified yet');
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'nz-masjid-verifications-' + new Date().toISOString().slice(0, 10) + '.json';
      a.click();
      URL.revokeObjectURL(a.href);
      toast('Exported ' + payload.records.length + ' record(s)');
    });

    $('resetBtn').addEventListener('click', () => {
      if (!confirm('Remove all verifications and reports stored in this browser?')) return;
      V.clearAll();
      App.masjids = App.masjids.map((m) => V.decorate(Object.assign({}, m, {
        verification: undefined, verified: false, status: 'unverified', verified_by: null, verified_at: null,
      })));
      updateStats();
      App.renderMasjidList(false);
      toast('All verifications cleared');
    });

    const list = $('mList');
    list.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      e.stopPropagation();
      const id = b.dataset.id;
      const act = b.dataset.act;
      if (act === 'confirm' || act === 'report') {
        App.masjidState.openForm = {};
        App.masjidState.openForm[id] = act;
        App.renderMasjidList(false);
        const card = document.querySelector('.card[data-id="' + CSS.escape(id) + '"]');
        const input = card && card.querySelector('.vform input, .vform select');
        if (input) input.focus();
        return;
      }
      if (act === 'cancel') { delete App.masjidState.openForm[id]; App.renderMasjidList(false); return; }
      if (act === 'undo') { V.undo(id); refresh(id); toast('Verification removed'); }
    });

    list.addEventListener('submit', (e) => {
      const form = e.target.closest('.vform');
      if (!form) return;
      e.preventDefault();
      const id = form.dataset.id;
      const act = form.dataset.form;
      const data = Object.fromEntries(new FormData(form).entries());
      const name = (data.by || '').trim();
      if (!name) return toast('Please add your name — verification must not be anonymous');
      localStorage.setItem('nzmasjidfinder.verifier', JSON.stringify({ name }));
      if (act === 'confirm') { V.confirm(id, data); toast('✓ Verified and saved with your name'); }
      else { V.report(id, data); toast('Report saved — listing marked for review'); }
      refresh(id);
    });

    document.addEventListener('nz:tab', (e) => {
      if (e.detail.tab === 'map') App.renderMasjidList(false);
  });
  document.addEventListener('nz:masjids-changed', () => {
      const V = window.NZVerification;
      if (V) {
        App.masjids = App.masjids.map((m) => {
          const base = Object.assign({}, m);
          delete base.verification;
          return V.decorate(base);
        });
      }
      updateBackendBadge();
      App.renderMasjidList(false);
  });
  });
})();
