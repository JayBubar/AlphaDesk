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

// ── Universe ──────────────────────────────────────────────────────────────────
const UNIVERSE = [
  'MSFT','AAPL','GOOGL','NVDA','META',
  'UNH', 'JPM', 'LLY',  'V',   'PG',
  'KO',  'COST','WMT',  'MCD', 'AMD',
  'AMAT','AXON','CRWD', 'WM',  'BAC',
  'AMZN','AVGO','NFLX', 'CRM', 'ADBE',
];

// ── Investment profiles ───────────────────────────────────────────────────────
const PROFILES = {
  value_long: {
    pillar_weights: { fundamentals:45, momentum:10, sentiment:10, filings:25, insider:10 },
    sub_weights: {
      fundamentals: { pe:15, fcf_yield:30, roic:25, gross_margin:10, debt_equity:20 },
      momentum:     { price_position_52w:40, ma_trend:40, price_change:20 },
      sentiment:    { analyst_upside:50, recommendation:30, short_interest:20 },
      filings:      { filing_drift:50, hedging_delta:50 },
      insider:      { insider_pct:60, inst_pct:40 },
    },
  },
  growth_mid: {
    pillar_weights: { fundamentals:30, momentum:30, sentiment:20, filings:15, insider:5 },
    sub_weights: {
      fundamentals: { pe:20, fcf_yield:20, roic:25, gross_margin:25, debt_equity:10 },
      momentum:     { price_position_52w:35, ma_trend:40, price_change:25 },
      sentiment:    { analyst_upside:50, recommendation:30, short_interest:20 },
      filings:      { filing_drift:50, hedging_delta:50 },
      insider:      { insider_pct:60, inst_pct:40 },
    },
  },
  speculative: {
    pillar_weights: { fundamentals:10, momentum:40, sentiment:35, filings:5, insider:10 },
    sub_weights: {
      fundamentals: { pe:30, fcf_yield:20, roic:20, gross_margin:15, debt_equity:15 },
      momentum:     { price_position_52w:30, ma_trend:40, price_change:30 },
      sentiment:    { analyst_upside:40, recommendation:30, short_interest:30 },
      filings:      { filing_drift:50, hedging_delta:50 },
      insider:      { insider_pct:60, inst_pct:40 },
    },
  },
  penny: {
    pillar_weights: { fundamentals:5, momentum:15, sentiment:70, filings:5, insider:5 },
    sub_weights: {
      fundamentals: { pe:30, fcf_yield:20, roic:20, gross_margin:15, debt_equity:15 },
      momentum:     { price_position_52w:30, ma_trend:40, price_change:30 },
      sentiment:    { analyst_upside:40, recommendation:30, short_interest:30 },
      filings:      { filing_drift:50, hedging_delta:50 },
      insider:      { insider_pct:60, inst_pct:40 },
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
  recommendation:    -1,
  filing_drift:      -1,
  hedging_delta:     -1,
  insider_pct:        1,
  inst_pct:           1,
};

const METHODOLOGY_VERSION = '2026.05.1';
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

async function fmpBatch(path, symbols, apiKey) {
  if (!apiKey || !symbols.length) return {};
  try {
    const url = `${FMP_BASE}/${path}?symbol=${encodeURIComponent(symbols.join(','))}&apikey=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) return {};
    const data = await res.json();
    const map = {};
    if (Array.isArray(data)) data.forEach(item => { if (item.symbol) map[item.symbol] = item; });
    return map;
  } catch {
    return {};
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async (req) => {
  try {
    const sp = new URL(req.url).searchParams;

    const filterSector = sp.get('sector')  || '';
    const filterCap    = sp.get('cap')     || '';
    const priceMin     = parseFloat(sp.get('priceMin') || '0');
    const priceMax     = parseFloat(sp.get('priceMax') || '99999');
    const volMin       = parseFloat(sp.get('volMin')   || '0') * 1000;
    const betaMax      = parseFloat(sp.get('betaMax')  || '5');
    const peMax        = parseFloat(sp.get('peMax')    || '100');
    const profileName  = sp.get('profile') || 'growth_mid';

    const fmpKey = process.env.FMP_API_KEY || '';
    const token  = await getSchwabToken();

    // ── Path A: Schwab + FMP ────────────────────────────────────────────────
    if (token) {
      const params = new URLSearchParams({
        symbols: UNIVERSE.join(','),
        fields:  'quote,fundamental,reference',
      });
      const schwabRes = await fetch(
        `https://api.schwabapi.com/marketdata/v1/quotes?${params}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );

      if (schwabRes.ok) {
        const schwabData = await schwabRes.json();

        const presurvivors = [];
        for (const symbol of UNIVERSE) {
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

        if (!presurvivors.length) return Response.json([]);

        const [profileMap, fmpQuoteMap] = await Promise.all([
          fmpBatch('profile', presurvivors, fmpKey),
          fmpBatch('quote',   presurvivors, fmpKey),
        ]);

        const survivors = presurvivors.filter(sym => {
          if (!filterSector) return true;
          return (profileMap[sym]?.sector || '') === filterSector;
        });
        if (!survivors.length) return Response.json([]);

        const scoringInput = survivors.map(sym => {
          const entry = schwabData[sym];
          const q  = entry?.quote       || {};
          const f  = entry?.fundamental || {};
          const r  = entry?.reference   || {};
          const p  = profileMap[sym]    || {};
          const fq = fmpQuoteMap[sym]   || {};

          const cp   = safe(q.lastPrice, 0);
          const mcap = safe(f.marketCap, 0);
          const pe   = safe(f.peRatio ?? p.pe ?? fq.pe);
          const beta = safe(f.beta);

          return {
            ticker:  sym,
            metrics: schwabFmpToMetrics(entry, p, fq),
            surface: {
              name:      safe(p.companyName ?? r.description, sym),
              sector:    safe(p.sector,   ''),
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
            },
          };
        });

        // Warm-cache lookup: inject filing_drift / hedging_delta if FilingPanel
        // has previously fetched this ticker's 10-K within the TTL window.
        const filingCache = await loadFilingCache(scoringInput.map(s => s.ticker));
        for (const s of scoringInput) {
          s.metrics = injectFilingMetrics(s.metrics, filingCache[s.ticker]);
        }

        const scores  = scoreUniverse(scoringInput, profileName);
        return Response.json(scoringInput.map((s, i) => ({
          ticker:             s.ticker,
          ...s.surface,
          scores:             scores[i].pillars,
          composite:          scores[i].composite,
          breakdown:          scores[i].breakdown,
          profile:            scores[i].profile,
          methodologyVersion: METHODOLOGY_VERSION,
          dataSource:         'schwab+fmp',
          flags:              [],
          why:                `${s.surface.name} (${s.surface.sector}).`,
        })));
      }
      // Schwab call failed (e.g., revoked token); fall through to FMP-only.
    }

    // ── Path B: FMP-only fallback ──────────────────────────────────────────
    if (!fmpKey) {
      return Response.json({
        error: 'No data source available. Connect Schwab or set FMP_API_KEY in Netlify env.',
      }, { status: 503 });
    }

    const [profileMap, fmpQuoteMap] = await Promise.all([
      fmpBatch('profile', UNIVERSE, fmpKey),
      fmpBatch('quote',   UNIVERSE, fmpKey),
    ]);

    const survivors = [];
    for (const sym of UNIVERSE) {
      const p  = profileMap[sym]  || {};
      const fq = fmpQuoteMap[sym] || {};
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
          name:      safe(p.companyName, sym),
          sector:    sec,
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
        },
      });
    }

    if (!survivors.length) return Response.json([]);

    const filingCache = await loadFilingCache(survivors.map(s => s.ticker));
    for (const s of survivors) {
      s.metrics = injectFilingMetrics(s.metrics, filingCache[s.ticker]);
    }

    const scores = scoreUniverse(survivors, profileName);
    return Response.json(survivors.map((s, i) => ({
      ticker:             s.ticker,
      ...s.surface,
      scores:             scores[i].pillars,
      composite:          scores[i].composite,
      breakdown:          scores[i].breakdown,
      profile:            scores[i].profile,
      methodologyVersion: METHODOLOGY_VERSION,
      dataSource:         'fmp',
      flags:              [],
      why:                `${s.surface.name} (${s.surface.sector}).`,
    })));

  } catch (err) {
    return Response.json({ error: err.message, stack: err.stack }, { status: 500 });
  }
};
