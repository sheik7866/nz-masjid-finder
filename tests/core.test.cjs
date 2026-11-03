// Tests for prayer times, qibla, Ramadan calendar and the halal dataset.
// Run: "$ABACUSAI_BOT_NODE" tests/core.test.cjs
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const store = new Map();
const sandbox = {
  console, Math, Date, Intl, JSON, Promise, Array, Object, String, Number, isNaN,
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
  fetch: () => Promise.reject(new Error('offline in tests')),
};
sandbox.window = sandbox;
vm.createContext(sandbox);
for (const f of ['prayer.js', 'qibla.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public', f), 'utf8'), sandbox, { filename: f });
}
const P = sandbox.NZPrayer;
const Q = sandbox.NZQibla;

let pass = 0;
const pending = [];
const ok = (name, fn) => { pending.push({ name, fn }); };

const mins = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
const close = (a, b, tol) => Math.abs(mins(a) - mins(b)) <= tol;

// Reference values from the live AlAdhan API (method=3, school=0), fetched
// during development — see README "Prayer time accuracy".
const REF = [
  { name: 'Auckland, 3 Nov 2026', lat: -36.8485, lon: 174.7633, date: new Date(2026, 10, 3),
    times: { fajr: '04:37', sunrise: '06:14', dhuhr: '13:04', asr: '16:50', maghrib: '19:55', isha: '21:26' } },
  { name: 'Auckland, 21 Jun 2026 (winter)', lat: -36.8485, lon: 174.7633, date: new Date(2026, 5, 21),
    times: { fajr: '06:01', sunrise: '07:34', dhuhr: '12:23', asr: '14:54', maghrib: '17:12', isha: '18:40' } },
  { name: 'Christchurch, 3 Nov 2026', lat: -43.5321, lon: 172.6362, date: new Date(2026, 10, 3),
    times: { fajr: '04:17', sunrise: '06:09', dhuhr: '13:13', asr: '17:06', maghrib: '20:17', isha: '22:02' } },
];

REF.forEach((ref) => {
  ok('offline calculation matches AlAdhan within 3 min — ' + ref.name, () => {
    const t = P.computeTimes(ref.lat, ref.lon, ref.date, { fajr: 18, isha: 17 });
    const off = P.tzOffset(ref.lat, ref.lon, ref.date);
    Object.keys(ref.times).forEach((k) => {
      const got = P.toClock(t[k], off);
      assert.ok(close(got, ref.times[k], 3), k + ': got ' + got + ' expected ~' + ref.times[k]);
    });
  });
});

ok('NZ timezone offset is +13 in summer and +12 in winter', () => {
  assert.strictEqual(P.tzOffset(-36.85, 174.76, new Date(2026, 0, 15)), 13);
  assert.strictEqual(P.tzOffset(-36.85, 174.76, new Date(2026, 6, 15)), 12);
});

ok('toClock wraps past midnight correctly', () => {
  assert.strictEqual(P.toClock(23.5, 1), '00:30');
  assert.strictEqual(P.toClock(0.25, 0), '00:15');
});

ok('prayers are in the right order for a NZ summer day', () => {
  const t = P.computeTimes(-36.8485, 174.7633, new Date(2026, 10, 3), {});
  const off = P.tzOffset(-36.8485, 174.7633, new Date(2026, 10, 3));
  const c = (k) => mins(P.toClock(t[k], off));
  assert.ok(c('fajr') < c('sunrise'));
  assert.ok(c('sunrise') < c('dhuhr'));
  assert.ok(c('dhuhr') < c('asr'));
  assert.ok(c('asr') < c('maghrib'));
  assert.ok(c('maghrib') < c('isha'));
});

ok('next prayer picks the following prayer and counts down', () => {
  const times = { fajr: '04:37', sunrise: '06:14', dhuhr: '13:04', asr: '16:50', maghrib: '19:55', isha: '21:26' };
  const next = P.nextPrayer(times, new Date(2026, 10, 3, 12, 0));
  assert.strictEqual(next.key, 'dhuhr');
  assert.strictEqual(next.minutesUntil, 64);
});

ok('after Isha the next prayer is tomorrow\'s Fajr', () => {
  const times = { fajr: '04:37', sunrise: '06:14', dhuhr: '13:04', asr: '16:50', maghrib: '19:55', isha: '21:26' };
  const next = P.nextPrayer(times, new Date(2026, 10, 3, 23, 0));
  assert.strictEqual(next.key, 'fajr');
  assert.strictEqual(next.tomorrow, true);
  assert.ok(next.minutesUntil > 0 && next.minutesUntil < 24 * 60);
});

ok('countdown formatting', () => {
  assert.strictEqual(P.formatCountdown(64), '1h 4m');
  assert.strictEqual(P.formatCountdown(9), '9m');
});

ok('offline fallback is used when the API is unreachable', async () => {
  const day = await P.getDay(-36.8485, 174.7633, new Date(2026, 10, 3), { method: 3 });
  assert.strictEqual(day.source, 'Calculated offline');
  assert.ok(day.times.fajr && day.times.isha);
  assert.ok(day.error);
});

ok('cached day is returned without a network call', async () => {
  store.clear();
  const day1 = await P.getDay(-36.8485, 174.7633, new Date(2026, 10, 3), { method: 3 });
  assert.ok(!day1.cached, 'first call is not a cache hit');
  const day2 = await P.getDay(-36.8485, 174.7633, new Date(2026, 10, 3), { method: 3 });
  assert.strictEqual(day2.cached, true);
});

ok('only verified Jumu\'ah times are listed', () => {
  const list = P.verifiedJummah([
    { id: 'a', name: 'Verified Masjid', jummah_times: 'Khutbah 1:15pm', verified: true, verified_by: 'Ahmed' },
    { id: 'b', name: 'Unverified Masjid', jummah_times: '1pm', verified: false },
    { id: 'c', name: 'No Time Masjid', jummah_times: null, verified: true },
  ]);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].name, 'Verified Masjid');
});

// ------------------------------------------------------------------ qibla
ok('qibla bearing for Auckland is ~261° (west-north-west)', () => {
  const b = Q.qiblaBearing(-36.8485, 174.7633);
  assert.ok(Math.abs(b - 261.2) < 0.5, 'got ' + b);
});
ok('qibla bearing for Christchurch is ~256°', () => {
  const b = Q.qiblaBearing(-43.5321, 172.6362);
  assert.ok(Math.abs(b - 255.9) < 0.5, 'got ' + b);
});
ok('qibla bearing is always in 0–360', () => {
  [-46.4, -41.3, -36.8, -34.4].forEach((lat) => {
    [166.5, 172.6, 174.8, 178.5].forEach((lon) => {
      const b = Q.qiblaBearing(lat, lon);
      assert.ok(b >= 0 && b < 360);
    });
  });
});
ok('distance to the Ka\'bah from Auckland is ~15,400 km', () => {
  const d = Q.distanceToKaaba(-36.8485, 174.7633);
  assert.ok(Math.abs(d - 15365) < 200, 'got ' + d);
});
ok('compass names', () => {
  assert.strictEqual(Q.compassName(0), 'N');
  assert.strictEqual(Q.compassName(90), 'E');
  assert.strictEqual(Q.compassName(261), 'W');
});

// ------------------------------------------------------------------ hijri
ok('Hijri date for 3 Nov 2026 is 23 Jumada al-Ula 1448 (AlAdhan agreement)', () => {
  const h = Q.todayHijri(new Date(2026, 10, 3));
  assert.strictEqual(h.year, 1448);
  assert.strictEqual(h.month, 5);
  assert.ok(Math.abs(h.day - 23) <= 2, 'day ' + h.day);
});
ok('Hijri round-trip through JD', () => {
  [[1448, 9, 1], [1447, 12, 10], [1449, 1, 1]].forEach(([y, m, d]) => {
    const jd = Q.hijriToJD(y, m, d);
    const back = Q.jdToHijri(jd);
    assert.deepStrictEqual([back.year, back.month, back.day], [y, m, d]);
  });
});
ok('Ramadan start is in the future for Nov 2026', () => {
  const start = Q.ramadanStart(new Date(2026, 10, 3));
  assert.ok(start > new Date(2026, 10, 3));
});
ok('Ramadan calendar has 30 days with iftar after suhoor', () => {
  const cal = Q.ramadanCalendar(new Date(2026, 10, 3), -36.8485, 174.7633, P);
  assert.strictEqual(cal.days.length, 30);
  cal.days.forEach((d) => {
    assert.ok(d.iftar && d.suhoorEnds);
    assert.ok(mins(d.iftar) > mins(d.suhoorEnds), 'day ' + d.day);
  });
});
ok('Ramadan status reports not-in-Ramadan for Nov 2026', () => {
  const s = Q.ramadanStatus(new Date(2026, 10, 3));
  assert.strictEqual(s.inRamadan, false);
});

// ------------------------------------------------------------------ data
ok('masjid dataset: 100+ NZ records with coordinates', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/masjids.json'), 'utf8'));
  assert.ok(doc.masjids.length >= 100, 'count ' + doc.masjids.length);
  doc.masjids.forEach((m) => {
    assert.ok(m.name && typeof m.lat === 'number' && typeof m.lon === 'number');
    assert.ok(m.lat < -34 && m.lat > -48, 'lat in NZ: ' + m.name);
    assert.ok(m.lon > 166 && m.lon < 179, 'lon in NZ: ' + m.name);
  });
});

ok('halal dataset: records with coordinates and an honest verification flag', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/halal.json'), 'utf8'));
  assert.ok(doc.businesses.length >= 100, 'count ' + doc.businesses.length);
  doc.businesses.forEach((b) => {
    assert.ok(b.name && typeof b.lat === 'number' && typeof b.lon === 'number');
    assert.strictEqual(b.verified, false, 'OSM halal tag is not a certificate');
  });
});

ok('no invented Jumu\'ah or prayer times in the shipped masjid data', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/masjids.json'), 'utf8'));
  const withTimes = doc.masjids.filter((m) => m.jummah_times);
  assert.strictEqual(withTimes.length, 0, 'dataset must not ship unverified Jumu\'ah times');
});


ok('every masjid record carries its own OSM source URL', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/masjids.json'), 'utf8'));
  doc.masjids.forEach((m) => {
    assert.ok(Array.isArray(m.sources) && m.sources.length, m.name + ' has no source');
    assert.strictEqual(m.sources[0].type, 'OpenStreetMap');
    assert.ok(/^https:\/\/www\.openstreetmap\.org\/(node|way|relation)\/\d+$/.test(m.sources[0].url), m.name + ' bad source url');
    assert.strictEqual(m.sources[0].url.endsWith(m.id), true, m.name + ' source must match its OSM id');
  });
});

ok('dataset meta declares the ODbL attribution and provenance', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/masjids.json'), 'utf8'));
  assert.strictEqual(doc.meta.attribution.text, '© OpenStreetMap contributors');
  assert.ok(/ODbL/.test(doc.meta.attribution.licence));
  assert.ok(doc.meta.attribution.url.includes('openstreetmap.org/copyright'));
  assert.ok(doc.meta.provenance && doc.meta.provenance.osm_query.includes('Overpass') === false);
  assert.ok(doc.meta.provenance.osm_query.includes('ISO3166-1'));
  assert.ok(doc.meta.provenance.human_verified.includes('verification flow'));
});

ok('halal dataset declares attribution and per-tag provenance', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/halal.json'), 'utf8'));
  assert.strictEqual(doc.meta.attribution.text, '© OpenStreetMap contributors');
  assert.ok(doc.meta.provenance.osm_query.includes('diet:halal'));
  assert.ok(doc.meta.provenance.tag_counts.yes > 0);
  doc.businesses.forEach((b) => {
    assert.ok(b.sources[0].url.startsWith('https://www.openstreetmap.org/'), b.name);
  });
});

ok('regions are assigned to the right island/region for known towns', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/masjids.json'), 'utf8'));
  const find = (needle) => doc.masjids.find((m) => m.name.includes(needle));
  assert.strictEqual(find('Gisborne').region, 'Gisborne');
  assert.strictEqual(find('Al Noor').region, 'Canterbury');
  assert.strictEqual(find('Invercargill').region, 'Southland');
  assert.strictEqual(find('Wellsford').region, 'Auckland');
});

ok('the app shows OSM and AlAdhan attribution in the UI', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.ok(html.includes('OpenStreetMap</a> contributors (ODbL)'));
  assert.ok(html.includes('aladhan.com'));
  assert.ok(html.includes('openstreetmap.org/copyright'));
});

(async () => {
  for (const t of pending) {
    await t.fn();
    pass += 1;
    console.log('  ✓', t.name);
  }
  console.log(`\n${pass} checks passed`);
})().catch((e) => { console.error('\n✗ FAILED:', e.message); process.exit(1); });
