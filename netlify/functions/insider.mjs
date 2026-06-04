/**
 * Netlify serverless function — insider-activity score from SEC Form 4.
 *
 * Ported from backend/insider/{edgar_form4,score}.py. Same lookback window
 * (90 days), same composite formula (60% count-ratio + 40% value-ratio),
 * same response shape — including the existing methodology version so the
 * blob cache from the Python era remains valid.
 *
 * GET /api/insider/{ticker}            → cached (6h soft TTL) or fresh
 * GET /api/insider/{ticker}?refresh=1  → bypass cache, re-fetch from EDGAR
 *
 * Walks up to 20 Form 4 filings in the last 90 days and parses the
 * non-derivative-transaction block by regex (Form 4 XML schema is stable
 * enough that we skip a full XML parser).
 */
import { getStore } from '@netlify/blobs';
import {
  cikForTicker, fetchSubmissions, pickRecentFilings, fetchFilingText,
} from './shared/edgar.mjs';

const METHODOLOGY_VERSION = '2026.06.2';
const STORE_NAME = 'insider-scores';
const RESULT_TTL_MS = 6 * 60 * 60 * 1000;  // 6h — Form 4s come in any day
const CORS = { 'Access-Control-Allow-Origin': '*' };

const LOOKBACK_DAYS = 90;
const MAX_FORM4_FETCH = 20;

// ── Form 4 XML parsing (mirror edgar_form4.py) ─────────────────────────────

const NON_DERIV_RE = /<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/g;

function tagValue(block, tag) {
  // <tag><value>X</value>...</tag>  (whitespace tolerant)
  const re = new RegExp(`<${tag}>\\s*<value>([^<]+)</value>`, 's');
  const m = block.match(re);
  return m ? m[1].trim() : null;
}

function parseTransactions(xml) {
  if (!xml || typeof xml !== 'string') return [];
  const out = [];
  let m;
  NON_DERIV_RE.lastIndex = 0;
  while ((m = NON_DERIV_RE.exec(xml)) !== null) {
    const block = m[1];
    const date  = tagValue(block, 'transactionDate');
    const codeMatch = block.match(/<transactionCode>\s*([A-Z])\s*<\/transactionCode>/);
    const code = codeMatch ? codeMatch[1] : null;
    const ad   = tagValue(block, 'transactionAcquiredDisposedCode');
    const sharesStr = tagValue(block, 'transactionShares');
    const priceStr  = tagValue(block, 'transactionPricePerShare');
    if (!date || !code || !ad || !sharesStr) continue;
    const shares = parseFloat(sharesStr);
    if (Number.isNaN(shares)) continue;
    const price = priceStr ? parseFloat(priceStr) : null;
    const value = price != null && !Number.isNaN(price) ? shares * price : null;
    out.push({
      transaction_date: date,
      transaction_code: code,
      acquired_disposed: ad,
      shares,
      price_per_share: price != null && !Number.isNaN(price) ? price : null,
      value,
    });
  }
  return out;
}

// ── Score composition (mirror score.py) ────────────────────────────────────

function composeScore(buyCount, sellCount, buyValue, sellValue) {
  const total = buyCount + sellCount;
  if (total === 0) return 50.0;
  const countRatio = buyCount / total;
  const totalValue = buyValue + sellValue;
  const valueRatio = totalValue > 0 ? buyValue / totalValue : countRatio;
  const blended = 0.6 * countRatio + 0.4 * valueRatio;
  let score = blended * 100;
  if (score < 0)   score = 0;
  if (score > 100) score = 100;
  return Math.round(score * 10) / 10;
}

function emptyResult(ticker, error) {
  return {
    ticker,
    score: 50.0,
    buy_count: 0, sell_count: 0,
    buy_value: null, sell_value: null, net_value: null,
    filing_count: 0,
    lookback_days: LOOKBACK_DAYS,
    methodology_version: METHODOLOGY_VERSION,
    timestamp: new Date().toISOString(),
    error,
  };
}

// ── Form 4 listing (filter to the lookback window) ─────────────────────────

function listRecentForm4s(submissions) {
  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86400_000)
    .toISOString().slice(0, 10);
  return pickRecentFilings(submissions, '4', MAX_FORM4_FETCH, { sinceDate: cutoff });
}

// ── Orchestration ──────────────────────────────────────────────────────────

async function compute(ticker, { forceRefresh = false, cacheOnly = false } = {}) {
  ticker = ticker.toUpperCase();

  let store;
  try { store = getStore(STORE_NAME); } catch { store = null; }

  if (!forceRefresh && store) {
    try {
      const cached = await store.get(ticker, { type: 'json' });
      if (cached &&
          cached.methodology_version === METHODOLOGY_VERSION &&
          cached.cached_at &&
          Date.now() - new Date(cached.cached_at).getTime() < RESULT_TTL_MS) {
        return cached;
      }
    } catch { /* miss */ }
  }

  if (cacheOnly) return { cached: false };

  const cik = await cikForTicker(ticker);
  if (!cik) return emptyResult(ticker, 'ticker not in EDGAR CIK table');

  let submissions;
  try { submissions = await fetchSubmissions(cik); }
  catch (e) { return emptyResult(ticker, `submissions fetch failed: ${e.message}`); }

  const filings = listRecentForm4s(submissions);
  if (filings.length === 0) {
    const result = emptyResult(ticker, 'no Form 4 filings in lookback window');
    await writeCache(store, ticker, result);
    return result;
  }

  // Walk filings serially — Form 4 XMLs are small but EDGAR's per-IP throttle
  // is per-request, not per-burst. Parallel would risk 429s.
  const allTxs = [];
  for (const f of filings) {
    try {
      const xml = await fetchFilingText(f);
      allTxs.push(...parseTransactions(xml));
    } catch {
      // Skip a single bad filing; one missing Form 4 shouldn't kill the score.
    }
  }

  // Only count open-market buys (P) and open-market sells (S). Everything
  // else is noise — option exercises, gifts, tax withholding, etc.
  const buys  = allTxs.filter(t => t.transaction_code === 'P');
  const sells = allTxs.filter(t => t.transaction_code === 'S');

  const buyValue  = buys.reduce((s, t) => s + (t.value || 0), 0);
  const sellValue = sells.reduce((s, t) => s + (t.value || 0), 0);

  const score = composeScore(buys.length, sells.length, buyValue, sellValue);

  const result = {
    ticker,
    score,
    buy_count: buys.length,
    sell_count: sells.length,
    buy_value:  buyValue  ? Math.round(buyValue  * 100) / 100 : null,
    sell_value: sellValue ? Math.round(sellValue * 100) / 100 : null,
    net_value:  (buyValue || sellValue)
      ? Math.round((buyValue - sellValue) * 100) / 100 : null,
    filing_count: filings.length,
    lookback_days: LOOKBACK_DAYS,
    methodology_version: METHODOLOGY_VERSION,
    timestamp: new Date().toISOString(),
    error: (buys.length || sells.length) ? null : 'no open-market transactions in window',
  };
  await writeCache(store, ticker, result);
  return result;
}

async function writeCache(store, ticker, result) {
  if (!store) return;
  try {
    await store.set(ticker, JSON.stringify({
      ...result,
      cached_at: new Date().toISOString(),
    }));
  } catch { /* silent */ }
}

// ── Handler ────────────────────────────────────────────────────────────────

function tickerFromPath(url) {
  const parts = new URL(url).pathname.split('/').filter(Boolean);
  return (parts[parts.length - 1] || '').toUpperCase();
}

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const ticker = tickerFromPath(req.url);
  if (!ticker || ticker === 'INSIDER') {
    return Response.json({ error: 'ticker required' }, { status: 400, headers: CORS });
  }

  const sp = new URL(req.url).searchParams;
  const refresh   = sp.get('refresh') === '1';
  const cacheOnly = sp.get('cacheOnly') === '1';

  try {
    const result = await compute(ticker, { forceRefresh: refresh, cacheOnly });
    return Response.json(result, { headers: CORS });
  } catch (err) {
    return Response.json(
      { error: err.message, stack: err.stack },
      { status: 502, headers: CORS },
    );
  }
};
