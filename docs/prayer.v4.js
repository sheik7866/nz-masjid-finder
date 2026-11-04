/* NZ Masjid Finder — daily prayer times.
 *
 * Primary source: AlAdhan API (free, no key, no card — api.aladhan.com).
 * Fallback: a built-in solar calculation so the app still works offline.
 *
 * NOTHING here is invented. Times are either computed from the sun's position
 * for the exact coordinates, or fetched from AlAdhan and cached. When a masjid's
 * own Jumu'ah time has been verified by a person, the app shows that instead.
 */
(() => {
  'use strict';

  const CACHE_PREFIX = 'nzmasjidfinder.prayer.v1.';
  const SETTINGS_KEY = 'nzmasjidfinder.prayerSettings.v1';

  // AlAdhan calculation methods (free API). NZ communities mostly follow
  // ISNA or MWL; FIANZ-affiliated masjids often use the local sighting calendar,
  // so the user can switch and their choice is remembered.
  const METHODS = [
    { id: 3, label: 'Muslim World League' },
    { id: 2, label: 'Islamic Society of North America (ISNA)' },
    { id: 4, label: 'Umm Al-Qura, Makkah' },
    { id: 5, label: 'Egyptian General Authority' },
    { id: 1, label: 'University of Islamic Sciences, Karachi' },
    { id: 8, label: 'Gulf Region' },
    { id: 0, label: 'Shia Ithna-Ashari' },
  ];

  const CITIES = [
    { name: 'Auckland', lat: -36.8485, lon: 174.7633 },
    { name: 'Hamilton', lat: -37.7870, lon: 175.2793 },
    { name: 'Tauranga', lat: -37.6878, lon: 176.1651 },
    { name: 'Rotorua', lat: -38.1368, lon: 176.2497 },
    { name: 'Gisborne', lat: -38.6623, lon: 178.0176 },
    { name: 'Napier', lat: -39.4928, lon: 176.9120 },
    { name: 'Hastings', lat: -39.6381, lon: 176.8492 },
    { name: 'New Plymouth', lat: -39.0556, lon: 174.0752 },
    { name: 'Whanganui', lat: -39.9301, lon: 175.0478 },
    { name: 'Palmerston North', lat: -40.3523, lon: 175.6082 },
    { name: 'Wellington', lat: -41.2866, lon: 174.7756 },
    { name: 'Nelson', lat: -41.2706, lon: 173.2840 },
    { name: 'Blenheim', lat: -41.5134, lon: 173.9612 },
    { name: 'Greymouth', lat: -42.4500, lon: 171.2100 },
    { name: 'Christchurch', lat: -43.5321, lon: 172.6362 },
    { name: 'Timaru', lat: -44.3967, lon: 171.2536 },
    { name: 'Queenstown', lat: -45.0312, lon: 168.6626 },
    { name: 'Dunedin', lat: -45.8788, lon: 170.5028 },
    { name: 'Invercargill', lat: -46.4132, lon: 168.3538 },
  ];

  // ------------------------------------------------------------ astronomy
  const rad = (d) => (d * Math.PI) / 180;
  const deg = (r) => (r * 180) / Math.PI;
  const fixAngle = (a) => ((a % 360) + 360) % 360;
  const fixHour = (h) => ((h % 24) + 24) % 24;

  /** Julian day for the local calendar date, at 00:00 UT of that date. */
  function julianDate(y, m, d) {
    if (m <= 2) { y -= 1; m += 12; }
    const A = Math.floor(y / 100);
    const B = 2 - A + Math.floor(A / 4);
    return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + d + B - 1524.5 - 0.5;
  }

  const sunPosition = (jd) => {
    const D = jd - 2451545.0;
    const g = fixAngle(357.529 + 0.98560028 * D);
    const q = fixAngle(280.459 + 0.98564736 * D);
    const L = fixAngle(q + 1.915 * Math.sin(rad(g)) + 0.020 * Math.sin(rad(2 * g)));
    const e = 23.439 - 0.00000036 * D;
    const RA = fixHour(deg(Math.atan2(Math.cos(rad(e)) * Math.sin(rad(L)), Math.cos(rad(L)))) / 15);
    const decl = deg(Math.asin(Math.sin(rad(e)) * Math.sin(rad(L))));
    const EqT = q / 15 - RA;
    return { decl, EqT };
  };

  /** Solar-based prayer times for one day at one place (fallback + offline).
   *  Returns UTC hours; the caller converts with the place's tz offset. */
  function computeTimes(lat, lon, date, params) {
    const p = Object.assign({ fajr: 18, isha: 17, asr: 1 }, params || {});
    // JD is 0h UT of the local calendar date; +0.5 puts the sun at local noon
    const jd = julianDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
    const { decl, EqT } = sunPosition(jd + 0.5);

    // AlAdhan's convention: noon(UTC) = 12 - longitude/15 - EqT, so a place east
    // of Greenwich has its noon *earlier* in UTC. (Verified against the live API.)
    const dhuhr = fixHour(12 - (lon / 15) - EqT);

    const hourAngle = (angle) => {
      const cosH = (Math.sin(rad(-angle)) - Math.sin(rad(lat)) * Math.sin(rad(decl))) /
        (Math.cos(rad(lat)) * Math.cos(rad(decl)));
      if (cosH > 1 || cosH < -1) return null;      // sun never reaches the angle
      return deg(Math.acos(cosH)) / 15;
    };

    const tSunrise = hourAngle(0.833);
    const tFajr = hourAngle(p.fajr);
    const tIsha = p.isha === '90min' ? null : hourAngle(p.isha);

    // Asr: Shafi'i (shadow factor 1) or Hanafi (factor 2)
    const shadow = p.asr === 2 ? 2 : 1;
    const asrAngle = -deg(Math.atan(1 / (shadow + Math.tan(rad(Math.abs(lat - decl))))));
    const tAsr = hourAngle(asrAngle);

    const mk = (h) => (h == null ? null : fixHour(h));

    return {
      fajr: mk(tFajr == null ? null : dhuhr - tFajr),
      sunrise: mk(tSunrise == null ? null : dhuhr - tSunrise),
      dhuhr: mk(dhuhr + 1 / 60),
      asr: mk(tAsr == null ? null : dhuhr + tAsr),
      maghrib: mk(tSunrise == null ? null : dhuhr + tSunrise + 2 / 60),
      isha: p.isha === '90min'
        ? mk(tSunrise == null ? null : dhuhr + tSunrise + 1.5)
        : mk(tIsha == null ? null : dhuhr + tIsha),
    };
  }

  // ------------------------------------------------------------ formatting
  const pad = (n) => String(Math.floor(n)).padStart(2, '0');

  /** UTC hours -> "HH:MM" in a timezone offset (hours east of UTC). */
  function toClock(utcHours, tzOffsetHours) {
    if (utcHours == null || isNaN(utcHours)) return null;
    const local = fixHour(utcHours + tzOffsetHours);
    const h = Math.floor(local);
    const m = Math.round((local - h) * 60);
    return (m === 60) ? pad(h + 1) + ':00' : pad(h) + ':' + pad(m);
  }

  /** Offset of a place on a date, in hours east of UTC (handles NZDT). */
  function tzOffset(lat, lon, date) {
    try {
      const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Pacific/Auckland', timeZoneName: 'shortOffset',
      });
      const part = dtf.formatToParts(date).find((x) => x.type === 'timeZoneName');
      const m = part && part.value.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
      if (m) {
        const sign = m[1] === '-' ? -1 : 1;
        return sign * (Number(m[2]) + Number(m[3] || 0) / 60);
      }
    } catch (e) { /* fall through */ }
    // NZ: +12 standard, +13 daylight saving (last Sun Sep → first Sun Apr)
    const mo = date.getUTCMonth();
    return (mo >= 9 || mo <= 2) ? 13 : 12;
  }

  const ddmmyyyy = (d) => pad(d.getDate()) + '-' + pad(d.getMonth() + 1) + '-' + d.getFullYear();

  // ------------------------------------------------------------ settings
  function settings() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); }
    catch (e) { return {}; }
  }
  function saveSettings(s) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------ main API
  async function fetchAlAdhan(lat, lon, date, method) {
    const url = 'https://api.aladhan.com/v1/timings/' + ddmmyyyy(date) +
      '?latitude=' + lat.toFixed(4) + '&longitude=' + lon.toFixed(4) +
      '&method=' + (method == null ? 3 : method) + '&school=0';
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('AlAdhan HTTP ' + res.status);
    const doc = await res.json();
    if (!doc || !doc.data || !doc.data.timings) throw new Error('AlAdhan: empty response');
    const t = doc.data.timings;
    const clean = (s) => (s ? String(s).split(' ')[0] : null);
    return {
      source: 'AlAdhan API',
      method: doc.data.meta && doc.data.meta.method && doc.data.meta.method.name,
      times: {
        fajr: clean(t.Fajr), sunrise: clean(t.Sunrise), dhuhr: clean(t.Dhuhr),
        asr: clean(t.Asr), maghrib: clean(t.Maghrib), isha: clean(t.Isha),
      },
      hijri: doc.data.date && doc.data.date.hijri ? {
        day: doc.data.date.hijri.day,
        month: doc.data.date.hijri.month && doc.data.date.hijri.month.en,
        monthNumber: doc.data.date.hijri.month && doc.data.date.hijri.month.number,
        year: doc.data.date.hijri.year,
      } : null,
    };
  }

  function computeLocal(lat, lon, date, params) {
    const offset = tzOffset(lat, lon, date);
    const t = computeTimes(lat, lon, date, params);
    return {
      source: 'Calculated offline',
      method: 'Solar calculation (offline)',
      times: {
        fajr: toClock(t.fajr, offset), sunrise: toClock(t.sunrise, offset),
        dhuhr: toClock(t.dhuhr, offset), asr: toClock(t.asr, offset),
        maghrib: toClock(t.maghrib, offset), isha: toClock(t.isha, offset),
      },
      hijri: null,
    };
  }

  const api = {
    METHODS,
    CITIES,
    computeTimes,
    toClock,
    tzOffset,
    settings,
    saveSettings,

    /** Today's times with cache → API → offline calculation, in that order. */
    async getDay(lat, lon, date, opts) {
      const o = opts || {};
      const key = CACHE_PREFIX + Number(lat).toFixed(2) + ',' + Number(lon).toFixed(2) + ',' +
        ddmmyyyy(date) + ',' + (o.method == null ? 3 : o.method);
      if (!o.force) {
        try {
          const cached = localStorage.getItem(key);
          if (cached) {
            const parsed = JSON.parse(cached);
            if (parsed && parsed.times) return Object.assign(parsed, { cached: true });
          }
        } catch (e) { /* ignore */ }
      }
      try {
        const fresh = await fetchAlAdhan(lat, lon, date, o.method);
        try { localStorage.setItem(key, JSON.stringify(fresh)); } catch (e) { /* ignore */ }
        return fresh;
      } catch (err) {
        const fallback = computeLocal(lat, lon, date, o.offlineParams);
        fallback.error = err.message;
        // cache the offline result too, so a plane / tunnel still shows times
        try { localStorage.setItem(key, JSON.stringify(fallback)); } catch (e) { /* ignore */ }
        return fallback;
      }
    },

    /** Which prayer is next, and how long until it. */
    nextPrayer(times, now) {
      const order = ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'];
      const labels = { fajr: 'Fajr', sunrise: 'Sunrise', dhuhr: 'Dhuhr', asr: 'Asr', maghrib: 'Maghrib', isha: 'Isha' };
      const nowMin = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
      for (const k of order) {
        if (!times[k]) continue;
        const parts = times[k].split(':').map(Number);
        const at = parts[0] * 60 + parts[1];
        if (at > nowMin) return { key: k, label: labels[k], time: times[k], minutesUntil: Math.round(at - nowMin) };
      }
      const first = times.fajr;
      if (!first) return null;
      const parts = first.split(':').map(Number);
      return {
        key: 'fajr', label: 'Fajr', time: first, tomorrow: true,
        minutesUntil: Math.round(24 * 60 - nowMin + parts[0] * 60 + parts[1]),
      };
    },

    formatCountdown(minutes) {
      if (minutes == null) return '';
      const h = Math.floor(minutes / 60);
      const m = minutes % 60;
      return h > 0 ? h + 'h ' + m + 'm' : m + 'm';
    },

    /** Jumu'ah times that a person has actually verified. */
    verifiedJummah(masjids) {
      return masjids
        .filter((m) => m.jummah_times && (m.verified || m.verified_by))
        .map((m) => ({
          id: m.id, name: m.name, region: m.region,
          address: (m.address && m.address.formatted) || null,
          jummah: m.jummah_times, by: m.verified_by, at: m.verified_at,
          lat: m.lat, lon: m.lon,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
  };

  window.NZPrayer = api;
})();
