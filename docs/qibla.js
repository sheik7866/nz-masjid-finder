/* NZ Masjid Finder — qibla direction + Ramadan calendar.
 *
 * Qibla: great-circle initial bearing from any point to the Ka'bah
 *        (21.4225° N, 39.8262° E). Pure maths, no API, works offline.
 * Ramadan: Hijri calendar arithmetic (tabular Islamic calendar) plus live
 *        day length from the sun, so iftar/suhoor are the real solar times for
 *        the user's own coordinates.
 *
 * Fasting times are displayed with the "local calculation — confirm with your
 * masjid" note; the app never presents an unverified time as authoritative.
 */
(() => {
  'use strict';

  const KAABA = { lat: 21.4225, lon: 39.8262 };

  const rad = (d) => (d * Math.PI) / 180;
  const deg = (r) => (r * 180) / Math.PI;

  /** Initial great-circle bearing to the Ka'bah, degrees clockwise from true north. */
  function qiblaBearing(lat, lon) {
    const phi1 = rad(lat);
    const phi2 = rad(KAABA.lat);
    const dLon = rad(KAABA.lon - lon);
    const y = Math.sin(dLon) * Math.cos(phi2);
    const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
    return ((deg(Math.atan2(y, x)) % 360) + 360) % 360;
  }

  /** Great-circle distance in km to the Ka'bah. */
  function distanceToKaaba(lat, lon) {
    const R = 6371;
    const dLat = rad(KAABA.lat - lat);
    const dLon = rad(KAABA.lon - lon);
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(rad(lat)) * Math.cos(rad(KAABA.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  const compassName = (bearing) => {
    const names = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    return names[Math.round(((bearing % 360) / 22.5)) % 16];
  };

  // ------------------------------------------------------------ Hijri
  // Tabular Islamic (civil) calendar, epoch 1 Muharram 1 AH = 16 July 622 CE (JD 1948440).
  const HIJRI_MONTHS = [
    'Muharram', 'Safar', "Rabi' al-Awwal", "Rabi' al-Thani",
    'Jumada al-Ula', 'Jumada al-Akhirah', 'Rajab', "Sha'ban",
    'Ramadan', 'Shawwal', "Dhul Qa'dah", 'Dhul Hijjah',
  ];

  const gregorianToJD = (y, m, d) => {
    if (m <= 2) { y -= 1; m += 12; }
    const A = Math.floor(y / 100);
    const B = 2 - A + Math.floor(A / 4);
    return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + d + B - 1524.5;
  };

  const jdToGregorian = (jd) => {
    const z = Math.floor(jd + 0.5);
    const f = jd + 0.5 - z;
    let a = z;
    if (z >= 2299161) {
      const alpha = Math.floor((z - 1867216.25) / 36524.25);
      a = z + 1 + alpha - Math.floor(alpha / 4);
    }
    const b = a + 1524;
    const c = Math.floor((b - 122.1) / 365.25);
    const d = Math.floor(365.25 * c);
    const e = Math.floor((b - d) / 30.6001);
    const day = b - d - Math.floor(30.6001 * e) + f;
    const month = e < 14 ? e - 1 : e - 13;
    const year = month > 2 ? c - 4716 : c - 4715;
    return { year, month, day: Math.floor(day) };
  };

  const HIJRI_EPOCH = 1948440; // 1 Muharram 1 AH

  function jdToHijri(jd) {
    const days = Math.floor(jd - HIJRI_EPOCH) + 1;
    const cycles = Math.floor((days - 1) / 10631);
    let rem = (days - 1) % 10631;
    let year = cycles * 30 + 1;
    // 30-year cycle: 11 leap years, pattern 2,5,7,10,13,16,18,21,24,26,29
    const leap = [2, 5, 7, 10, 13, 16, 18, 21, 24, 26, 29];
    const yearLen = (y) => (leap.includes(((y - 1) % 30) + 1) ? 355 : 354);
    while (rem >= yearLen(year)) { rem -= yearLen(year); year += 1; }
    let month = 1;
    const monthLen = (y, m) => {
      if (m === 12) return yearLen(y) - 325;
      return m % 2 === 1 ? 30 : 29;
    };
    while (rem >= monthLen(year, month)) { rem -= monthLen(year, month); month += 1; }
    return { year, month, day: rem + 1, monthName: HIJRI_MONTHS[month - 1] };
  }

  function hijriToJD(year, month, day) {
    const leap = [2, 5, 7, 10, 13, 16, 18, 21, 24, 26, 29];
    let days = (year - 1) * 354 + Math.floor((3 + 11 * year) / 30);
    for (let m = 1; m < month; m += 1) days += m % 2 === 1 ? 30 : 29;
    return HIJRI_EPOCH + days + day - 1;
  }

  const todayHijri = (date) => jdToHijri(gregorianToJD(date.getFullYear(), date.getMonth() + 1, date.getDate()));

  /** Ramadan 1 for the Hijri year containing `date`, as a JS Date. */
  function ramadanStart(date) {
    const h = todayHijri(date);
    const target = h.month >= 9 ? h.year : h.year; // month 9 of the current Hijri year
    const jd = hijriToJD(target, 9, 1);
    const g = jdToGregorian(jd);
    return new Date(g.year, g.month - 1, g.day);
  }

  /** The 30-day Ramadan calendar with Gregorian dates. */
  function ramadanCalendar(date, lat, lon, prayerApi) {
    const start = ramadanStart(date);
    const days = [];
    const hYear = todayHijri(date).year;
    for (let i = 0; i < 30; i += 1) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      let times = null;
      if (prayerApi && prayerApi.computeTimes) {
        const offset = prayerApi.tzOffset(lat, lon, d);
        const t = prayerApi.computeTimes(lat, lon, d, { fajr: 18, isha: 17 });
        times = {
          fajr: prayerApi.toClock(t.fajr, offset),
          maghrib: prayerApi.toClock(t.maghrib, offset),
        };
      }
      days.push({
        day: i + 1,
        date: d,
        iso: d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'),
        suhoorEnds: times ? times.fajr : null,
        iftar: times ? times.maghrib : null,
      });
    }
    return { hijriYear: hYear, start, end: days[days.length - 1].date, days };
  }

  /** Is today inside Ramadan? */
  function ramadanStatus(date) {
    const h = todayHijri(date);
    if (h.month === 9) return { inRamadan: true, day: h.day, hijri: h };
    return { inRamadan: false, day: null, hijri: h };
  }

  window.NZQibla = {
    KAABA,
    qiblaBearing,
    distanceToKaaba,
    compassName,
    gregorianToJD,
    jdToHijri,
    hijriToJD,
    todayHijri,
    HIJRI_MONTHS,
    ramadanStart,
    ramadanCalendar,
    ramadanStatus,
  };
})();
