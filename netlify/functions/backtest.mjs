/**
 * Netlify serverless function — per-ticker historical backtest.
 *
 * Ported from backend/backtest/{fmp_history,score}.py. Same response shape,
 * same methodology version, same absolute-threshold scoring, same forward-
 * return windows (30/60/90/180d), same SPY benchmark.
 *
 * GET /api/backtest/{ticker}            → cached (30d) or fresh
 * GET /api/backtest/{ticker}?refresh=1  → bypass cache, re-fetch FMP history
 *
 * FMP history is stable so per-ticker results cache for 30 days.
 * SPY benchmark history is cached separately (24h) so 100 ticker backtests
 * share one SPY fetch.
 */
import { getStore } from '@netlify/blobs';

const METHODOLOGY_VERSION = '2026.06.2';
const STORE_NAME = 'backtest-results';
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CORS = { 'Access-Control-Allow-Origin': '*' };

const FMP_BASE = 'https://financialmodelingprep.com/stable';
const FETCH_TIMEOUT_MS = 15000;

const HISTORY_YEARS = 2;
const FUNDAMENTALS_LIMIT = 12;
const FORWARD_WINDOWS_DAYS = [30, 60, 90, 180];

// SPY benchmark cache (shared across all per-ticker backtests)
const SPY_STORE = 'backtest-spy';
const SPY_KEY = 'history';
const SPY_TTL_MS = 24 * 60 * 60 * 1000;

const METHODOLOGY_NOTE =
  'Historical composite uses absolute thresholds, not peer-percentile. ' +
  'Only fundamentals + momentum + analyst sentiment are reconstructable; ' +
  'filings, insider, and Perplexity sentiment are omitted.';

// ── FMP fetch helpers ──────────────────────────────────────────────────────

function fetchWithTimeout(url, ms = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, {
    signal: controller.signal,
    headers: { 'User-Agent': 'AlphaDeskBacktest/1.0' },
  }).finally(() => clearTimeout(timer));
}

function normalizePriceRows(raw, years) {
  const rows = (raw && typeof raw === 'object' && 'historical' in raw) ? raw.historical : raw;
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const r of rows) {
    const date = r?.date;
    const close = r?.close ?? r?.adjClose;
    if (!date || close == null) continue;
    out.push({
      date,
      close: Number(close),
      high:  Number(r.high ?? close),
      low:   Number(r.low  ?? close),
    });
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  if (!out.length) return out;
  const cutoffYear = Number(out[out.length - 1].date.slice(0, 4)) - years - 1;
  return out.filter(r => Number(r.date.slice(0, 4)) > cutoffYear);
}

function fmpError(label, res) {
  if (res.status === 402) {
    return new Error(
      `FMP ${label}: 402 — endpoint requires a paid FMP plan. ` +
      `The free tier doesn't include historical fundamentals.`
    );
  }
  if (res.status === 429) {
    return new Error(`FMP ${label}: 429 — rate limited. Wait a minute and retry.`);
  }
  return new Error(`FMP ${label}: ${res.status}`);
}

async function fetchHistoricalPrices(ticker, apiKey) {
  const url = `${FMP_BASE}/historical-price-eod/full?symbol=${encodeURIComponent(ticker)}&apikey=${apiKey}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw fmpError(`prices for ${ticker}`, res);
  const data = await res.json();
  return normalizePriceRows(data, HISTORY_YEARS);
}

async function fetchQuarterlyFundamentals(ticker, apiKey) {
  const url = `${FMP_BASE}/key-metrics?symbol=${encodeURIComponent(ticker)}&period=quarter&limit=${FUNDAMENTALS_LIMIT}&apikey=${apiKey}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw fmpError(`fundamentals for ${ticker}`, res);
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data;
}

async function fetchSpyHistory(apiKey) {
  // Try blob cache first.
  let store;
  try { store = getStore(SPY_STORE); } catch { store = null; }
  if (store) {
    try {
      const cached = await store.get(SPY_KEY, { type: 'json' });
      if (cached?.cached_at &&
          Date.now() - new Date(cached.cached_at).getTime() < SPY_TTL_MS) {
        return cached.rows;
      }
    } catch { /* miss */ }
  }

  const url = `${FMP_BASE}/historical-price-eod/full?symbol=SPY&apikey=${apiKey}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`FMP SPY ${res.status}`);
  const data = await res.json();
  const rows = normalizePriceRows(data, HISTORY_YEARS);

  if (store && rows.length) {
    try {
      await store.set(SPY_KEY, JSON.stringify({
        rows,
        cached_at: new Date().toISOString(),
      }));
    } catch { /* silent */ }
  }
  return rows;
}

// ── Absolute-threshold scoring (mirror score.py) ───────────────────────────

function scorePE(pe) {
  if (pe == null || pe <= 0) return null;
  if (pe < 12) return 95;
  if (pe < 18) return 80;
  if (pe < 25) return 60;
  if (pe < 35) return 40;
  if (pe < 50) return 25;
  return 10;
}

function scoreROE(roe) {
  if (roe == null) return null;
  if (Math.abs(roe) < 2.0) roe = roe * 100;
  if (roe < 0)  return 10;
  if (roe < 5)  return 30;
  if (roe < 12) return 50;
  if (roe < 20) return 70;
  if (roe < 30) return 85;
  return 95;
}

function scoreGrossMargin(gm) {
  if (gm == null) return null;
  if (Math.abs(gm) < 2.0) gm = gm * 100;
  if (gm < 15) return 20;
  if (gm < 25) return 40;
  if (gm < 40) return 60;
  if (gm < 60) return 80;
  return 95;
}

function scoreDebtEquity(de) {
  if (de == null) return null;
  if (de < 0.3) return 95;
  if (de < 0.7) return 80;
  if (de < 1.5) return 60;
  if (de < 2.5) return 40;
  if (de < 4.0) return 20;
  return 10;
}

function score52wPosition(pos) {
  if (pos == null) return null;
  if (pos < 0.20) return 30;
  if (pos < 0.40) return 50;
  if (pos < 0.60) return 65;
  if (pos < 0.80) return 75;
  return 85;
}

function scoreMaTrend(trend) {
  if (trend == null) return null;
  if (trend > 0) return 75;
  if (trend < 0) return 25;
  return 50;
}

function scorePriceChange(chg) {
  if (chg == null) return null;
  if (chg < -10) return 20;
  if (chg < -5)  return 35;
  if (chg < 0)   return 50;
  if (chg < 5)   return 60;
  if (chg < 15)  return 75;
  return 85;
}

function avgNonNull(scores) {
  const vals = scores.filter(s => s != null);
  if (!vals.length) return null;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

const HISTORICAL_PILLAR_WEIGHTS = {
  fundamentals: 55,
  momentum:     30,
  sentiment:    15,
};

function composite(fundamentals, momentum, sentiment) {
  let weighted = 0, totalW = 0;
  for (const [pillar, score] of [
    ['fundamentals', fundamentals],
    ['momentum',     momentum],
    ['sentiment',    sentiment],
  ]) {
    if (score == null) continue;
    const w = HISTORICAL_PILLAR_WEIGHTS[pillar];
    weighted += score * w;
    totalW += w;
  }
  if (!totalW) return null;
  return Math.round((weighted / totalW) * 10) / 10;
}

// ── Price-series lookups (bisect equivalents) ──────────────────────────────

function bisectLeft(dates, target) {
  let lo = 0, hi = dates.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function bisectRight(dates, target) {
  let lo = 0, hi = dates.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function priceOnOrAfter(prices, dates, target) {
  const idx = bisectLeft(dates, target);
  if (idx >= prices.length) return null;
  return prices[idx];
}

function maTrend(prices, dates, snapDate) {
  const idx = bisectRight(dates, snapDate) - 1;
  if (idx < 200) return null;
  const closes = [];
  for (let i = Math.max(0, idx - 199); i <= idx; i++) closes.push(prices[i].close);
  if (closes.length < 200) return null;
  const price = closes[closes.length - 1];
  const sum50  = closes.slice(-50).reduce((s, v) => s + v, 0);
  const sum200 = closes.reduce((s, v) => s + v, 0);
  const ma50   = sum50 / 50;
  const ma200  = sum200 / 200;
  if (price > ma50 && ma50 > ma200) return 1;
  if (price < ma50 && ma50 < ma200) return -1;
  return 0;
}

function priceChange30d(prices, dates, snapDate) {
  const endIdx = bisectRight(dates, snapDate) - 1;
  if (endIdx < 21) return null;
  const startIdx = endIdx - 21;
  const endClose = prices[endIdx].close;
  const startClose = prices[startIdx].close;
  if (startClose <= 0) return null;
  return ((endClose - startClose) / startClose) * 100;
}

function position52w(prices, dates, snapDate) {
  const endIdx = bisectRight(dates, snapDate) - 1;
  if (endIdx < 60) return null;
  const startIdx = Math.max(0, endIdx - 252);
  let high = -Infinity, low = Infinity;
  for (let i = startIdx; i <= endIdx; i++) {
    if (prices[i].high > high) high = prices[i].high;
    if (prices[i].low  < low)  low  = prices[i].low;
  }
  const cp = prices[endIdx].close;
  const span = high - low;
  if (span <= 0) return null;
  return (cp - low) / span;
}

function forwardReturn(prices, dates, snapDate, days) {
  const snapRow = priceOnOrAfter(prices, dates, snapDate);
  if (!snapRow) return null;
  const target = new Date(snapDate + 'T00:00:00Z');
  target.setUTCDate(target.getUTCDate() + days);
  const targetStr = target.toISOString().slice(0, 10);
  const fwdRow = priceOnOrAfter(prices, dates, targetStr);
  if (!fwdRow || snapRow.close <= 0) return null;
  return Math.round(((fwdRow.close - snapRow.close) / snapRow.close) * 100 * 100) / 100;
}

// ── Summary (mirror score.py _summarize) ───────────────────────────────────

function summarize(snapshots) {
  const out = { high_band_threshold: 70 };
  for (const days of FORWARD_WINDOWS_DAYS) {
    const retKey = `return_${days}d`;
    const excKey = `excess_${days}d`;
    const high = snapshots.filter(s => s.composite != null && s.composite >= 70);
    const highRet = high.filter(s => s[retKey] != null);
    if (!highRet.length) { out[`${days}d`] = null; continue; }
    const meanReturn = highRet.reduce((s, r) => s + r[retKey], 0) / highRet.length;
    const excessWith = highRet.filter(s => s[excKey] != null);
    const meanExcess = excessWith.length
      ? excessWith.reduce((s, r) => s + r[excKey], 0) / excessWith.length
      : null;
    const hits = highRet.filter(s => s[retKey] > 0).length;
    out[`${days}d`] = {
      n: highRet.length,
      mean_return: Math.round(meanReturn * 100) / 100,
      mean_excess: meanExcess != null ? Math.round(meanExcess * 100) / 100 : null,
      hit_rate:    Math.round((hits / highRet.length) * 1000) / 10,
    };
  }
  return out;
}

// ── Orchestration ──────────────────────────────────────────────────────────

function emptyResult(ticker, error) {
  return {
    ticker,
    snapshots: [],
    summary: {},
    methodology_version: METHODOLOGY_VERSION,
    methodology_note: METHODOLOGY_NOTE,
    timestamp: new Date().toISOString(),
    error,
  };
}

async function runBacktest(ticker, { forceRefresh = false, cacheOnly = false } = {}) {
  ticker = ticker.toUpperCase();

  let store;
  try { store = getStore(STORE_NAME); } catch { store = null; }

  if (!forceRefresh && store) {
    try {
      const cached = await store.get(ticker, { type: 'json' });
      if (cached &&
          cached.methodology_version === METHODOLOGY_VERSION &&
          cached.cached_at &&
          Date.now() - new Date(cached.cached_at).getTime() < TTL_MS) {
        return cached;
      }
    } catch { /* miss */ }
  }

  if (cacheOnly) return { cached: false };

  const apiKey = process.env.FMP_API_KEY || '';
  if (!apiKey) return emptyResult(ticker, 'FMP_API_KEY not set');

  let prices, fundamentals, spy;
  try {
    [prices, fundamentals, spy] = await Promise.all([
      fetchHistoricalPrices(ticker, apiKey),
      fetchQuarterlyFundamentals(ticker, apiKey),
      fetchSpyHistory(apiKey),
    ]);
  } catch (e) {
    return emptyResult(ticker, e.message);
  }

  if (!prices.length || !fundamentals.length) {
    return emptyResult(ticker,
      'insufficient FMP history (need both prices and quarterly metrics)');
  }

  const dates = prices.map(p => p.date);
  const spyDates = spy.map(p => p.date);

  const snapshots = [];
  for (const f of fundamentals) {
    const snapDate = f.date || f.reportedDate;
    if (!snapDate) continue;
    const snapRow = priceOnOrAfter(prices, dates, snapDate);
    if (!snapRow) continue;

    const pe = f.peRatio ?? f.pe ?? f.priceEarningsRatio ?? null;
    const roe = f.returnOnEquity ?? f.roe ?? f.returnOnTangibleEquity ?? null;
    const gm = f.grossProfitMargin ?? f.grossMargin ?? null;
    const de = f.debtToEquity ?? f.debtEquityRatio ?? null;

    const fundScore = avgNonNull([
      scorePE(pe), scoreROE(roe), scoreGrossMargin(gm), scoreDebtEquity(de),
    ]);
    const momScore = avgNonNull([
      score52wPosition(position52w(prices, dates, snapDate)),
      scoreMaTrend(maTrend(prices, dates, snapDate)),
      scorePriceChange(priceChange30d(prices, dates, snapDate)),
    ]);
    const sentScore = 50.0;  // placeholder per methodology_note

    const snap = {
      snapshot_date: snapDate,
      snapshot_price: Math.round(snapRow.close * 100) / 100,
      composite: composite(fundScore, momScore, sentScore),
      fundamentals_score: fundScore,
      momentum_score: momScore,
      sentiment_score: sentScore,
      pe, roe, gross_margin: gm, debt_equity: de,
      return_30d:  null, return_60d:  null, return_90d:  null, return_180d: null,
      excess_30d:  null, excess_60d:  null, excess_90d:  null, excess_180d: null,
    };
    for (const days of FORWARD_WINDOWS_DAYS) {
      const ticRet = forwardReturn(prices, dates, snapDate, days);
      const spyRet = forwardReturn(spy,    spyDates, snapDate, days);
      snap[`return_${days}d`] = ticRet;
      if (ticRet != null && spyRet != null) {
        snap[`excess_${days}d`] = Math.round((ticRet - spyRet) * 100) / 100;
      }
    }
    snapshots.push(snap);
  }

  const result = {
    ticker,
    snapshots,
    summary: summarize(snapshots),
    methodology_version: METHODOLOGY_VERSION,
    methodology_note: METHODOLOGY_NOTE,
    timestamp: new Date().toISOString(),
    error: null,
  };

  if (store) {
    try {
      await store.set(ticker, JSON.stringify({
        ...result,
        cached_at: new Date().toISOString(),
      }));
    } catch { /* silent */ }
  }
  return result;
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
  if (!ticker || ticker === 'BACKTEST') {
    return Response.json({ error: 'ticker required' }, { status: 400, headers: CORS });
  }

  const sp = new URL(req.url).searchParams;
  const refresh   = sp.get('refresh') === '1';
  const cacheOnly = sp.get('cacheOnly') === '1';

  try {
    const result = await runBacktest(ticker, { forceRefresh: refresh, cacheOnly });
    return Response.json(result, { headers: CORS });
  } catch (err) {
    return Response.json(
      { error: err.message, stack: err.stack },
      { status: 502, headers: CORS },
    );
  }
};
