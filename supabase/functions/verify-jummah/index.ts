// Supabase Edge Function: verify-jummah
//
// Admin-only. Given a masjid name, city and (if known) its website, this fetches
// the masjid's own pages — and, when TAVILY_API_KEY is set, the wider web — and
// returns every Jumu'ah time it can find, with the page it came from. It never
// writes to the database: an admin looks at the sources and presses "Use", which
// saves through the normal is_admin() UPDATE policy.
//
// Deploy:   supabase functions deploy verify-jummah
// Secrets:  TAVILY_API_KEY (optional), ALLOWED_ORIGIN (optional, defaults to *)
//
// Without TAVILY_API_KEY it still works for the ~40 listings that already carry
// a website: the site is fetched server-side, so there is no CORS problem and no
// third-party account involved.
//
// Security: the caller's JWT is checked against /auth/v1/user and must carry
// app_metadata.role = "admin". The browser never sees a search key, and the
// function never returns raw page content — only extracted times and snippets.
// The project's API key is taken from the environment: publishable key first,
// legacy anon key second, so both key generations work (see apiKey()).

import {
  extractJummah, hostOf, kmdEntries, matchKmdEntry, pageTitle, sameOriginLinks,
  searchQuery, stripHtml,
} from './extract.mjs';

const CORS = {
  'Access-Control-Allow-Origin': Deno.env.get('ALLOWED_ORIGIN') ?? '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  Vary: 'Origin',
};

// The directory's "Jumah Prayer Times" article is a plain server-rendered page
// (its search and listing screens are not), and lists winter/summer pairs for
// many masjids — worth one extra request when the masjid's own pages come up dry.
const KMD_URL = 'https://muslimdirectory.co.nz/blog/jumah-prayer-times';

const MAX_PAGES = 8;
// Masjid sites are often heavy single-page builds: the Al Hijaz homepage is
// 1.2 MB and keeps its Jumu'ah time past the 1 MB mark, so a small cap silently
// lost the very content this function exists to find.
const MAX_BYTES = 2_000_000;
const FETCH_TIMEOUT_MS = 9000;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/**
 * The project's low-privilege API key, for calling Supabase's own endpoints.
 *
 * Projects on the new key system inject SUPABASE_PUBLISHABLE_KEYS, a JSON
 * dictionary of named keys ({"default":"sb_publishable_..."}), and the runtime
 * also still injects the legacy SUPABASE_ANON_KEY. Once legacy keys are turned
 * off that legacy value keeps being injected but every request carrying it is
 * rejected with "Legacy API keys are disabled" — so the publishable key must be
 * preferred. Legacy-only projects have no publishable keys at all, which is why
 * the legacy anon key stays as the fallback. `supabase start` (local dev) sets
 * the singular SUPABASE_PUBLISHABLE_KEY instead of the dictionary.
 */
function apiKey(): string {
  const dict = Deno.env.get('SUPABASE_PUBLISHABLE_KEYS');
  if (dict) {
    try {
      const keys = JSON.parse(dict) as Record<string, unknown>;
      const named = keys.default ?? Object.values(keys).find((v) => typeof v === 'string' && v);
      if (typeof named === 'string' && named) return named;
    } catch {
      // Malformed JSON: fall through to the single/local or legacy key.
    }
  }
  return Deno.env.get('SUPABASE_PUBLISHABLE_KEY') || Deno.env.get('SUPABASE_ANON_KEY') || '';
}

async function requireAdmin(req: Request) {
  const auth = req.headers.get('Authorization') ?? '';
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const key = apiKey();
  if (!supabaseUrl || !key) {
    throw new HttpError(500, 'Function is missing SUPABASE_URL and a publishable or anon key.');
  }
  if (!/^Bearer\s+\S+/i.test(auth)) throw new HttpError(401, 'Sign in as an admin to use the web check.');
  const res = await fetch(supabaseUrl + '/auth/v1/user', {
    headers: { apikey: key, Authorization: auth },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new HttpError(401, 'Your session has expired — sign in again.');
  const user = await res.json();
  if (user?.app_metadata?.role !== 'admin') {
    throw new HttpError(403, 'Only admins can run the Jumu\'ah web check.');
  }
  return user;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      // Identify the app so a masjid admin can see who read the page.
      'User-Agent': 'NZMasjidFinder-Admin/1.0 (+https://sheik7866.github.io/nz-masjid-finder/)',
      Accept: 'text/html,application/xhtml+xml,text/plain;q=0.8',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const type = res.headers.get('content-type') ?? '';
  if (!/(text\/html|application\/xhtml|text\/plain)/i.test(type)) throw new Error('not a text page');
  const buf = await res.arrayBuffer();
  return new TextDecoder('utf-8', { fatal: false }).decode(buf.slice(0, MAX_BYTES));
}

/** Optional web search. Returns [] when no key is configured or the API fails. */
async function webSearch(query: string, notes: string[]) {
  const key = Deno.env.get('TAVILY_API_KEY');
  if (!key) return [];
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ query, max_results: 5, search_depth: 'basic', include_answer: false }),
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) { notes.push('Web search returned HTTP ' + res.status + '; used the masjid website only.'); return []; }
    const data = await res.json();
    return (data.results ?? [])
      .filter((r: { url?: string }) => typeof r.url === 'string' && /^https?:/i.test(r.url))
      .map((r: { url: string; title?: string; content?: string }) => ({ url: r.url, title: r.title ?? '', text: r.content ?? '' }));
  } catch (e) {
    notes.push('Web search unavailable (' + (e as Error).message + '); used the masjid website only.');
    return [];
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  try {
    await requireAdmin(req);

    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { throw new HttpError(400, 'Expected a JSON body'); }

    const name = String(body.name ?? '').trim();
    if (!name) throw new HttpError(400, 'A masjid name is required.');
    const city = String(body.city ?? '').trim();
    const region = String(body.region ?? '').trim();
    const website = String(body.website ?? '').trim();

    const notes: string[] = [];
    const queries: string[] = [];
    const sources: Array<{ url: string; title: string; times: string[]; snippets: string[] }> = [];
    const seen = new Set<string>();
    let fetched = 0;

    const add = (url: string, title: string, text: string) => {
      if (seen.has(url)) return;
      seen.add(url);
      const found = extractJummah(text);
      sources.push({ url, title: title || hostOf(url), times: found.times, snippets: found.snippets });
    };

    // 1. The masjid's own website: homepage, then its prayer/timetable pages.
    if (/^https?:\/\//i.test(website)) {
      try {
        const html = await fetchText(website);
        fetched += 1;
        add(website, pageTitle(html), stripHtml(html));
        const links = sameOriginLinks(html, website, { limit: MAX_PAGES - 1 });
        for (const link of links) {
          if (fetched >= MAX_PAGES) break;
          try {
            const sub = await fetchText(link);
            fetched += 1;
            add(link, pageTitle(sub), stripHtml(sub));
          } catch (e) {
            notes.push('Could not read ' + hostOf(link) + ' page (' + (e as Error).message + ').');
          }
        }
      } catch (e) {
        notes.push('Could not read ' + hostOf(website) + ' (' + (e as Error).message + ').');
      }
    } else {
      notes.push('No website on record for this masjid, so only search results could be checked.');
    }

    // 2. Optional: search the wider web for the masjid's timetable page.
    const query = searchQuery({ name, city, region });
    queries.push(query);
    const results = await webSearch(query, notes);
    for (const r of results) {
      if (fetched >= MAX_PAGES + 4) break;
      if (seen.has(r.url)) continue;
      if (extractJummah(r.text).times.length) {
        // add() marks the URL as seen itself; adding it here first would make
        // add() skip the result and silently drop a page that did have times.
        add(r.url, r.title, r.text);
        continue;
      }
      // The search snippet had no time: read the page itself.
      try {
        const html = await fetchText(r.url);
        fetched += 1;
        add(r.url, pageTitle(html) || r.title, stripHtml(html));
      } catch (e) {
        notes.push('Could not read ' + hostOf(r.url) + ' (' + (e as Error).message + ').');
      }
    }

    // 3. Directory fallback: only when nothing above produced a time.
    if (!sources.some((s) => s.times.length)) {
      try {
        const html = await fetchText(KMD_URL);
        fetched += 1;
        const row = matchKmdEntry(kmdEntries(stripHtml(html)), name);
        if (row) {
          seen.add(KMD_URL);
          sources.push({
            url: KMD_URL,
            title: 'Kiwi Muslim Directory — Jumah Prayer Times',
            // Winter first, summer second: the admin UI saves the second time,
            // which is the one in force while daylight saving is on.
            times: [row.winter, row.summer],
            snippets: [row.name + ' — winter ' + row.winter + ', summer ' + row.summer],
          });
        } else {
          notes.push('Kiwi Muslim Directory lists no Jumu\'ah time for this masjid.');
        }
      } catch (e) {
        notes.push('Could not read Kiwi Muslim Directory (' + (e as Error).message + ').');
      }
    }

    // Most times first, then pages that at least mention the khutbah.
    sources.sort((a, b) => (b.times.length - a.times.length) || (b.snippets.length - a.snippets.length));

    return json({
      ok: true,
      name,
      found: sources.some((s) => s.times.length > 0),
      search_used: Boolean(Deno.env.get('TAVILY_API_KEY')),
      pages_read: fetched,
      queries,
      sources: sources.slice(0, 12),
      notes: notes.slice(0, 8),
    });
  } catch (e) {
    const status = e instanceof HttpError ? (e as HttpError).status : 500;
    return json({ error: (e as Error).message || 'Unexpected error' }, status);
  }
});
