// Pure text helpers for the Jumu'ah web check.
//
// Kept dependency-free and in plain ESM so the same code runs inside the
// Supabase Edge Function (Deno) and under Node in tests — no bundler, no
// duplicated regexes. Nothing here performs I/O.

const JUMUAH_WORDS = /(jumu'?ah|jummah|juma'?ah|jumma|jum'?ah|khutbah|khutba|jama'?ah|jamaat|jamaah|salah|salat|namaz|friday\s+(?:prayer|prayers|jama'?ah|jamaat))/i;

// 1:15pm / 1.15 pm / 1 pm
const TIME12 = /\b(1[0-2]|0?[1-9])(?:[:.]([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)\b/gi;
// 13:30 — only accepted when a Jumu'ah word is nearby (see extractJummah)
const TIME24 = /\b([01]?\d|2[0-3]):([0-5]\d)\b/g;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'" };

function decodeEntities(s) {
  return String(s).replace(/&(#?[a-z0-9]+);/gi, (m, code) => {
    const key = code.toLowerCase();
    return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key] : m;
  });
}

/** HTML -> readable lines (scripts, styles and markup removed). */
export function stripHtml(html) {
  return decodeEntities(String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|td|th|h[1-6]|section|article|header|footer|table|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/** <title> of a page, falling back to the first <h1>. */
export function pageTitle(html) {
  const src = String(html || '');
  const t = src.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (t) {
    const title = stripHtml(t[1]).replace(/\n/g, ' ').trim();
    if (title) return title.slice(0, 160);
  }
  const h = src.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return h ? stripHtml(h[1]).replace(/\n/g, ' ').trim().slice(0, 160) : '';
}

/**
 * Same-origin links whose href or wording suggests prayer times, so a masjid
 * homepage leads to its timetable page. Returns absolute URLs, best first.
 */
export function sameOriginLinks(html, baseUrl, opts) {
  const o = opts || {};
  const limit = o.limit || 6;
  const keyword = o.keyword || /(jumu|jumma|juma|jum'|friday|prayer|salah|salat|namaz|khutbah|khutba|timetable|time-table|schedule|contact|about|programme|program)/i;
  const base = new URL(baseUrl);
  const seen = new Set();
  const scored = [];
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const href = m[1].trim();
    const text = stripHtml(m[2]).replace(/\n/g, ' ').trim();
    if (!href || /^(#|mailto:|tel:|javascript:)/i.test(href)) continue;
    let abs;
    try { abs = new URL(href, base); } catch (e) { continue; }
    if (abs.origin !== base.origin) continue;
    if (!/^https?:$/.test(abs.protocol)) continue;
    if (/\.(pdf|jpg|jpeg|png|gif|webp|svg|zip|mp4|mp3|docx?|xlsx?)$/i.test(abs.pathname)) continue;
    abs.hash = '';
    const key = abs.href;
    if (key === base.href || seen.has(key)) continue;
    const haystack = key + ' ' + text;
    if (!keyword.test(haystack)) continue;
    seen.add(key);
    scored.push({ url: key, text, score: (keyword.test(abs.pathname) ? 2 : 0) + (keyword.test(text) ? 1 : 0) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.url);
}

function fmt12(hour, minute, ampm) {
  const h = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return h + ':' + String(minute).padStart(2, '0') + ampm;
}

/** Every time in a piece of text, normalised to "1:15pm" form. */
export function findTimes(text) {
  const out = [];
  let rest = String(text || '');

  // 12-hour times first, then blank them out: otherwise TIME24 would match the
  // "1:30" inside "1:30 pm" and report a bogus "1:30am" as well.
  TIME12.lastIndex = 0;
  rest = rest.replace(new RegExp(TIME12.source, 'gi'), (whole, h, mins, ampm) => {
    const suffix = /^a/i.test(ampm) ? 'am' : 'pm';
    out.push(fmt12(parseInt(h, 10) % 12, mins || '00', suffix));
    return ' ';
  });

  let m;
  TIME24.lastIndex = 0;
  while ((m = TIME24.exec(rest))) {
    // reject dates like 2026/01/15 and ranges glued to hyphens
    const before = rest[m.index - 1];
    const after = rest[m.index + m[0].length];
    if (before === '-' || before === '/' || after === '/' || after === '-') continue;
    // A bare "1:45" is a 24-hour timetable, and no Jumu'ah happens at 1:45 in
    // the morning. Hours 1–6 can only be afternoon, so they are read as pm;
    // 7–11 stay am, which keeps an 11:30 sitting while 7:00 is still refused by
    // the plausibility window rather than saved as an evening time.
    const hour = parseInt(m[1], 10);
    out.push(fmt12(hour, m[2], hour >= 12 || hour <= 6 ? 'pm' : 'am'));
  }

  return out.filter((t, i) => out.indexOf(t) === i);
}

/**
 * Jumu'ah times from a page's readable text.
 * Only lines within three lines of a Jumu'ah/Friday/khutbah word count, so an
 * unrelated "5:00pm" elsewhere on the page cannot become a prayer time.
 * Returns { times: ["1:15pm", ...], snippets: ["Jumu'ah: Khutbah 1:15pm ..."] }.
 */
// A Jumu'ah is never at 1:45am: a timetable that puts one there is a Fajr row
// read as if it were Jumu'ah, and saving it is worse than saving nothing.
const JUMUAH_FROM = 11 * 60;
const JUMUAH_TO = 18 * 60;

export function plausibleJummah(t) {
  const m = String(t || '').match(/^(\d{1,2}):(\d{2})(am|pm)$/i);
  if (!m) return false;
  let hour = parseInt(m[1], 10) % 12;
  if (/pm/i.test(m[3])) hour += 12;
  const minutes = hour * 60 + parseInt(m[2], 10);
  return minutes >= JUMUAH_FROM && minutes <= JUMUAH_TO;
}

export function extractJummah(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const times = [];
  const snippets = [];
  let sawKeyword = false;      // a Jumu'ah word in the last two lines
  let prevKeyword = '';
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const isKeyword = JUMUAH_WORDS.test(line);
    // A bare time list ("1:15pm  1:45pm") only counts right after a Jumu'ah
    // word — that is how most timetable tables are laid out.
    const isTimeOnly = !/[a-z]/i.test(line) && findTimes(line).length > 0;
    const active = isKeyword || (sawKeyword && isTimeOnly);
    if (active) {
      const found = findTimes(line).filter(plausibleJummah);
      if (found.length) {
        found.forEach((t) => { if (!times.includes(t)) times.push(t); });
        if (snippets.length < 5) {
          const snippet = (isTimeOnly && prevKeyword ? prevKeyword + ' — ' : '') + line;
          if (!snippets.includes(snippet)) snippets.push(snippet.slice(0, 220));
        }
      }
    }
    if (isKeyword) { sawKeyword = true; prevKeyword = line.slice(0, 120); }
    else if (i > 0 && JUMUAH_WORDS.test(lines[i - 1])) { sawKeyword = true; }
    else { sawKeyword = false; prevKeyword = ''; }
  }
  return { times, snippets };
}

/** Search query used when a search API key is configured. */
// ---------------------------------------------------------------- directories
// Kiwi Muslim Directory publishes a "Jumah Prayer Times" article that lists, per
// masjid:
//
//   Al Hijaz Masjid
//   Address/Venue:
//   79 Onewa Road, Birkenhead
//   Time:
//   Winter: 12.50 pm
//   Summer: 1.50 pm
//   Sisters: Yes
//
// That page is server-rendered, so unlike the directory's search and listing
// screens it can be read without a browser. These helpers turn it into rows.
const KMD_TIME = '(\\d{1,2}[:.]\\d{2}\\s*[ap]\\.?m\\.?)';
const KMD_WINTER = new RegExp('^Winter:?\\s*' + KMD_TIME + '$', 'i');
const KMD_SUMMER = new RegExp('^Summer:?\\s*' + KMD_TIME + '$', 'i');

// The article groups its rows under place headings. Carrying the heading into
// each entry is what lets a name match be refused when the directory row is in
// another city — "Massey Islamic Centre" (Manawatu) is not "Massey University
// Prayer Room" (Auckland), however alike the names look.
const KMD_SECTIONS = new Map([
  ['north', 'Auckland'],
  ['auckland', 'Auckland'],
  ['auckland cbd', 'Auckland'],
  ['central auckland', 'Auckland'],
  ['east auckland', 'Auckland'],
  ['west auckland', 'Auckland'],
  ['south auckland', 'Auckland'],
  ['christchurch', 'Canterbury'],
  ['hamilton', 'Waikato'],
  ['wellington', 'Wellington'],
]);

const KMD_FIELD_LABEL = /^(sisters?|brothers?|time|winter|summer|address\/venue|venue|address|notes?|entrance)\b/i;

/** Winter/summer Jumu'ah rows from the directory article, with their section. */
export function kmdEntries(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim());
  const out = [];
  let region = '';
  let lastAnchor = -1;
  for (let i = 0; i < lines.length - 1; i += 1) {
    const section = KMD_SECTIONS.get(lines[i].toLowerCase());
    if (section) { region = section; continue; }
    const w = lines[i].match(KMD_WINTER);
    if (!w) continue;
    const s = lines[i + 1].match(KMD_SUMMER);
    if (!s) continue;
    // A real row is: name, "Address/Venue:", address, "Time:", winter, summer.
    // Without that label this is a second time block or a footer fragment, and
    // walking back would invent a masjid name for it.
    let anchor = -1;
    for (let k = i - 1; k >= Math.max(0, i - 5); k -= 1) {
      if (/^Address\/Venue:/i.test(lines[k])) { anchor = k; break; }
    }
    if (anchor < 0 || anchor === lastAnchor) continue;
    let name = '';
    for (let k = anchor - 1; k >= Math.max(0, anchor - 6); k -= 1) {
      const line = lines[k];
      if (!line || KMD_FIELD_LABEL.test(line) || /https?:\/\//i.test(line)) continue;
      name = line;
      break;
    }
    if (!name) continue;
    let address = '';
    for (let k = anchor + 1; k < i; k += 1) {
      const line = lines[k];
      if (!line || KMD_FIELD_LABEL.test(line)) continue;
      address = line;
      break;
    }
    lastAnchor = anchor;
    out.push({ name, address, region, winter: w[1], summer: s[1] });
  }
  return out;
}

const NAME_STOP_WORDS = new Set([
  'masjid', 'mosque', 'islamic', 'centre', 'center', 'trust', 'inc', 'the', 'of',
  'and', 'prayer', 'room', 'association', 'community', 'society', 'musalla',
  'musallah', 'foundation', 'muslim', 'muslims', 'nz', 'new', 'zealand',
  'al', 'el', 'e',
]);

/** Distinct name tokens, lower-cased and stripped of generic words. */
function nameTokens(s) {
  const tokens = String(s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ')
    .filter((t) => t && !NAME_STOP_WORDS.has(t));
  return new Set(tokens);
}

const ADDRESS_STOP_WORDS = new Set([
  'road', 'rd', 'street', 'st', 'avenue', 'ave', 'drive', 'dr', 'place', 'pl',
  'terrace', 'tce', 'highway', 'hwy', 'lane', 'crescent', 'cres', 'level',
  'unit', 'building', 'bldg', 'floor', 'entrance', 'opposite', 'next', 'mall',
  'park', 'hall', 'central', 'po', 'box',
]);

function addressTokens(value) {
  const tokens = String(value || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ')
    .filter((t) => t && !/^\d+$/.test(t) && t.length >= 3 && !ADDRESS_STOP_WORDS.has(t));
  return new Set(tokens);
}

function addressesAgree(entryAddress, masjidAddress) {
  const a = addressTokens(entryAddress);
  const b = addressTokens(masjidAddress);
  if (!a.size || !b.size) return false;
  for (const token of a) if (b.has(token)) return true;
  return false;
}

/** The masjid's own name, its aliases, and any alias written in brackets. */
function queryVariants(info) {
  const name = typeof info === 'string' ? info : String((info && info.name) || '');
  const alts = info && Array.isArray(info.alt_names) ? info.alt_names : [];
  const parts = [name].concat(alts.map((a) => String(a || ''))).filter(Boolean);
  const variants = [];
  for (const part of parts) {
    variants.push(part);
    const bracketed = part.match(/\(([^)]+)\)/);
    if (bracketed) variants.push(bracketed[1]);
  }
  return Array.from(new Set(variants.map((p) => p.trim()).filter(Boolean)));
}

/**
 * Overlap between a queried name and a directory name.
 *
 * Distinct tokens only, so a repeated word cannot inflate the score. An entry
 * name wholly contained in the masjid's name (or alias) is a strong match —
 * "Papakura Musallah" inside "Falahe Darain (Papakura Musallah Masjid)" — but
 * the reverse is not: "Muslim Prayer Room" is contained in "AUT Muslim Prayer
 * Room" and is still a different venue.
 */
function nameScore(want, have) {
  let hit = 0;
  for (const token of want) if (have.has(token)) hit += 1;
  if (!hit) return 0;
  if (hit === want.size && hit === have.size) return 1;
  if (hit === have.size) return 1;
  return hit / (want.size + have.size - hit);
}

function regionsConflict(entryRegion, masjidRegion) {
  const a = String(entryRegion || '').trim().toLowerCase();
  const b = String(masjidRegion || '').trim().toLowerCase();
  if (!a || !b || a === 'new zealand' || b === 'new zealand') return false;
  return a !== b;
}

/**
 * Best directory row for a masjid, or null.
 *
 * A masjid may be given as a name string or as {name, alt_names, city, suburb,
 * address, region}. Matching is deliberately conservative: a row in another
 * region is refused outright, a weak name needs the directory address to agree,
 * and two equally good rows with nothing to separate them are refused. A wrong
 * Jumu'ah time is worse than no time.
 */
export function matchKmdEntry(entries, masjid) {
  const info = typeof masjid === 'string' ? { name: masjid } : (masjid || {});
  const wantSets = queryVariants(info).map(nameTokens).filter((set) => set.size);
  if (!wantSets.length || !Array.isArray(entries)) return null;
  const locationText = [info.address, info.suburb, info.city].filter(Boolean).join(' ');
  const candidates = [];
  for (const entry of entries) {
    if (!entry || !entry.name) continue;
    if (regionsConflict(entry.region, info.region)) continue;
    const have = nameTokens(entry.name);
    if (!have.size) continue;
    let score = 0;
    for (const want of wantSets) score = Math.max(score, nameScore(want, have));
    if (!score) continue;
    candidates.push({ entry, score, addressMatch: addressesAgree(entry.address, locationText) });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => (b.score - a.score) || (Number(b.addressMatch) - Number(a.addressMatch)));
  const top = candidates[0];
  const second = candidates[1];
  const accepted = top.score >= 0.8 || (top.score >= 0.5 && top.addressMatch);
  if (!accepted) return null;
  if (second && second.score === top.score && second.addressMatch === top.addressMatch
      && second.entry.name !== top.entry.name) return null;
  return { ...top.entry, score: top.score, address_match: top.addressMatch };
}

export function searchQuery(info) {
  const name = String((info && info.name) || '').trim();
  const place = String((info && (info.city || info.region)) || 'New Zealand').trim();
  return (name + ' ' + place + " jumu'ah prayer time OR Friday prayer timetable").replace(/\s+/g, ' ').trim();
}

/** Human label for a source URL (host without www). */
export function hostOf(url) {
  try { return new URL(url).host.replace(/^www\./, ''); } catch (e) { return String(url || ''); }
}
