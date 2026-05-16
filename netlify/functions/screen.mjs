/**
 * Netlify serverless function — stock screening + peer-normalized scoring.
 *
 * Replaces screen.py (Python functions are not supported in Netlify's
 * current runtime). Uses yahoo-finance2 for market data — all 25 tickers
 * fetched in parallel via Promise.allSettled (~200 ms wall time vs the
 * Python serial approach that exceeded the 10-second timeout).
 */
import yahooFinance from 'yahoo-finance2';

// Suppress schema-validation noise (some fields vary by ticker type / region)
yahooFinance.setGlobalConfig({ validation: { logErrors: false } });

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
  recommendation:    -1,  // 1=strong buy … 5=sell; lower mean is better
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

    // Keep legacy flat key shape the frontend's Portfolio / Signals tabs expect
    const pillars = Object.fromEntries(
      PILLARS.map(p => [p === 'filings' ? 'filingTone' : p,
        breakdown.find(b => b.pillar === p)?.score ?? 50]),
    );

    return { ticker, profile: profileName, composite, pillars, breakdown };
  });
}

// ── Data adapter ──────────────────────────────────────────────────────────────
function toMetrics(priceData, finData, statsData, detailData) {
  const cp   = safe(priceData?.regularMarketPrice);
  const h52  = safe(priceData?.fiftyTwoWeekHigh);
  const l52  = safe(priceData?.fiftyTwoWeekLow);
  const ma50 = safe(detailData?.fiftyDayAverage  ?? statsData?.fiftyDayAverage);
  const ma200= safe(detailData?.twoHundredDayAverage ?? statsData?.twoHundredDayAverage);
  const fcf  = safe(finData?.freeCashflow);
  const mcap = safe(priceData?.marketCap);
  const tgt  = safe(finData?.targetMeanPrice);

  const pos52 = (h52 != null && l52 != null && cp != null && (h52 - l52) > 0)
    ? (cp - l52) / (h52 - l52) : null;

  const maTrend = (cp && ma50 && ma200)
    ? (cp > ma50 && ma50 > ma200 ? 1 : cp < ma50 && ma50 < ma200 ? -1 : 0)
    : null;

  return {
    pe:                safe(priceData?.trailingPE ?? detailData?.trailingPE),
    fcf_yield:         (fcf != null && mcap) ? fcf / mcap : null,
    roic:              safe(finData?.returnOnEquity),
    gross_margin:      safe(finData?.grossMargins),
    debt_equity:       safe(finData?.debtToEquity),
    price_position_52w: pos52,
    ma_trend:          maTrend,
    price_change:      safe(priceData?.regularMarketChangePercent),
    analyst_upside:    (tgt != null && cp) ? ((tgt - cp) / cp) * 100 : null,
    short_interest:    safe(statsData?.shortPercentOfFloat),
    recommendation:    safe(finData?.recommendationMean),
    filing_drift:      null,
    hedging_delta:     null,
    insider_pct:       safe(statsData?.heldPercentInsiders),
    inst_pct:          safe(statsData?.heldPercentInstitutions),
  };
}

// ── Filter constants ──────────────────────────────────────────────────────────
const CAP_RANGES = {
  sm: [3e8, 2e9], md: [2e9, 1e10], lg: [1e10, 2e11], mg: [2e11, Infinity],
};

// ── Handler ───────────────────────────────────────────────────────────────────
export default async (req) => {
  try {
    const sp = new URL(req.url).searchParams;

    const filterSector = sp.get('sector')  || '';
    const filterCap    = sp.get('cap')     || '';
    const peMax        = parseFloat(sp.get('peMax')    || '100');
    const priceMin     = parseFloat(sp.get('priceMin') || '0');
    const priceMax     = parseFloat(sp.get('priceMax') || '99999');
    const volMin       = parseFloat(sp.get('volMin')   || '0') * 1000;
    const betaMax      = parseFloat(sp.get('betaMax')  || '5');
    const profileName  = sp.get('profile') || 'growth_mid';

    // Fetch all tickers in parallel — wall time ≈ slowest single request (~300 ms)
    const fetched = await Promise.allSettled(
      UNIVERSE.map(symbol =>
        yahooFinance.quoteSummary(symbol, {
          modules: ['price','financialData','defaultKeyStatistics',
                    'summaryProfile','summaryDetail'],
        }).then(data => ({ symbol, data })),
      ),
    );

    // Pass-1 filter
    const survivors = [];
    for (const result of fetched) {
      if (result.status !== 'fulfilled') continue;
      const { symbol, data } = result.value;

      const priceData  = data.price                || {};
      const finData    = data.financialData        || {};
      const statsData  = data.defaultKeyStatistics || {};
      const profData   = data.summaryProfile       || {};
      const detailData = data.summaryDetail        || {};

      const cp   = safe(priceData.regularMarketPrice, 0);
      if (!cp) continue;

      const vol  = safe(priceData.regularMarketVolume, 0);
      const beta = safe(priceData.beta ?? detailData.beta, 0);
      const mcap = safe(priceData.marketCap, 0);
      const sec  = safe(profData.sector || priceData.sector, '');
      const pe   = safe(priceData.trailingPE ?? detailData.trailingPE);

      if (filterSector && sec !== filterSector) continue;
      if (cp < priceMin || cp > priceMax)        continue;
      if (vol < volMin)                           continue;
      if (beta && beta > betaMax)                 continue;
      if (filterCap && CAP_RANGES[filterCap]) {
        const [lo, hi] = CAP_RANGES[filterCap];
        if (mcap < lo || mcap > hi) continue;
      }

      survivors.push({
        ticker:  symbol,
        metrics: toMetrics(priceData, finData, statsData, detailData),
        surface: {
          name:      safe(priceData.longName || priceData.shortName, symbol),
          sector:    sec,
          industry:  safe(profData.industry, ''),
          price:     Math.round(cp * 100) / 100,
          change:    safe(priceData.regularMarketChangePercent),
          pe:        pe != null ? Math.round(pe * 10) / 10 : null,
          marketCap: mcap,
          beta:      beta ? Math.round(beta * 100) / 100 : null,
          volume:    Math.round(vol),
          high52w:   safe(priceData.fiftyTwoWeekHigh),
          low52w:    safe(priceData.fiftyTwoWeekLow),
          divYield:  safe(detailData.dividendYield ?? priceData.dividendYield),
          dcf:       null,
        },
      });
    }

    if (!survivors.length) return Response.json([]);

    // Pass-2 peer-percentile scoring
    const scores  = scoreUniverse(survivors, profileName);
    const results = survivors.map((s, i) => ({
      ticker:             s.ticker,
      ...s.surface,
      scores:             scores[i].pillars,
      composite:          scores[i].composite,
      breakdown:          scores[i].breakdown,
      profile:            scores[i].profile,
      methodologyVersion: METHODOLOGY_VERSION,
      flags:              [],
      why:                `${s.surface.name} (${s.surface.sector}).`,
    }));

    return Response.json(results);

  } catch (err) {
    return Response.json({ error: err.message, stack: err.stack }, { status: 500 });
  }
};
