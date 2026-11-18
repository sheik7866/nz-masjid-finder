// Tests for the Jumu'ah web-check text extraction (shared by the Edge Function
// and the tests themselves). Run: node tests/jummah.test.cjs
const assert = require('assert');

const pending = [];
const check = (name, fn) => pending.push({ name, fn });

(async () => {
  const X = await import('../supabase/functions/verify-jummah/extract.mjs');

  check('finds both khutbah and salah times on a Jumu\'ah line', () => {
    const r = X.extractJummah("Jumu'ah: Khutbah 1:15pm, Salah 1:45pm");
    assert.deepStrictEqual(r.times, ['1:15pm', '1:45pm']);
  });

  check('reads a time from the line after the keyword', () => {
    const r = X.extractJummah('Friday Prayer\nFirst jamaat 1:30 pm');
    assert.deepStrictEqual(r.times, ['1:30pm']);
  });

  check('normalises 24-hour times near a Jumu\'ah word', () => {
    const r = X.extractJummah('Friday prayer times: 13:30 and 14:45');
    assert.deepStrictEqual(r.times, ['1:30pm', '2:45pm']);
  });

  check('normalises dotted times and bare hours', () => {
    const r = X.extractJummah('Jummah 1.05pm');
    assert.deepStrictEqual(r.times, ['1:05pm']);
    assert.deepStrictEqual(X.extractJummah('Jummah 1 pm').times, ['1:00pm']);
  });

  check('ignores times further than three lines from any Jumu\'ah word', () => {
    const text = 'Jumu\'ah 1:15pm\n\n\n\n\n\n\n\nShop open 5:00pm';
    assert.deepStrictEqual(X.extractJummah(text).times, ['1:15pm']);
  });

  check('ignores dates and opening hours with no Jumu\'ah context', () => {
    assert.deepStrictEqual(X.extractJummah('Office hours 9:00am to 5:00pm, 12/05/2026').times, []);
  });

  check('does not read 12-hour times out of phone-like digit runs', () => {
    assert.deepStrictEqual(X.extractJummah('Jumu\'ah contact 09 123 4567').times, []);
  });

  check('deduplicates a time repeated across lines', () => {
    const r = X.extractJummah('Jumu\'ah 1:15pm\nFriday prayer 1:15pm');
    assert.deepStrictEqual(r.times, ['1:15pm']);
  });

  check('strips scripts and styles before extraction', () => {
    const html = '<html><head><script>var t="Jumu\'ah 9:99pm";</script><style>.x{}</style></head>' +
      '<body><h1>Masjid</h1><p>Jumu\'ah khutbah 1:20pm</p></body></html>';
    const text = X.stripHtml(html);
    assert.ok(!text.includes('var t='));
    assert.ok(!text.includes('.x{}'));
    assert.deepStrictEqual(X.extractJummah(text).times, ['1:20pm']);
  });

  check('decodes entities and keeps readable lines', () => {
    const text = X.stripHtml('<p>Jumu&apos;ah&nbsp;Salah 1:45&nbsp;pm</p>');
    assert.ok(text.includes("Jumu'ah Salah 1:45 pm"));
  });

  check('reads the page title, falling back to h1', () => {
    assert.strictEqual(X.pageTitle('<title> Masjid Al-Huda &amp; Centre </title>'), 'Masjid Al-Huda & Centre');
    assert.strictEqual(X.pageTitle('<h1>Al Noor</h1>'), 'Al Noor');
  });

  check('finds same-origin prayer pages and skips external, pdf and anchors', () => {
    const html = `
      <a href="/prayer-times">Prayer times</a>
      <a href="https://facebook.com/masjid">Facebook</a>
      <a href="/timetable.pdf">Timetable</a>
      <a href="/prayer-times#top">Prayer times again</a>
      <a href="/contact">Contact us</a>
      <a href="/gallery">Gallery</a>
      <a href="/">Home</a>`;
    const links = X.sameOriginLinks(html, 'https://masjid.example.nz/', { limit: 6 });
    assert.deepStrictEqual(links, ['https://masjid.example.nz/prayer-times', 'https://masjid.example.nz/contact']);
  });

  check('respects the link limit and never returns the homepage', () => {
    const html = ['/a', '/b', '/c', '/d'].map((p) => `<a href="${p}">prayer ${p}</a>`).join('');
    assert.strictEqual(X.sameOriginLinks(html, 'https://m.example.nz/', { limit: 2 }).length, 2);
  });

  check('builds a search query with name and place', () => {
    const q = X.searchQuery({ name: 'Masjid Al-Huda', city: 'Hamilton' });
    assert.ok(q.includes('Masjid Al-Huda'));
    assert.ok(q.includes('Hamilton'));
    assert.ok(/jumu/i.test(q));
  });

  check('labels a source by host without www', () => {
    assert.strictEqual(X.hostOf('https://www.ait.org.nz/prayer'), 'ait.org.nz');
  });

  check('matches a shortened directory name', () => {
    const rows = [{ name: 'Al Hijaz', winter: '12.50 pm', summer: '1.50 pm' }];
    assert.strictEqual(X.matchKmdEntry(rows, 'Al Hijaz Masjid').summer, '1.50 pm');
  });

  check('reads winter/summer rows from the directory article', () => {
    const text = [
      'Al Hijaz Masjid', 'Address/Venue:', '79 Onewa Road, Birkenhead', 'Time:',
      'Winter: 12.50 pm', 'Summer: 1.50 pm', 'Sisters: Yes',
      'Ponsonby Masjid', 'Address/Venue:', '17 Vermont Street', 'Time:',
      'Winter: 12.40 pm', 'Summer: 1.40 pm',
    ].join('\n');
    assert.deepStrictEqual(X.kmdEntries(text), [
      { name: 'Al Hijaz Masjid', address: '79 Onewa Road, Birkenhead', region: '', winter: '12.50 pm', summer: '1.50 pm' },
      { name: 'Ponsonby Masjid', address: '17 Vermont Street', region: '', winter: '12.40 pm', summer: '1.40 pm' },
    ]);
  });

  check('tags directory rows with their section and reads each row once', () => {
    const text = [
      'AUCKLAND', 'Masjid One', 'Address/Venue:', '1 Alpha Road', 'Time:',
      'Winter: 1.00 pm', 'Summer: 2.00 pm', 'Sisters: Yes',
      'Time: 2nd', 'Winter: 1.25 pm', 'Summer: 2.05 pm',
      'CHRISTCHURCH', 'Masjid Two', 'Address/Venue:', '2 Beta Road', 'Time:',
      'Winter: 12.30 pm', 'Summer: 1.30 pm',
    ].join('\n');
    assert.deepStrictEqual(X.kmdEntries(text).map((e) => [e.name, e.address, e.region, e.summer]), [
      ['Masjid One', '1 Alpha Road', 'Auckland', '2.00 pm'],
      ['Masjid Two', '2 Beta Road', 'Canterbury', '1.30 pm'],
    ]);
  });

  check('skips directory rows whose masjid name cannot be read', () => {
    const rows = X.kmdEntries('https://tinyurl.com/x\nTime:\nWinter: 12.30 pm\nSummer: 1.30 pm');
    assert.deepStrictEqual(rows, []);
  });

  check('matches a directory row by name and refuses near misses', () => {
    const rows = [
      { name: 'Al Hijaz Masjid', winter: '12.50 pm', summer: '1.50 pm' },
      { name: 'Masjid Al Mustafa (SAMA)', winter: '12.40 pm', summer: '1.40 pm' },
    ];
    assert.strictEqual(X.matchKmdEntry(rows, 'Al Hijaz Masjid').summer, '1.50 pm');
    assert.strictEqual(X.matchKmdEntry(rows, 'Masjid E Umar'), null);
    assert.strictEqual(X.matchKmdEntry(rows, 'Al Mustafa Charity Centre'), null);
  });

  check('matches a masjid by its alias and refuses a same-city stranger', () => {
    const rows = [
      { name: 'Al Hijaz Masjid', address: '236 Richardson Rd Mt Roskill', region: 'Auckland', winter: '12.50 pm', summer: '1.50 pm' },
      { name: 'Ponsonby Masjid', address: '17 Vermont St, Ponsonby', region: 'Auckland', winter: '12.40 pm', summer: '1.40 pm' },
    ];
    const masjid = { name: 'Al-Masjid Al-Jamie', address: '17 Vermont Street, Ponsonby', region: 'Auckland' };
    const hit = X.matchKmdEntry(rows, { ...masjid, alt_names: ['Ponsonby Masjid'] });
    assert.strictEqual(hit && hit.summer, '1.40 pm');
    assert.strictEqual(X.matchKmdEntry(rows, masjid), null, 'without the alias the near name is refused');
  });

  check('refuses another region and a short name contained in a longer venue', () => {
    const rows = [
      { name: 'AUT Muslim Prayer Room', address: 'The Chapel, Level 6', region: 'Auckland' },
      { name: 'Massey University Prayer Room', address: '8 Hibiscus Coast Highway, Silverdale', region: 'Auckland' },
      { name: 'Masjid E Bilal', address: '7 Waikaukau Pl, Glen Eden', region: 'Auckland' },
    ];
    assert.strictEqual(X.matchKmdEntry(rows, { name: 'Muslim Prayer Room', region: 'Auckland' }), null);
    assert.strictEqual(X.matchKmdEntry(rows, { name: 'Massey Islamic Centre', region: 'Manawatu-Whanganui' }), null);
    assert.strictEqual(X.matchKmdEntry(rows, { name: 'Masjid e Bilal - Wanganui Islamic Centre', region: 'Manawatu-Whanganui' }), null);
    assert.strictEqual(X.matchKmdEntry(rows, { name: 'Masjid-E-Bilal', region: 'Auckland' }).name, 'Masjid E Bilal');
  });

  check('accepts a longer directory name only when the address agrees', () => {
    const rows = [
      { name: 'Al Noor Mosque (Muslim Association of Canterbury)', address: '101, Deans Ave, Riccarton, Christchurch', region: 'Canterbury', winter: '12.20 pm', summer: '1.30 pm' },
      { name: 'Al Noor Educational Trust', address: 'Everglade Girl Guide hall, 64 Everglade Dr, Goodwood Heights', region: 'Auckland', winter: '12.30 pm', summer: '1.45 pm' },
    ];
    const hit = X.matchKmdEntry(rows, { name: 'Al Noor Mosque', address: '101 Deans Avenue, Riccarton, Christchurch', region: 'Canterbury' });
    assert.strictEqual(hit && hit.summer, '1.30 pm');
    assert.strictEqual(X.matchKmdEntry(rows, { name: 'Al Noor Mosque', region: 'Canterbury' }), null, '0.5 name score without the address is refused');
  });

  check('refuses two equally good rows it cannot tell apart', () => {
    const rows = [
      { name: 'Al Noor Masjid', address: '', region: '', winter: '1.00 pm', summer: '2.00 pm' },
      { name: 'Al Noor Mosque', address: '', region: '', winter: '1.10 pm', summer: '2.10 pm' },
    ];
    assert.strictEqual(X.matchKmdEntry(rows, { name: 'Al Noor' }), null);
  });

  check('refuses a Jumu\'ah time that cannot be one', () => {
    assert.deepStrictEqual(X.extractJummah("Jumu'ah: 1:45am").times, []);
    assert.deepStrictEqual(X.extractJummah("Jumu'ah: 9:00pm").times, []);
    assert.deepStrictEqual(X.extractJummah("Jumu'ah: 2:10pm").times, ['2:10pm']);
  });

  check('keeps the plausible time beside a rejected one', () => {
    const r = X.extractJummah("Jumu'ah: 1:45am\nJumu'ah: 1:45pm");
    assert.deepStrictEqual(r.times, ['1:45pm']);
  });

  let pass = 0;
  for (const t of pending) {
    await t.fn();
    pass += 1;
    console.log('  ✓', t.name);
  }
  console.log(`\n${pass} checks passed`);
})().catch((e) => { console.error('\n✗ FAILED:', e.message); process.exit(1); });
