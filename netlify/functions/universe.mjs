/**
 * Netlify serverless function — dynamic S&P 500 + S&P 400 universe.
 *
 * GET /api/universe           → { tickers: [...], count, refreshed_at, source }
 * GET /api/universe?refresh=1 → bypass cache, re-fetch from Wikipedia
 *
 * The "ticker" entries are { symbol, name, sector } — sector lets screen.mjs
 * apply the sector filter BEFORE paying for any Schwab/FMP API calls.
 *
 * Cache: Netlify Blobs store "universe", key "sp900". 7-day TTL.
 */
import { getStore } from '@netlify/blobs';

const STORE_NAME = 'universe';
const CACHE_KEY  = 'sp900';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CORS = { 'Access-Control-Allow-Origin': '*' };

const SP500_URL = 'https://en.wikipedia.org/wiki/List_of_S%26P_500_companies';
const SP400_URL = 'https://en.wikipedia.org/wiki/List_of_S%26P_400_companies';
const UA = 'AlphaDeskBot/1.0 (https://alphadesk-app.netlify.app; research only)';

// Fallback universe — used if Wikipedia parsing fails entirely. Same 25-ticker
// list the app started with, so the screener still works.
const FALLBACK_TICKERS = [
  ['MSFT','Microsoft Corporation','Information Technology'],
  ['AAPL','Apple Inc.','Information Technology'],
  ['GOOGL','Alphabet Inc.','Communication Services'],
  ['NVDA','NVIDIA Corporation','Information Technology'],
  ['META','Meta Platforms Inc.','Communication Services'],
  ['UNH','UnitedHealth Group','Health Care'],
  ['JPM','JPMorgan Chase','Financials'],
  ['LLY','Eli Lilly','Health Care'],
  ['V','Visa Inc.','Financials'],
  ['PG','Procter & Gamble','Consumer Staples'],
  ['KO','Coca-Cola','Consumer Staples'],
  ['COST','Costco','Consumer Staples'],
  ['WMT','Walmart','Consumer Staples'],
  ['MCD',"McDonald's",'Consumer Discretionary'],
  ['AMD','AMD','Information Technology'],
  ['AMAT','Applied Materials','Information Technology'],
  ['AXON','Axon Enterprise','Industrials'],
  ['CRWD','CrowdStrike','Information Technology'],
  ['WM','Waste Management','Industrials'],
  ['BAC','Bank of America','Financials'],
  ['AMZN','Amazon','Consumer Discretionary'],
  ['AVGO','Broadcom','Information Technology'],
  ['NFLX','Netflix','Communication Services'],
  ['CRM','Salesforce','Information Technology'],
  ['ADBE','Adobe','Information Technology'],
].map(([symbol, name, sector]) => ({ symbol, name, sector }));

/**
 * Parse the first wikitable on a Wikipedia constituents page.
 * Both S&P 500 and S&P 400 pages share the same column layout:
 *   col 0: Symbol  col 1: Security (name)  col 2: GICS Sector  col 3: GICS Sub-Industry
 *
 * We do a forgiving parse: pull <tr>...</tr> blocks, then within each row pull
 * <td>...</td> blocks, strip HTML, and keep rows that look like ticker+name+sector.
 */
function parseConstituentsTable(html) {
  // Isolate the first wikitable. Wikipedia tags it with class="wikitable".
  const tableMatch = html.match(/<table[^>]*class="[^"]*wikitable[^"]*"[^>]*>([\s\S]*?)<\/table>/i);
  if (!tableMatch) return [];

  const rows = tableMatch[1].match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const out = [];

  for (const row of rows) {
    const cells = row.match(/<t[hd][\s\S]*?<\/t[hd]>/gi) || [];
    if (cells.length < 3) continue;

    const stripped = cells.slice(0, 3).map(stripHtml).map(s => s.trim());
    const [symbolRaw, name, sector] = stripped;
    if (!symbolRaw || !name || !sector) continue;

    // Skip header row.
    if (/^symbol$/i.test(symbolRaw) || /^ticker$/i.test(symbolRaw)) continue;
    // Symbol should be a short uppercase token; reject obvious garbage.
    if (!/^[A-Z][A-Z0-9.\-]{0,7}$/.test(symbolRaw)) continue;

    // Wikipedia quirks: BRK.B → BRK-B (Schwab/FMP use dash form for share classes).
    const symbol = symbolRaw.replace(/\./g, '-');
    out.push({ symbol, name, sector });
  }
  return out;
}

function stripHtml(s) {
  return s
    .replace(/<[^>]+>/g, '')   // tags
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ');
}

async function fetchWikipedia(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
  if (!res.ok) throw new Error(`Wikipedia ${res.status} for ${url}`);
  return res.text();
}

async function buildUniverse() {
  const errors = [];
  let sp500 = [], sp400 = [];
  try { sp500 = parseConstituentsTable(await fetchWikipedia(SP500_URL)); }
  catch (e) { errors.push(`sp500: ${e.message}`); }
  try { sp400 = parseConstituentsTable(await fetchWikipedia(SP400_URL)); }
  catch (e) { errors.push(`sp400: ${e.message}`); }

  // Merge + dedupe by symbol; S&P 500 entries win when both lists have a name.
  const map = new Map();
  for (const e of sp400) map.set(e.symbol, e);
  for (const e of sp500) map.set(e.symbol, e);

  const tickers = Array.from(map.values()).sort((a, b) =>
    a.symbol.localeCompare(b.symbol));

  // If Wikipedia returns nothing usable, fall back so the app keeps working.
  if (tickers.length < 100) {
    return {
      tickers: FALLBACK_TICKERS,
      source: 'fallback',
      errors: errors.length ? errors : ['parsed too few rows'],
    };
  }

  return { tickers, source: 'wikipedia', errors };
}

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const refresh = new URL(req.url).searchParams.get('refresh') === '1';

  let store;
  try { store = getStore(STORE_NAME); } catch { store = null; }

  if (!refresh && store) {
    try {
      const cached = await store.get(CACHE_KEY, { type: 'json' });
      if (cached?.refreshed_at &&
          Date.now() - new Date(cached.refreshed_at).getTime() < TTL_MS) {
        return Response.json({ ...cached, cached: true }, { headers: CORS });
      }
    } catch { /* fall through to refresh */ }
  }

  try {
    const { tickers, source, errors } = await buildUniverse();
    const entry = {
      tickers,
      count: tickers.length,
      source,
      errors,
      refreshed_at: new Date().toISOString(),
    };
    if (store) {
      try { await store.set(CACHE_KEY, JSON.stringify(entry)); } catch { /* silent */ }
    }
    return Response.json({ ...entry, cached: false }, { headers: CORS });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500, headers: CORS });
  }
};
