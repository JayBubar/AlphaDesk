/**
 * Netlify scheduled function — nightly auto-warm of research + insider caches
 * for every ticker on the user's watchlist.
 *
 * Schedule: configured in netlify.toml. Runs once daily before market open
 * so a returning user sees fresh research without manually clicking buttons.
 *
 * Reads the watchlist from /api/sync-watchlist (mirrored from localStorage by
 * App.jsx) and walks tickers serially with a 500ms pause between Perplexity
 * calls. Perplexity rate limits are generous but politeness > clever bursts.
 *
 * Skipping logic:
 *   - If a ticker already has a fresh research entry (<24h), skip its
 *     research warm. The endpoint already returns the cached copy quickly
 *     but we still avoid the round-trip.
 *   - Same for insider (<7d in screen.mjs's TTL).
 *
 * Failures per ticker are logged and skipped — one bad ticker doesn't kill
 * the run. The function always returns 200 with a summary.
 */
import { getStore } from '@netlify/blobs';

const PERPLEXITY_PAUSE_MS = 500;
const RESEARCH_TTL_MS = 24 * 60 * 60 * 1000;
const INSIDER_TTL_MS  = 7 * 24 * 60 * 60 * 1000;

function siteBase() {
  // URL/SITE_URL/DEPLOY_URL are all set by Netlify; pick the first one available.
  return process.env.URL || process.env.SITE_URL || process.env.DEPLOY_URL ||
         'https://alphadesk-app.netlify.app';
}

async function loadWatchlistTickers() {
  try {
    const store = getStore('user-watchlist');
    const data = await store.get('default', { type: 'json' });
    return Array.isArray(data?.tickers) ? data.tickers : [];
  } catch { return []; }
}

async function freshInStore(storeName, ticker, ttlMs) {
  try {
    const store = getStore(storeName);
    const raw = await store.get(ticker, { type: 'json' });
    if (!raw?.cached_at) return false;
    return Date.now() - new Date(raw.cached_at).getTime() < ttlMs;
  } catch { return false; }
}

async function warmResearch(ticker, base) {
  if (await freshInStore('research-cache', ticker, RESEARCH_TTL_MS)) {
    return 'skip-fresh';
  }
  const res = await fetch(`${base}/api/research/${encodeURIComponent(ticker)}`);
  if (res.status === 503) return 'skip-no-key';
  if (!res.ok) throw new Error(`research ${res.status}`);
  return 'warmed';
}

async function warmInsider(ticker, base) {
  if (await freshInStore('insider-scores', ticker, INSIDER_TTL_MS)) {
    return 'skip-fresh';
  }
  // /api/insider/{ticker} returns the score; insider.py doesn't currently
  // write to Blobs itself, so we need to POST to cache-insider to persist.
  const fetchRes = await fetch(`${base}/api/insider/${encodeURIComponent(ticker)}`);
  if (!fetchRes.ok) throw new Error(`insider ${fetchRes.status}`);
  const payload = await fetchRes.json();
  const cacheRes = await fetch(`${base}/api/cache-insider`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticker, payload }),
  });
  if (!cacheRes.ok) throw new Error(`cache-insider ${cacheRes.status}`);
  return 'warmed';
}

export default async () => {
  const base = siteBase();
  const tickers = await loadWatchlistTickers();
  const summary = {
    started_at: new Date().toISOString(),
    base,
    ticker_count: tickers.length,
    research: { warmed: 0, skipped: 0, failed: 0 },
    insider:  { warmed: 0, skipped: 0, failed: 0 },
    failures: [],
  };

  for (const ticker of tickers) {
    // Research
    try {
      const r = await warmResearch(ticker, base);
      if (r === 'warmed') summary.research.warmed++;
      else summary.research.skipped++;
    } catch (e) {
      summary.research.failed++;
      summary.failures.push({ ticker, layer: 'research', error: e.message });
    }
    // Polite pause before next Perplexity call.
    await new Promise(r => setTimeout(r, PERPLEXITY_PAUSE_MS));

    // Insider
    try {
      const r = await warmInsider(ticker, base);
      if (r === 'warmed') summary.insider.warmed++;
      else summary.insider.skipped++;
    } catch (e) {
      summary.insider.failed++;
      summary.failures.push({ ticker, layer: 'insider', error: e.message });
    }
  }

  summary.finished_at = new Date().toISOString();
  console.log('[warm-caches]', JSON.stringify(summary));

  return new Response(JSON.stringify(summary), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

// Netlify Scheduled Functions config — runs daily at 11:00 UTC (~6am ET in
// EDT, 7am EST). After overnight news cycles, before the US market opens.
export const config = {
  schedule: '0 11 * * *',
};
