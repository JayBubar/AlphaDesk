/**
 * Netlify serverless function — stock screening + peer-normalized scoring.
 *
 * Data pipeline (in priority order):
 *   1. Schwab MarketData v1  → bulk quote for all 25 tickers (1 API call)
 *        Provides: price, volume, beta, PE, gross margin, D/E, ROE, short %
 *   2. FMP /stable/ API      → profile + quote for survivors (2 calls)
 *        Adds: sector, industry, company name, DCF, analyst target, MA50/MA200
 *   3. FMP-only fallback     → when Schwab token isn't available
 *
 * The scoring engine (peer-percentile, 4 profiles) runs identically regardless
 * of which data source is used.
 */
import { getSchwabToken } from './shared/schwab-token.mjs';
import { getStore } from '@netlify/blobs';

// ── Filing-score cache ────────────────────────────────────────────────────────
// Written by netlify/functions/cache-filing.mjs (which FilingPanel.jsx calls
// after a manual /api/filings/{ticker} fetch). 30-day TTL since 10-Ks are
// annual filings — anything older is likely a new fiscal year.
const FILING_CACHE_STORE = 'filing-scores';
const FILING_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

async function loadFilingCache(tickers) {
  let store;
  try { store = getStore(FILING_CACHE_STORE); } catch { return {}; }
  const cutoff = Date.now() - FILING_CACHE_TTL_MS;

  const entries = await Promise.all(tickers.map(async t => {
    try {
      const raw = await store.get(t, { type: 'json' });
      if (!raw || !raw.cached_at) return [t, null];
      if (new Date(raw.cached_at).getTime() < cutoff) return [t, null];
      return [t, raw];
    } catch { return [t, null]; }
  }));
  return Object.fromEntries(entries);
}

function injectFilingMetrics(metrics, cached) {
  if (!cached) return metrics;
  // Python's FilingScore has risk_drift and mda_drift separately. The screen
  // engine expects a single filing_drift metric — average whichever are present.
  const drifts = [cached.risk_drift, cached.mda_drift].filter(v => v != null);
  const filing_drift = drifts.length ? drifts.reduce((s, v) => s + v, 0) / drifts.length : null;
  return {
    ...metrics,
    filing_drift,
    hedging_delta: cached.hedging_delta ?? null,
  };
}

// ── Research-score cache ──────────────────────────────────────────────────────
// Written by netlify/functions/research.mjs (Perplexity-backed). 24h TTL is
// enforced inside research.mjs at write-time; the screen path doesn't need to
// re-check since stale entries get refreshed on next FilingPanel click.
const RESEARCH_CACHE_STORE = 'research-cache';
const RESEARCH_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const SENTIMENT_SCORE_MAP = { bullish: 80, neutral: 50, bearish: 20 };
const CONSENSUS_SCORE_MAP = { buy: 80, hold: 50, sell: 20 };

async function loadResearchCache(tickers) {
  let store;
  try { store = getStore(RESEARCH_CACHE_STORE); } catch { return {}; }
  const cutoff = Date.now() - RESEARCH_CACHE_TTL_MS;

  const entries = await Promise.all(tickers.map(async t => {
    try {
      const raw = await store.get(t, { type: 'json' });
      if (!raw || !raw.cached_at) return [t, null];
      if (new Date(raw.cached_at).getTime() < cutoff) return [t, null];
      return [t, raw];
    } catch { return [t, null]; }
  }));
  return Object.fromEntries(entries);
}

function injectResearchMetrics(metrics, cached) {
  if (!cached) return metrics;
  return {
    ...metrics,
    sentiment_score: SENTIMENT_SCORE_MAP[cached.sentiment] ?? null,
    // Override null recommendation with the Perplexity-derived consensus.
    recommendation:  CONSENSUS_SCORE_MAP[cached.analystConsensus] ?? metrics.recommendation,
  };
}

// ── Insider-score cache ───────────────────────────────────────────────────────
// Written by netlify/functions/cache-insider.mjs (which InsiderPanel.jsx posts
// to after EDGAR Form 4 analysis). 7-day TTL — Form 4 activity is bursty but
// the score smooths over a 90-day lookback so re-pulling weekly is fine.
const INSIDER_CACHE_STORE = 'insider-scores';
const INSIDER_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function loadInsiderCache(tickers) {
  let store;
  try { store = getStore(INSIDER_CACHE_STORE); } catch { return {}; }
  const cutoff = Date.now() - INSIDER_CACHE_TTL_MS;

  const entries = await Promise.all(tickers.map(async t => {
    try {
      const raw = await store.get(t, { type: 'json' });
      if (!raw || !raw.cached_at) return [t, null];
      if (new Date(raw.cached_at).getTime() < cutoff) return [t, null];
      return [t, raw];
    } catch { return [t, null]; }
  }));
  return Object.fromEntries(entries);
}

function injectInsiderMetrics(metrics, cached) {
  if (!cached) return metrics;
  // Python's InsiderScore.score is already 0..100, higher = more buying.
  return { ...metrics, insider_activity: cached.score ?? null };
}

// ── Universe ──────────────────────────────────────────────────────────────────
// Dynamic universe is fetched from Netlify Blobs (store "universe", key
// "sp900"), populated by universe.mjs from Wikipedia. Falls back to a small
// hardcoded list so the screener still works if the blob is empty.
const UNIVERSE_STORE = 'universe';
const UNIVERSE_KEY = 'sp900';

const FALLBACK_UNIVERSE = [
  { symbol: 'MSFT',  sector: 'Information Technology' },
  { symbol: 'AAPL',  sector: 'Information Technology' },
  { symbol: 'GOOGL', sector: 'Communication Services' },
  { symbol: 'NVDA',  sector: 'Information Technology' },
  { symbol: 'META',  sector: 'Communication Services' },
  { symbol: 'UNH',   sector: 'Health Care' },
  { symbol: 'JPM',   sector: 'Financials' },
  { symbol: 'LLY',   sector: 'Health Care' },
  { symbol: 'V',     sector: 'Financials' },
  { symbol: 'PG',    sector: 'Consumer Staples' },
  { symbol: 'KO',    sector: 'Consumer Staples' },
  { symbol: 'COST',  sector: 'Consumer Staples' },
  { symbol: 'WMT',   sector: 'Consumer Staples' },
  { symbol: 'MCD',   sector: 'Consumer Discretionary' },
  { symbol: 'AMD',   sector: 'Information Technology' },
  { symbol: 'AMAT',  sector: 'Information Technology' },
  { symbol: 'AXON',  sector: 'Industrials' },
  { symbol: 'CRWD',  sector: 'Information Technology' },
  { symbol: 'WM',    sector: 'Industrials' },
  { symbol: 'BAC',   sector: 'Financials' },
  { symbol: 'AMZN',  sector: 'Consumer Discretionary' },
  { symbol: 'AVGO',  sector: 'Information Technology' },
  { symbol: 'NFLX',  sector: 'Communication Services' },
  { symbol: 'CRM',   sector: 'Information Technology' },
  { symbol: 'ADBE',  sector: 'Information Technology' },
];

async function loadUniverse() {
  try {
    const store = getStore(UNIVERSE_STORE);
    const cached = await store.get(UNIVERSE_KEY, { type: 'json' });
    if (Array.isArray(cached?.tickers) && cached.tickers.length > 0) {
      return cached.tickers;
    }
  } catch { /* fall through */ }
  console.warn('[screen.mjs] universe blob missing — using fallback list');
  return FALLBACK_UNIVERSE;
}

// Default cap on universe size to stay inside Netlify's 10-second function
// timeout. Empirically Schwab /quotes calls with 100+ symbols can stretch
// past 4s on this account, so we keep universes small and the Schwab batch
// size tiny (50) to maximize parallelism within Lambda's network stack.
const UNIVERSE_CAPS = {
  small:   100,
  medium:  200,
  large:   400,
  full:   2000,
};

// Schwab /quotes officially supports 500 symbols/call but in practice the
// response time scales sharply past ~50 symbols on this account. Smaller
// batches let us run more parallel requests with predictable latencies.
const SCHWAB_BATCH_SIZE = 50;

// Hard ceiling on total handler work. Netlify's function timeout is 10s; we
// reserve 1.5s of headroom for response serialization and edge processing.
const HANDLER_DEADLINE_MS = 8500;
const FMP_BATCH_SIZE = 100;

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ── Investment profiles ───────────────────────────────────────────────────────
const PROFILES = {
  value_long: {
    pillar_weights: { fundamentals:45, momentum:10, sentiment:10, filings:25, insider:10 },
    sub_weights: {
      fundamentals: { pe:15, fcf_yield:30, roic:25, gross_margin:10, debt_equity:20 },
      momentum:     { price_position_52w:40, ma_trend:40, price_change:20 },
      sentiment:    { analyst_upside:35, recommendation:25, short_interest:15, sentiment_score:25 },
      filings:      { filing_drift:50, hedging_delta:50 },
      insider:      { insider_activity:70, insider_pct:20, inst_pct:10 },
    },
  },
  growth_mid: {
    pillar_weights: { fundamentals:30, momentum:30, sentiment:20, filings:15, insider:5 },
    sub_weights: {
      fundamentals: { pe:20, fcf_yield:20, roic:25, gross_margin:25, debt_equity:10 },
      momentum:     { price_position_52w:35, ma_trend:40, price_change:25 },
      sentiment:    { analyst_upside:35, recommendation:25, short_interest:15, sentiment_score:25 },
      filings:      { filing_drift:50, hedging_delta:50 },
      insider:      { insider_activity:70, insider_pct:20, inst_pct:10 },
    },
  },
  speculative: {
    pillar_weights: { fundamentals:10, momentum:40, sentiment:35, filings:5, insider:10 },
    sub_weights: {
      fundamentals: { pe:30, fcf_yield:20, roic:20, gross_margin:15, debt_equity:15 },
      momentum:     { price_position_52w:30, ma_trend:40, price_change:30 },
      sentiment:    { analyst_upside:30, recommendation:25, short_interest:20, sentiment_score:25 },
      filings:      { filing_drift:50, hedging_delta:50 },
      insider:      { insider_activity:70, insider_pct:20, inst_pct:10 },
    },
  },
  penny: {
    pillar_weights: { fundamentals:5, momentum:15, sentiment:70, filings:5, insider:5 },
    sub_weights: {
      fundamentals: { pe:30, fcf_yield:20, roic:20, gross_margin:15, debt_equity:15 },
      momentum:     { price_position_52w:30, ma_trend:40, price_change:30 },
      sentiment:    { analyst_upside:30, recommendation:25, short_interest:20, sentiment_score:25 },
      filings:      { filing_drift:50, hedging_delta:50 },
      insider:      { insider_activity:70, insider_pct:20, inst_pct:10 },
    },
  },
};

// ── Metric directions (+1 = higher is better, -1 = lower is better) ──────────
const METRIC_DIR = {
  pe:                -1,
  fcf_yield:          1,
  roic:               1,
  gross_margin:       1,
  debt_equity:       -1,
  price_position_52w: 1,
  ma_trend:           1,
  price_change:       1,
  analyst_upside:     1,
  short_interest:    -1,
  // recommendation: Perplexity-derived buy/hold/sell → 80/50/20 (higher = better).
  // Flipped from the legacy yahoo 1=strong-buy convention.
  recommendation:     1,
  sentiment_score:    1,  // Perplexity bullish/neutral/bearish → 80/50/20
  filing_drift:      -1,
  hedging_delta:     -1,
  insider_pct:        1,
  inst_pct:           1,
  // EDGAR Form 4 buy/sell ratio over 90 days. Already 0..100, higher = better.
  insider_activity:   1,
};

const METHODOLOGY_VERSION = '2026.06.2';
const PILLARS = ['fundamentals','momentum','sentiment','filings','insider'];

// ── Scoring engine ────────────────────────────────────────────────────────────

const safe = (v, def = null) =>
  (v == null || (typeof v === 'number' && isNaN(v))) ? def : v;

function percentileRank(value, peers) {
  if (value == null) return null;
  const valid = peers.filter(p => p != null);
  if (!valid.length) return null;
  const below = valid.filter(p => p < value).length;
  const equal = valid.filter(p => p === value).length;
  return ((below + 0.5 * equal) / valid.length) * 100;
}

function directionalScore(value, peers, direction) {
  const pct = percentileRank(value, peers);
  return pct == null ? null : (direction >= 0 ? pct : 100 - pct);
}

function rationale(score) {
  if (score == null) return 'data unavailable';
  if (score >= 80) return 'top quintile vs peers';
  if (score >= 60) return 'above peer median';
  if (score >= 40) return 'near peer median';
  if (score >= 20) return 'below peer median';
  return 'bottom quintile vs peers';
}

function normalizeWeights(weights) {
  const total = Object.values(weights).reduce((s, w) => s + (w > 0 ? w : 0), 0);
  if (!total) return Object.fromEntries(Object.keys(weights).map(k => [k, 0]));
  return Object.fromEntries(
    Object.entries(weights).map(([k, w]) => [k, w > 0 ? (w / total) * 100 : 0]),
  );
}

function scorePillar(pillar, metricsDict, universeMetrics, subWeights) {
  const normW = normalizeWeights(subWeights);
  let weightedSum = 0, weightTotal = 0;
  const contributions = [];

  for (const [key, rawW] of Object.entries(subWeights)) {
    if (!rawW || !(key in METRIC_DIR)) continue;
    const peers = universeMetrics.map(m => m[key]).filter(v => v != null);
    const value = metricsDict[key] ?? null;
    const score = directionalScore(value, peers, METRIC_DIR[key]);
    const nw    = normW[key] || 0;

    contributions.push({
      metric:    key,
      raw:       value,
      score,
      weight:    Math.round(nw * 10) / 10,
      weighted:  score != null ? Math.round(score * (nw / 100) * 10) / 10 : null,
      rationale: rationale(score),
    });

    if (score != null) {
      weightedSum += score * rawW;
      weightTotal += rawW;
    }
  }

  return {
    pillar,
    score: weightTotal > 0 ? Math.round((weightedSum / weightTotal) * 10) / 10 : 50,
    contributions,
  };
}

function scoreUniverse(survivors, profileName) {
  const prof = PROFILES[profileName] || PROFILES.growth_mid;
  const { pillar_weights, sub_weights } = prof;
  const universeMets = survivors.map(s => s.metrics);

  return survivors.map(({ ticker, metrics }) => {
    const breakdown = PILLARS.map(pillar => ({
      ...scorePillar(pillar, metrics, universeMets, sub_weights[pillar] || {}),
      weight: pillar_weights[pillar] || 0,
    }));

    const totalW    = Object.values(pillar_weights).reduce((s, w) => s + w, 0) || 1;
    const composite = Math.max(0, Math.min(100, Math.round(
      breakdown.reduce((s, bd) => s + bd.score * bd.weight, 0) / totalW,
    )));

    const pillars = Object.fromEntries(
      PILLARS.map(p => [p === 'filings' ? 'filingTone' : p,
        breakdown.find(b => b.pillar === p)?.score ?? 50]),
    );

    return { ticker, profile: profileName, composite, pillars, breakdown };
  });
}

// ── Filter constants ──────────────────────────────────────────────────────────
const CAP_RANGES = {
  sm: [3e8, 2e9], md: [2e9, 1e10], lg: [1e10, 2e11], mg: [2e11, Infinity],
};

// ── Data adapters ─────────────────────────────────────────────────────────────
function schwabFmpToMetrics(schwabEntry, fmpProfile, fmpQuote) {
  const q  = schwabEntry?.quote       || {};
  const f  = schwabEntry?.fundamental || {};
  const p  = fmpProfile               || {};
  const fq = fmpQuote                 || {};

  const cp  = safe(q.lastPrice);
  const h52 = safe(q['52WkHigh'] ?? f.highPrice52);
  const l52 = safe(q['52WkLow']  ?? f.lowPrice52);

  const pos52 = (h52 != null && l52 != null && cp != null && (h52 - l52) > 0)
    ? (cp - l52) / (h52 - l52) : null;

  const refPrice = safe(fq.price) ?? cp;
  const ma50     = safe(fq.priceAvg50);
  const ma200    = safe(fq.priceAvg200);
  const maTrend  = (refPrice && ma50 && ma200)
    ? (refPrice > ma50 && ma50 > ma200 ? 1
     : refPrice < ma50 && ma50 < ma200 ? -1 : 0)
    : null;

  const tgt       = safe(p.targetMeanPrice ?? p.priceTarget);
  const analystUp = (tgt != null && cp) ? ((tgt - cp) / cp) * 100 : null;

  const gmSchwab = safe(f.grossMarginTTM);
  const gmFmp    = (p.revenueTTM && p.grossProfitTTM)
    ? p.grossProfitTTM / p.revenueTTM : null;

  return {
    pe:                 safe(f.peRatio ?? p.pe ?? fq.pe),
    fcf_yield:          null,
    roic:               safe(f.returnOnEquity ?? p.returnOnEquity),
    gross_margin:       gmSchwab ?? gmFmp,
    debt_equity:        safe(f.debtToEquity ?? p.debtToEquity),
    price_position_52w: pos52,
    ma_trend:           maTrend,
    price_change:       safe(q.netPercentChange),
    analyst_upside:     analystUp,
    short_interest:     safe(f.shortIntToFloat),
    recommendation:     null,
    filing_drift:       null,
    hedging_delta:      null,
    insider_pct:        null,
    inst_pct:           null,
  };
}

function fmpOnlyToMetrics(profile, quote) {
  const p  = profile || {};
  const fq = quote   || {};

  const cp    = safe(fq.price);
  const h52   = safe(fq.yearHigh);
  const l52   = safe(fq.yearLow);
  const ma50  = safe(fq.priceAvg50);
  const ma200 = safe(fq.priceAvg200);

  const pos52 = (h52 != null && l52 != null && cp != null && (h52 - l52) > 0)
    ? (cp - l52) / (h52 - l52) : null;

  const maTrend = (cp && ma50 && ma200)
    ? (cp > ma50 && ma50 > ma200 ? 1 : cp < ma50 && ma50 < ma200 ? -1 : 0)
    : null;

  const tgt       = safe(p.targetMeanPrice ?? p.priceTarget);
  const analystUp = (tgt != null && cp) ? ((tgt - cp) / cp) * 100 : null;

  const gm = (p.revenueTTM && p.grossProfitTTM)
    ? p.grossProfitTTM / p.revenueTTM : null;

  return {
    pe:                 safe(p.pe ?? fq.pe),
    fcf_yield:          null,
    roic:               safe(p.returnOnEquity),
    gross_margin:       gm,
    debt_equity:        safe(p.debtToEquity ?? p.totalDebtToEquity),
    price_position_52w: pos52,
    ma_trend:           maTrend,
    price_change:       safe(fq.changesPercentage),
    analyst_upside:     analystUp,
    short_interest:     null,
    recommendation:     null,
    filing_drift:       null,
    hedging_delta:      null,
    insider_pct:        null,
    inst_pct:           null,
  };
}

// ── FMP fetch helpers ─────────────────────────────────────────────────────────
const FMP_BASE = 'https://financialmodelingprep.com/stable';

// 4s per fetch — tight enough that 2 sequential fetches stay well inside
// Netlify's 10s function timeout, leaves margin for the scoring pass.
const FETCH_TIMEOUT_MS = 4000;

// Wraps fetch with an AbortController timeout and swallows AbortError into
// a normal { ok: false } shape so callers don't have to wrap every call in
// try/catch just to handle timeouts.
async function fetchWithTimeout(url, opts = {}, ms = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    return res;
  } catch (err) {
    // Return a fake-ok=false response so callers can branch normally.
    return {
      ok: false,
      status: 0,
      statusText: err?.name === 'AbortError' ? 'timeout' : (err?.message || 'fetch failed'),
      json: async () => ({}),
      text: async () => '',
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fmpBatch(path, symbols, apiKey) {
  if (!apiKey || !symbols.length) return {};
  try {
    const url = `${FMP_BASE}/${path}?symbol=${encodeURIComponent(symbols.join(','))}&apikey=${apiKey}`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return {};
    const data = await res.json();
    const map = {};
    if (Array.isArray(data)) data.forEach(item => { if (item.symbol) map[item.symbol] = item; });
    return map;
  } catch {
    return {};
  }
}

// ── Earnings calendar ─────────────────────────────────────────────────────────
// One call covers all symbols for the next 30 days. We index by symbol and keep
// the earliest upcoming date per ticker. screen.mjs then computes
// daysToEarnings and emits a flag when < 7 days.
const EARNINGS_WINDOW_DAYS = 30;

function yyyymmdd(d) {
  return d.toISOString().slice(0, 10);
}

async function fetchEarningsMap(apiKey) {
  if (!apiKey) return {};
  try {
    const from = yyyymmdd(new Date());
    const to   = yyyymmdd(new Date(Date.now() + EARNINGS_WINDOW_DAYS * 86400_000));
    const url = `${FMP_BASE}/earnings-calendar?from=${from}&to=${to}&apikey=${apiKey}`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return {};
    const data = await res.json();
    const map = {};
    if (Array.isArray(data)) {
      for (const ev of data) {
        if (!ev?.symbol || !ev?.date) continue;
        // Keep the earliest upcoming event per ticker.
        if (!map[ev.symbol] || ev.date < map[ev.symbol]) map[ev.symbol] = ev.date;
      }
    }
    return map;
  } catch {
    return {};
  }
}

function buildEarningsFlag(dateStr) {
  if (!dateStr) return null;
  const days = Math.ceil((new Date(dateStr).getTime() - Date.now()) / 86400_000);
  if (days < 0) return null;
  if (days <= 7)  return { type: 'warn',  label: `Earnings in ${days}d` };
  if (days <= 14) return { type: 'info',  label: `Earnings ${days}d` };
  return null;  // outside actionable window
}

// ── Handler ───────────────────────────────────────────────────────────────────

async function runHandler(req) {
  const sp = new URL(req.url).searchParams;
  const debug = sp.get('debug') === '1';
  const debugLog = [];
  const t0 = Date.now();
  const mark = (step, extra = {}) => {
    if (debug) debugLog.push({ step, ms: Date.now() - t0, ...extra });
  };
  mark('start');

    const filterSector = sp.get('sector')  || '';
    const filterCap    = sp.get('cap')     || '';
    const priceMin     = parseFloat(sp.get('priceMin') || '0');
    const priceMax     = parseFloat(sp.get('priceMax') || '99999');
    const volMin       = parseFloat(sp.get('volMin')   || '0') * 1000;
    const betaMax      = parseFloat(sp.get('betaMax')  || '5');
    const peMax        = parseFloat(sp.get('peMax')    || '100');
    const profileName  = sp.get('profile') || 'growth_mid';
    const universeSize = sp.get('universeSize') || 'medium';
    const universeCap  = UNIVERSE_CAPS[universeSize] ?? UNIVERSE_CAPS.medium;

    const fmpKey = process.env.FMP_API_KEY || '';
    mark('token-start');
    const token  = await getSchwabToken();
    mark('token-done', { hasToken: !!token });

    // Load dynamic universe ({symbol, sector, name}). Sector lives in the
    // universe metadata so we can apply the sector filter BEFORE any API
    // calls — huge win at scale.
    let universeEntries = await loadUniverse();
    mark('universe-loaded', { count: universeEntries.length });
    if (filterSector) {
      universeEntries = universeEntries.filter(u => u.sector === filterSector);
    }
    // Cap universe size to stay inside Netlify's 10s timeout. The blob is
    // already sorted alphabetically so the cap is stable; for "small" /
    // "medium" we're effectively scanning A-M ish, which biases by ticker
    // alphabet — acceptable for now since the alternative is timing out.
    if (universeEntries.length > universeCap) {
      universeEntries = universeEntries.slice(0, universeCap);
    }
    if (!universeEntries.length) return Response.json([]);

    const universeSymbols = universeEntries.map(u => u.symbol);

    // Fetch the next 30-day earnings calendar in parallel with Schwab —
    // it's one HTTP call, zero added latency on the critical path.
    const earningsPromise = fetchEarningsMap(fmpKey);

    // ── Path A: Schwab + FMP ────────────────────────────────────────────────
    if (token) {
      // Batch Schwab into smaller chunks (100/call) and run in parallel —
      // single large batches were timing out at ~6s on this account.
      mark('schwab-batches-start', { batches: Math.ceil(universeSymbols.length / SCHWAB_BATCH_SIZE) });
      const schwabBatches = await Promise.all(
        chunk(universeSymbols, SCHWAB_BATCH_SIZE).map(async batch => {
          try {
            // Dropped "reference" from fields — description blobs add ~30%
            // payload bloat per ticker and we have the name via the
            // universe metadata. Cuts parse time and Lambda memory churn.
            const params = new URLSearchParams({
              symbols: batch.join(','),
              fields:  'quote,fundamental',
            });
            const res = await fetchWithTimeout(
              `https://api.schwabapi.com/marketdata/v1/quotes?${params}`,
              { headers: { Authorization: `Bearer ${token}` } },
            );
            if (!res.ok) return null;
            return await res.json();
          } catch (err) {
            // One bad batch shouldn't kill the request — return null and let
            // the rest of the batches contribute what they can.
            console.warn('[screen] schwab batch failed:', err?.message);
            return null;
          }
        }),
      );

      mark('schwab-batches-done', {
        ok:     schwabBatches.filter(b => b !== null).length,
        failed: schwabBatches.filter(b => b === null).length,
      });
      // If every batch failed, treat as Schwab outage and drop to FMP-only.
      if (schwabBatches.every(b => b === null)) {
        // fall through to Path B
      } else {
        const schwabData = Object.assign({}, ...schwabBatches.filter(Boolean));

        const presurvivors = [];
        for (const symbol of universeSymbols) {
          const entry = schwabData[symbol];
          if (!entry) continue;
          const q = entry.quote       || {};
          const f = entry.fundamental || {};

          const cp = safe(q.lastPrice, 0);
          if (!cp) continue;

          const vol  = safe(q.totalVolume, 0);
          const beta = safe(f.beta,        0);
          const mcap = safe(f.marketCap,   0);
          const pe   = safe(f.peRatio);

          if (cp   < priceMin || cp > priceMax) continue;
          if (vol  < volMin)                    continue;
          if (beta && beta > betaMax)           continue;
          if (pe   != null && pe > peMax)       continue;
          if (filterCap && CAP_RANGES[filterCap]) {
            const [lo, hi] = CAP_RANGES[filterCap];
            if (mcap < lo || mcap > hi) continue;
          }
          presurvivors.push(symbol);
        }

        mark('presurvivors', { count: presurvivors.length });
        if (!presurvivors.length) {
          return debug
            ? Response.json({ debug: debugLog, presurvivors: 0 })
            : Response.json([]);
        }

        // Cap downstream work at 100 tickers. The cache lookup stage does
        // 3 Netlify Blobs reads per ticker — at >150 tickers we exhaust
        // either the per-invocation Blobs budget or Lambda's event loop
        // and the function dies hard before our handler deadline can fire.
        // Tickers ranked by market cap (Schwab f.marketCap) so the top
        // N by size survive the cull.
        const MAX_SURVIVORS = 100;
        if (presurvivors.length > MAX_SURVIVORS) {
          presurvivors.sort((a, b) =>
            (schwabData[b]?.fundamental?.marketCap || 0) -
            (schwabData[a]?.fundamental?.marketCap || 0)
          );
          presurvivors.length = MAX_SURVIVORS;
          mark('presurvivors-capped', { count: MAX_SURVIVORS });
        }

        // Batch FMP /profile and /quote in chunks of 100 (per-call URL limit).
        const fmpChunks = chunk(presurvivors, FMP_BATCH_SIZE);
        mark('fmp-start', { chunks: fmpChunks.length });
        const [profileMaps, fmpQuoteMaps] = await Promise.all([
          Promise.all(fmpChunks.map(c => fmpBatch('profile', c, fmpKey))),
          Promise.all(fmpChunks.map(c => fmpBatch('quote',   c, fmpKey))),
        ]);
        const profileMap  = Object.assign({}, ...profileMaps);
        const fmpQuoteMap = Object.assign({}, ...fmpQuoteMaps);
        mark('fmp-done', {
          profileKeys: Object.keys(profileMap).length,
          quoteKeys:   Object.keys(fmpQuoteMap).length,
        });

        // Sector filter was already applied universe-side. No second pass needed.
        const survivors = presurvivors;
        if (!survivors.length) return Response.json([]);

        // Use the universe metadata as the name + sector fallback so we don't
        // need Schwab's heavy "reference" payload.
        const universeMeta = Object.fromEntries(
          universeEntries.map(u => [u.symbol, u]),
        );

        const scoringInput = survivors.map(sym => {
          const entry = schwabData[sym];
          const q  = entry?.quote       || {};
          const f  = entry?.fundamental || {};
          const p  = profileMap[sym]    || {};
          const fq = fmpQuoteMap[sym]   || {};
          const meta = universeMeta[sym] || {};

          const cp   = safe(q.lastPrice, 0);
          const mcap = safe(f.marketCap, 0);
          const pe   = safe(f.peRatio ?? p.pe ?? fq.pe);
          const beta = safe(f.beta);

          return {
            ticker:  sym,
            metrics: schwabFmpToMetrics(entry, p, fq),
            surface: {
              name:      safe(p.companyName ?? meta.name, sym),
              sector:    safe(p.sector ?? meta.sector, ''),
              industry:  safe(p.industry, ''),
              price:     Math.round(cp * 100) / 100,
              change:    safe(q.netPercentChange),
              pe:        pe   != null ? Math.round(pe   * 10) / 10 : null,
              marketCap: mcap,
              beta:      beta != null ? Math.round(beta * 100) / 100 : null,
              volume:    Math.round(safe(q.totalVolume, 0)),
              high52w:   safe(q['52WkHigh']),
              low52w:    safe(q['52WkLow']),
              divYield:  safe(f.divYield),
              dcf:       safe(p.dcf),
              // S&P 500 membership = Schwab Stock Slices eligible. The
              // universe blob tags each ticker with its index origin.
              index:     meta.index || null,
              slices:    meta.index === 'sp500',
            },
          };
        });

        // Warm-cache lookup in parallel: filings, research, insider Form 4s,
        // and the earnings calendar.
        const tickers = scoringInput.map(s => s.ticker);
        mark('caches-start', { tickers: tickers.length });
        const [filingCache, researchCache, insiderCache, earningsMap] = await Promise.all([
          loadFilingCache(tickers),
          loadResearchCache(tickers),
          loadInsiderCache(tickers),
          earningsPromise,
        ]);
        mark('caches-done');
        for (const s of scoringInput) {
          s.metrics = injectFilingMetrics(s.metrics, filingCache[s.ticker]);
          s.metrics = injectResearchMetrics(s.metrics, researchCache[s.ticker]);
          s.metrics = injectInsiderMetrics(s.metrics, insiderCache[s.ticker]);
        }

        mark('scoring-start');
        const scores  = scoreUniverse(scoringInput, profileName);
        mark('scoring-done');
        const payload = scoringInput.map((s, i) => {
          const nextEarnings = earningsMap[s.ticker] || null;
          const earningsFlag = buildEarningsFlag(nextEarnings);
          return {
            ticker:             s.ticker,
            ...s.surface,
            nextEarnings,
            scores:             scores[i].pillars,
            composite:          scores[i].composite,
            breakdown:          scores[i].breakdown,
            profile:            scores[i].profile,
            methodologyVersion: METHODOLOGY_VERSION,
            dataSource:         'schwab+fmp',
            flags:              earningsFlag ? [earningsFlag] : [],
            why:                `${s.surface.name} (${s.surface.sector}).`,
          };
        });
        mark('return');
        return debug
          ? Response.json({ debug: debugLog, count: payload.length })
          : Response.json(payload);
      }
      // Schwab call failed (e.g., revoked token); fall through to FMP-only.
    }

    // ── Path B: FMP-only fallback ──────────────────────────────────────────
    if (!fmpKey) {
      return Response.json({
        error: 'No data source available. Connect Schwab or set FMP_API_KEY in Netlify env.',
      }, { status: 503 });
    }

    // Sector filter already applied universe-side via loadUniverse() — only
    // pay FMP costs on the post-filter set.
    const fmpChunks = chunk(universeSymbols, FMP_BATCH_SIZE);
    const [profileMaps, fmpQuoteMaps] = await Promise.all([
      Promise.all(fmpChunks.map(c => fmpBatch('profile', c, fmpKey))),
      Promise.all(fmpChunks.map(c => fmpBatch('quote',   c, fmpKey))),
    ]);
    const profileMap  = Object.assign({}, ...profileMaps);
    const fmpQuoteMap = Object.assign({}, ...fmpQuoteMaps);
    const universeMeta = Object.fromEntries(
      universeEntries.map(u => [u.symbol, u]),
    );

    const survivors = [];
    for (const sym of universeSymbols) {
      const p  = profileMap[sym]  || {};
      const fq = fmpQuoteMap[sym] || {};
      const meta = universeMeta[sym] || {};
      const cp = safe(fq.price, 0);
      if (!cp) continue;

      const vol  = safe(fq.avgVolume ?? p.volAvg, 0);
      const beta = safe(p.beta, 0);
      const mcap = safe(p.mktCap ?? fq.marketCap, 0);
      const sec  = safe(p.sector, '');
      const pe   = safe(p.pe ?? fq.pe);

      if (filterSector && sec !== filterSector) continue;
      if (cp < priceMin || cp > priceMax)        continue;
      if (vol && vol < volMin)                    continue;
      if (beta && beta > betaMax)                 continue;
      if (pe != null && pe > peMax)               continue;
      if (filterCap && CAP_RANGES[filterCap]) {
        const [lo, hi] = CAP_RANGES[filterCap];
        if (mcap < lo || mcap > hi) continue;
      }

      survivors.push({
        ticker:  sym,
        metrics: fmpOnlyToMetrics(p, fq),
        surface: {
          name:      safe(p.companyName ?? meta.name, sym),
          sector:    sec || safe(meta.sector, ''),
          industry:  safe(p.industry, ''),
          price:     Math.round(cp * 100) / 100,
          change:    safe(fq.changesPercentage),
          pe:        pe != null ? Math.round(pe * 10) / 10 : null,
          marketCap: mcap,
          beta:      beta ? Math.round(beta * 100) / 100 : null,
          volume:    Math.round(vol),
          high52w:   safe(fq.yearHigh),
          low52w:    safe(fq.yearLow),
          divYield:  safe(p.lastDiv),
          dcf:       safe(p.dcf),
          index:     meta.index || null,
          slices:    meta.index === 'sp500',
        },
      });
    }

    if (!survivors.length) return Response.json([]);

    const tickers = survivors.map(s => s.ticker);
    const [filingCache, researchCache, insiderCache, earningsMap] = await Promise.all([
      loadFilingCache(tickers),
      loadResearchCache(tickers),
      loadInsiderCache(tickers),
      earningsPromise,
    ]);
    for (const s of survivors) {
      s.metrics = injectFilingMetrics(s.metrics, filingCache[s.ticker]);
      s.metrics = injectResearchMetrics(s.metrics, researchCache[s.ticker]);
      s.metrics = injectInsiderMetrics(s.metrics, insiderCache[s.ticker]);
    }

    const scores = scoreUniverse(survivors, profileName);
    return Response.json(survivors.map((s, i) => {
      const nextEarnings = earningsMap[s.ticker] || null;
      const earningsFlag = buildEarningsFlag(nextEarnings);
      return {
        ticker:             s.ticker,
        ...s.surface,
        nextEarnings,
        scores:             scores[i].pillars,
        composite:          scores[i].composite,
        breakdown:          scores[i].breakdown,
        profile:            scores[i].profile,
        methodologyVersion: METHODOLOGY_VERSION,
        dataSource:         'fmp',
        flags:              earningsFlag ? [earningsFlag] : [],
        why:                `${s.surface.name} (${s.surface.sector}).`,
      };
    }));
}

// Wrap runHandler in a deadline + top-level catch so a hung upstream can't
// turn into Netlify's generic HTML 502. We ALWAYS return JSON, even if
// degraded. The deadline is set just under Netlify's 10s function timeout.
export default async (req) => {
  let timeoutHandle;
  const deadline = new Promise(resolve => {
    timeoutHandle = setTimeout(() => {
      resolve(Response.json({
        error: 'screen deadline exceeded',
        detail: `Upstream data sources did not respond within ${HANDLER_DEADLINE_MS}ms. ` +
                'Try a smaller universeSize or narrower filters.',
      }, { status: 504 }));
    }, HANDLER_DEADLINE_MS);
  });

  const work = (async () => {
    try {
      return await runHandler(req);
    } catch (err) {
      return Response.json(
        { error: err?.message || 'internal error', stack: err?.stack },
        { status: 500 },
      );
    }
  })();

  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timeoutHandle);
  }
};
