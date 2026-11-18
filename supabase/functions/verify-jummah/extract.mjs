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
    out.push(fmt12(parseInt(m[1], 10), m[2], parseInt(m[1], 10) >= 12 ? 'pm' : 'am'));
  }

  return out.filter((t, i) => out.indexOf(t) === i);
}

/**
 * Jumu'ah times from a page's readable text.
 * Only lines within three lines of a Jumu'ah/Friday/khutbah word count, so an
 * unrelated "5:00pm" elsewhere on the page cannot become a prayer time.
 * Returns { times: ["1:15pm", ...], snippets: ["Jumu'ah: Khutbah 1:15pm ..."] }.
 */
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
      const found = findTimes(line);
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
export function searchQuery(info) {
  const name = String((info && info.name) || '').trim();
  const place = String((info && (info.city || info.region)) || 'New Zealand').trim();
  return (name + ' ' + place + " jumu'ah prayer time OR Friday prayer timetable").replace(/\s+/g, ' ').trim();
}

/** Human label for a source URL (host without www). */
export function hostOf(url) {
  try { return new URL(url).host.replace(/^www\./, ''); } catch (e) { return String(url || ''); }
}
