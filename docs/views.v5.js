/* NZ Masjid Finder — Prayer, Halal, Ramadan and Qibla views. */
(() => {
  'use strict';

  const App = window.NZApp;
  const P = window.NZPrayer;
  const Q = window.NZQibla;
  const V = window.NZVerification;
  const $ = (id) => document.getElementById(id);
  const esc = App.esc;

  const PRAYER_LABELS = [
    ['fajr', 'Fajr'], ['sunrise', 'Sunrise'], ['dhuhr', 'Dhuhr'],
    ['asr', 'Asr'], ['maghrib', 'Maghrib'], ['isha', 'Isha'],
  ];

  const today = () => new Date();
  const isFriday = (d) => d.getDay() === 5;

  // =========================================================== PRAYER VIEW
  let prayerTimer = null;

  function fillCitySelect(sel, current) {
    if (!sel || sel.options.length) return;
    P.CITIES.forEach((c) => {
      const o = document.createElement('option');
      o.value = c.name;
      o.textContent = c.name;
      sel.appendChild(o);
    });
    if (current) sel.value = current;
  }

  function fillMethods() {
    const sel = $('pMethod');
    if (!sel || sel.options.length) return;
    P.METHODS.forEach((m) => {
      const o = document.createElement('option');
      o.value = String(m.id);
      o.textContent = m.label;
      sel.appendChild(o);
    });
    const s = P.settings();
    sel.value = String(s.method == null ? 3 : s.method);
  }

  async function renderPrayer() {
    const place = App.place;
    fillCitySelect($('pCity'), null);
    fillMethods();
    const settings = P.settings();
    const method = settings.method == null ? 3 : settings.method;

    $('pNext').textContent = '…';
    const day = await P.getDay(place.lat, place.lon, today(), { method });
    const times = day.times;

    // hijri date
    if (day.hijri) {
      $('pHijri').textContent = day.hijri.day + ' ' + day.hijri.month + ' ' + day.hijri.year + ' AH';
    } else {
      const h = Q.todayHijri(today());
      $('pHijri').textContent = h.day + ' ' + h.monthName + ' ' + h.year + ' AH · ' + place.label;
    }

    const next = P.nextPrayer(times, new Date());
    if (next) {
      $('pNext').textContent = (next.tomorrow ? 'Tomorrow: ' : '') + next.label + ' at ' + next.time;
      $('pNextSub').textContent = 'in ' + P.formatCountdown(next.minutesUntil) + ' · ' + place.label;
    } else {
      $('pNext').textContent = 'Prayer times';
      $('pNextSub').textContent = place.label;
    }

    $('pSource').textContent = day.cached ? day.source + ' (cached)' : day.source;
    $('pTimes').innerHTML = PRAYER_LABELS.map(([key, label]) => {
      const t = times[key];
      const isNext = next && next.key === key && !next.tomorrow;
      const isFridayRow = key === 'dhuhr' && isFriday(today());
      return '<li class="' + (isNext ? 'next' : '') + '">' +
        '<span class="plabel">' + label + (isFridayRow ? ' <small>Jumu\'ah</small>' : '') + '</span>' +
        '<span class="ptime">' + (t || '—') + '</span></li>';
    }).join('');

    $('pNote').textContent = day.error
      ? 'Offline mode: ' + day.error + '. Times are calculated locally for ' + place.lat.toFixed(3) + ', ' + place.lon.toFixed(3) + '.'
      : 'Method: ' + (day.method || 'Muslim World League') + '. Calculated for ' + place.lat.toFixed(3) + ', ' + place.lon.toFixed(3) + '.';

    renderJummah();

    clearInterval(prayerTimer);
    prayerTimer = setInterval(() => { if (!$('view-prayer').hidden) renderPrayer(); }, 60000);
  }

  function renderJummah() {
    const list = P.verifiedJummah(App.masjids);
    $('jCount').textContent = String(list.length);
    if (!list.length) {
      $('pJummah').innerHTML = '<li class="empty">No verified Jumu\'ah times yet. Open a masjid in the Masjids tab and press “Confirm details” once you have checked its own timetable — that is what fills this list.</li>';
      return;
    }
    $('pJummah').innerHTML = list.map((j) => {
      const dir = App.directionsLinks(j);
      return '<li><div><b>' + esc(j.name) + '</b>' +
        '<p class="addr">' + esc(j.address || j.region || '') + '</p>' +
        '<p class="addr small">verified by ' + esc(j.by || 'a member') + '</p></div>' +
        '<div class="jright"><span class="jtime">' + esc(j.jummah) + '</span>' +
        '<a href="' + dir.google + '" target="_blank" rel="noopener">Directions</a></div></li>';
    }).join('');
  }

  function wirePrayer() {
    $('pLocate').addEventListener('click', () => {
      App.requestLocation().then(() => renderPrayer()).catch((e) => alert(e.message + '\n\nPick a city instead.'));
    });
    $('pCity').addEventListener('change', (e) => {
      const c = P.CITIES.find((x) => x.name === e.target.value);
      if (!c) return;
      App.place = { lat: c.lat, lon: c.lon, label: c.name };
      renderPrayer();
    });
    $('pMethod').addEventListener('change', (e) => {
      const s = P.settings();
      s.method = Number(e.target.value);
      P.saveSettings(s);
      renderPrayer();
    });
    document.addEventListener('nz:tab', (e) => { if (e.detail.tab === 'prayer') renderPrayer(); });
  }

  // =========================================================== HALAL VIEW
  const hState = { query: '', cat: '', region: '', near: false };

  function halalFiltered() {
    const tokens = hState.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let rows = App.halal.filter((b) => {
      if (hState.cat && b.category !== hState.cat) return false;
      if (hState.region && b.region !== hState.region) return false;
      if (!tokens.length) return true;
      const hay = [b.name, b.category, b.cuisine, b.address, b.city, b.region].filter(Boolean).join(' ').toLowerCase();
      return tokens.every((t) => hay.indexOf(t) !== -1);
    });
    if (hState.near && App.userPos) {
      rows.sort((a, b) => App.distanceKm(App.userPos, [a.lat, a.lon]) - App.distanceKm(App.userPos, [b.lat, b.lon]));
    } else {
      rows.sort((a, b) => a.name.localeCompare(b.name));
    }
    return rows;
  }

  function renderHalal() {
    const rows = halalFiltered();
    $('hCount').textContent = rows.length + ' of ' + App.halal.length;

    const cats = {};
    App.halal.forEach((b) => { cats[b.category] = (cats[b.category] || 0) + 1; });
    const catSel = $('hCat');
    if (catSel.options.length <= 1) {
      Object.entries(cats).sort((a, b) => b[1] - a[1]).forEach(([c, n]) => {
        const o = document.createElement('option');
        o.value = c; o.textContent = c + ' (' + n + ')';
        catSel.appendChild(o);
      });
    }
    const regs = {};
    App.halal.forEach((b) => { regs[b.region] = (regs[b.region] || 0) + 1; });
    const regSel = $('hRegion');
    if (regSel.options.length <= 1) {
      Object.entries(regs).sort((a, b) => b[1] - a[1]).forEach(([r, n]) => {
        const o = document.createElement('option');
        o.value = r; o.textContent = r + ' (' + n + ')';
        regSel.appendChild(o);
      });
    }

    if (!rows.length) {
      $('hList').innerHTML = '<li class="empty">Nothing matches. Try another suburb or clear the filters.</li>';
    } else {
      $('hList').innerHTML = rows.map((b) => {
        const d = App.userPos ? App.distanceKm(App.userPos, [b.lat, b.lon]) : null;
        const dir = App.directionsLinks(b);
        return '<li class="card">' +
          '<h3>' + esc(b.name) + '</h3>' +
          '<p class="addr">' + esc(b.category) + (b.cuisine ? ' · ' + esc(b.cuisine) : '') +
          (d != null ? ' · ' + (d < 1 ? Math.round(d * 1000) + ' m' : d.toFixed(1) + ' km') : '') + '</p>' +
          '<p class="addr">' + esc(b.address || b.region) + '</p>' +
          '<div class="badges"><span class="badge ' + (b.verified ? 'verified' : 'unverified') + '">' +
            (b.verified ? '✓ Verified halal' : 'OSM halal tag') + '</span>' +
            (b.halal_tag === 'only' ? '<span class="badge kind">Halal only</span>' : '') + '</div>' +
          '<div class="actions">' +
            '<a class="mapdir" href="' + dir.google + '" target="_blank" rel="noopener">Google Maps</a>' +
            '<a href="' + dir.apple + '" target="_blank" rel="noopener">Apple Maps</a>' +
            (b.phone ? '<a href="tel:' + esc(b.phone.replace(/[^\d+]/g, '')) + '">' + esc(b.phone) + '</a>' : '') +
            (b.website ? '<a href="' + esc(b.website) + '" target="_blank" rel="noopener">Website</a>' : '') +
            (b.opening_hours ? '<a href="#" onclick="return false" title="' + esc(b.opening_hours) + '">' + esc(b.opening_hours.slice(0, 26)) + '</a>' : '') +
          '</div></li>';
      }).join('');
    }

    const map = App.baseMap('halalMap');
    const layer = App.layers.halalMap;
    layer.clearLayers();
    rows.slice(0, 800).forEach((b) => {
      L.marker([b.lat, b.lon], { icon: App.pin('#b3541e'), title: b.name })
        .bindPopup('<h3>' + esc(b.name) + '</h3><p>' + esc(b.category) + (b.address ? ' · ' + esc(b.address) : '') + '</p>' +
          '<div class="actions"><a class="mapdir" href="' + App.directionsLinks(b).google + '" target="_blank" rel="noopener">Directions</a></div>')
        .addTo(layer);
    });
    if (rows.length) {
      if (rows.length === 1) map.setView([rows[0].lat, rows[0].lon], 14);
      else map.fitBounds(L.latLngBounds(rows.map((b) => [b.lat, b.lon])), { padding: [30, 30], maxZoom: 13 });
    }
    setTimeout(() => map.invalidateSize(), 80);
  }

  function wireHalal() {
    let t;
    $('hQuery').addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => { hState.query = $('hQuery').value; renderHalal(); }, 180);
    });
    $('hCat').addEventListener('change', (e) => { hState.cat = e.target.value; renderHalal(); });
    $('hRegion').addEventListener('change', (e) => { hState.region = e.target.value; renderHalal(); });
    $('hNear').addEventListener('change', (e) => {
      hState.near = e.target.checked;
      if (hState.near && !App.userPos) {
        App.requestLocation().then(() => renderHalal()).catch(() => { hState.near = false; $('hNear').checked = false; });
      } else {
        renderHalal();
      }
    });
    document.addEventListener('nz:tab', (e) => { if (e.detail.tab === 'halal') renderHalal(); });
  }

  // =========================================================== RAMADAN VIEW
  function renderRamadan() {
    const place = App.place;
    fillCitySelect($('rCity'), null);
    const status = Q.ramadanStatus(today());
    const cal = Q.ramadanCalendar(today(), place.lat, place.lon, P);

    if (status.inRamadan) {
      $('rCountdown').textContent = 'Day ' + status.day + ' of Ramadan ' + status.hijri.year + ' AH';
    } else {
      const ms = cal.start - today();
      const days = Math.max(0, Math.ceil(ms / 86400000));
      $('rCountdown').textContent = days > 0
        ? days + ' days until Ramadan ' + cal.hijriYear + ' AH'
        : 'Ramadan ' + cal.hijriYear + ' AH has ended — next one starts ' + Q.ramadanStart(new Date(cal.end.getTime() + 40 * 86400000)).toLocaleDateString('en-NZ', { day: 'numeric', month: 'long', year: 'numeric' });
    }
    $('rRange').textContent = cal.start.toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' }) +
      ' → ' + cal.end.toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' }) +
      ' · ' + place.label;

    const tbody = $('rTable');
    tbody.innerHTML = cal.days.map((d) => {
      const isToday = d.iso === new Date().toISOString().slice(0, 10);
      const dow = d.date.toLocaleDateString('en-NZ', { weekday: 'short' });
      return '<tr class="' + (isToday ? 'today' : '') + '">' +
        '<td>' + d.day + '</td>' +
        '<td>' + d.date.toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' }) + '</td>' +
        '<td>' + dow + '</td>' +
        '<td>' + (d.suhoorEnds || '—') + '</td>' +
        '<td>' + (d.iftar || '—') + '</td></tr>';
    }).join('');

    // today's row into view
    const row = tbody.querySelector('tr.today');
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'center' });

    renderEvents();
  }

  async function renderEvents() {
    const box = $('rEvents');
    if (!box) return;
    const approvedEvents = (App.communityEvents || []).slice();
    const local = (V && V.localSubmissions) ? V.localSubmissions().filter((s) => s.type === 'event') : [];
    let remote = [];
    const SB = window.NZSupabase;
    if (SB && SB.enabled && SB.isSignedIn && SB.isSignedIn()) {
      try { remote = await SB.listSubmissions(); } catch (e) { remote = []; }
    }
    const events = approvedEvents.concat(remote, local)
      .filter((s, i, arr) => s.type === 'event' && arr.findIndex((x) => String(x.id) === String(s.id)) === i);
    if (!events.length) {
      box.innerHTML = '<p class="empty">No iftar or event listings yet. Community events appear here once a masjid or organiser submits them.</p>';
      return;
    }
    box.innerHTML = '<ul class="admList">' + events.map((e) => '<li class="admItem">' +
      '<div class="admTop"><b>' + esc(e.name) + '</b><span class="badge kind">' + esc(e.status || 'pending') + '</span></div>' +
      '<p class="addr">' + esc(e.address || e.city || '') + '</p>' +
      (e.notes ? '<p class="addr">' + esc(e.notes) + '</p>' : '') +
      '</li>').join('') + '</ul>';
  }

  function wireRamadan() {
    $('rLocate').addEventListener('click', () => {
      App.requestLocation().then(() => renderRamadan()).catch((e) => alert(e.message + '\n\nPick a city instead.'));
    });
    $('rCity').addEventListener('change', (e) => {
      const c = P.CITIES.find((x) => x.name === e.target.value);
      if (!c) return;
      App.place = { lat: c.lat, lon: c.lon, label: c.name };
      renderRamadan();
    });
    document.addEventListener('nz:tab', (e) => { if (e.detail.tab === 'ramadan') renderRamadan(); });
  }

  // =========================================================== QIBLA VIEW
  let compassHandler = null;
  let deviceHeading = null;

  function renderQibla() {
    const place = App.place;
    const bearing = Q.qiblaBearing(place.lat, place.lon);
    const dist = Q.distanceToKaaba(place.lat, place.lon);
    $('qPlace').textContent = place.label + ' · ' + place.lat.toFixed(3) + ', ' + place.lon.toFixed(3);
    $('qDeg').textContent = bearing.toFixed(1) + '° ' + Q.compassName(bearing) + ' from true north';
    $('qDist').textContent = Math.round(dist).toLocaleString('en-NZ') + ' km to the Ka\'bah, Makkah';

    const needle = $('qNeedle');
    const device = $('qDevice');
    if (deviceHeading == null) {
      needle.style.transform = 'rotate(' + bearing + 'deg)';
      device.style.display = 'none';
      $('qNote').textContent = 'Arrow shows the qibla bearing from north. Without a compass, lay your phone flat and use the phone\'s top edge as north.';
    } else {
      // rotate the whole ring by the device heading, needle sits at the qibla bearing
      needle.style.transform = 'rotate(' + (bearing - deviceHeading) + 'deg)';
      device.style.display = 'block';
      device.style.transform = 'rotate(' + (-deviceHeading) + 'deg)';
      $('qNote').textContent = 'Live compass active — turn until the green arrow points straight ahead.';
    }

    // Compass needs two things on iOS: DeviceOrientationEvent to exist, and
    // (Safari 13+) a requestPermission() call made from a user tap. Over plain
    // http on a LAN address iOS also blocks both — that is why the app must be
    // served over https to work on a real iPhone.
    const hasSensor = typeof DeviceOrientationEvent !== 'undefined';
    const needsPrompt = hasSensor && typeof DeviceOrientationEvent.requestPermission === 'function';
    $('qCompass').hidden = !hasSensor;
    const perm = $('qPerm');
    if (perm) {
      perm.textContent = !window.isSecureContext
        ? '⚠️ This page is not on https, so iPhone Safari will not share the compass or exact location. Open the https:// address.'
        : (needsPrompt ? 'iPhone will ask for motion & orientation access — tap “Allow” when it appears.' : '');
    }
  }

  function wireQibla() {
    $('qLocate').addEventListener('click', () => {
      App.requestLocation().then(() => renderQibla()).catch((e) => alert(e.message));
    });
    $('qCompass').addEventListener('click', async () => {
      try {
        if (typeof DeviceOrientationEvent !== 'undefined' &&
            typeof DeviceOrientationEvent.requestPermission === 'function') {
          const res = await DeviceOrientationEvent.requestPermission();
          if (res !== 'granted') throw new Error('permission denied');
        }
        compassHandler = (e) => {
          let heading = null;
          if (typeof e.webkitCompassHeading === 'number') heading = e.webkitCompassHeading;   // iOS
          else if (e.alpha != null) heading = 360 - e.alpha;                                  // Android
          if (heading == null) return;
          deviceHeading = heading;
          renderQibla();
        };
        window.addEventListener('deviceorientationabsolute', compassHandler, true);
        window.addEventListener('deviceorientation', compassHandler, true);
        $('qCompass').textContent = '🧭 Compass on';
      } catch (err) {
        alert('Compass not available on this device or browser. Use the bearing shown against a real compass.');
      }
    });
    document.addEventListener('nz:tab', (e) => { if (e.detail.tab === 'qibla') renderQibla(); });
  }

  // =========================================================== boot
  document.addEventListener('DOMContentLoaded', () => {
    wirePrayer();
    wireHalal();
    wireRamadan();
    wireQibla();
  });
})();
