/**
 * Netlify serverless function — 10-K filing-tone NLP score.
 *
 * Ported from backend/filings/{score,parse,drift,hedging,edgar}.py.
 * Same outputs, same shape, same methodology version. Internal mechanics
 * (HTML extraction, TF-IDF cosine, hedging lexicon) are 1:1 ports.
 *
 * GET /api/filings/{ticker}            → cached (30d) or fresh
 * GET /api/filings/{ticker}?refresh=1  → bypass cache, re-fetch from EDGAR
 *
 * Result cached in Netlify Blobs (store "filing-scores") so screen.mjs can
 * pick it up. cache-filing.mjs is the cross-write helper for FilingPanel.jsx,
 * but the live endpoint also writes here directly when fresh.
 */
import { getStore } from '@netlify/blobs';
import {
  cikForTicker, fetchSubmissions, pickRecentFilings, fetchFilingText,
} from './shared/edgar.mjs';

const METHODOLOGY_VERSION = '2026.06.2';
const STORE_NAME = 'filing-scores';
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CORS = { 'Access-Control-Allow-Origin': '*' };

// ── Tokenization & stopwords (mirror backend/filings/drift.py) ───────────────
const STOPWORDS = new Set((
  'a an and are as at be been being but by can do does for from had has have ' +
  'he her him his how i in is it its like may might more most no nor not of ' +
  'on or other our she so some such than that the their them then there these ' +
  'they this those to too up was we were what when where which while who whom ' +
  'why will with would you your yours including such would shall'
).split(/\s+/));

const WORD_RE = /[a-z]{2,}/g;

function tokenize(text) {
  if (!text) return [];
  const out = [];
  let m;
  const lower = text.toLowerCase();
  WORD_RE.lastIndex = 0;
  while ((m = WORD_RE.exec(lower)) !== null) {
    if (!STOPWORDS.has(m[0])) out.push(m[0]);
  }
  return out;
}

function termFrequency(tokens) {
  if (!tokens.length) return new Map();
  const counts = new Map();
  for (const t of tokens) counts.set(t, (counts.get(t) || 0) + 1);
  const total = tokens.length;
  const tf = new Map();
  for (const [term, c] of counts) tf.set(term, c / total);
  return tf;
}

function inverseDocumentFrequency(docs) {
  // Smoothed IDF: log((1+n)/(1+df)) + 1
  const n = docs.length;
  const df = new Map();
  for (const doc of docs) {
    for (const term of new Set(doc)) df.set(term, (df.get(term) || 0) + 1);
  }
  const idf = new Map();
  for (const [term, count] of df) {
    idf.set(term, Math.log((1 + n) / (1 + count)) + 1);
  }
  return idf;
}

function tfidfVector(tokens, idf) {
  const tf = termFrequency(tokens);
  const vec = new Map();
  for (const [term, w] of tf) vec.set(term, w * (idf.get(term) || 0));
  return vec;
}

function cosine(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let dot = 0;
  // iterate the smaller map for the dot product
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  for (const [term, v] of small) {
    const w = large.get(term);
    if (w !== undefined) dot += v * w;
  }
  let na = 0, nb = 0;
  for (const v of a.values()) na += v * v;
  for (const v of b.values()) nb += v * v;
  na = Math.sqrt(na); nb = Math.sqrt(nb);
  if (na === 0 || nb === 0) return 0;
  return dot / (na * nb);
}

function driftScore(textA, textB) {
  const ta = tokenize(textA), tb = tokenize(textB);
  if (!ta.length || !tb.length) return 0;
  const idf = inverseDocumentFrequency([ta, tb]);
  const vecA = tfidfVector(ta, idf);
  const vecB = tfidfVector(tb, idf);
  const sim = cosine(vecA, vecB);
  return Math.round((1 - sim) * 100 * 10) / 10;
}

// ── Hedging lexicon (mirror backend/filings/hedging.py) ──────────────────────
const HEDGING_TERMS = [
  'no assurance can be given', 'no assurance', 'we cannot predict',
  'we cannot assure', 'we may not', 'we might not', 'subject to',
  'depends on', 'dependent on', 'could adversely affect', 'could materially',
  'may adversely affect', 'may materially', 'if we are unable',
  'we are unable', 'are uncertain', 'uncertain', 'uncertainty',
  'uncertainties', 'potentially', 'potential', 'anticipate', 'anticipates',
  'anticipated', 'believe', 'believes', 'expect', 'expects', 'intend',
  'intends', 'may be', 'might be', 'could be', 'should be',
  'we may', 'we might', 'we could', 'we should',
  'estimate', 'estimates', 'estimated', 'approximate', 'approximately',
  'possibly', 'perhaps', 'no guarantee', 'if any',
];

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Pre-compile one big alternation so we scan the doc once per call.
const HEDGING_PATTERN = new RegExp(
  '\\b(' + HEDGING_TERMS.map(escapeRegex).join('|') + ')\\b',
  'gi',
);
const WORD_COUNT_RE = /\b\w+\b/g;

function hedgingFrequency(text) {
  if (!text) return 0;
  const lower = text.toLowerCase();
  const words = (lower.match(WORD_COUNT_RE) || []).length;
  if (!words) return 0;
  const hits = (lower.match(HEDGING_PATTERN) || []).length;
  return Math.round((hits / words) * 1000 * 100) / 100;
}

function hedgingDelta(textCurrent, textPrior) {
  const cur = hedgingFrequency(textCurrent);
  const prior = hedgingFrequency(textPrior);
  if (prior <= 0) return cur <= 0 ? 0 : 1.0;
  return Math.round(((cur - prior) / prior) * 1000) / 1000;
}

// ── HTML → text + section extraction (mirror parse.py) ──────────────────────
const TAG_RE = /<[^>]+>/g;
const SCRIPT_STYLE_RE = /<(script|style)[^>]*>[\s\S]*?<\/\1>/gi;
const PAGE_NOISE_RE = /\bTable of Contents\b|^\s*\d+\s*$/gm;
const WS_RE = /\s+/g;

const ENTITY_MAP = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

function decodeEntities(s) {
  return s
    .replace(/&([a-zA-Z]+);/g, (m, name) => ENTITY_MAP[name] ?? m)
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(parseInt(n, 10)));
}

function htmlToText(html) {
  let cleaned = String(html || '')
    .replace(SCRIPT_STYLE_RE, ' ')
    .replace(TAG_RE, ' ');
  cleaned = decodeEntities(cleaned);
  cleaned = cleaned.replace(PAGE_NOISE_RE, ' ');
  return cleaned.replace(WS_RE, ' ').trim();
}

const ITEM_HEADERS = [
  'ITEM 1.',  'ITEM 1A.', 'ITEM 1B.', 'ITEM 1C.', 'ITEM 2.', 'ITEM 3.',
  'ITEM 4.',  'ITEM 5.',  'ITEM 6.',  'ITEM 7.',  'ITEM 7A.',
  'ITEM 8.',  'ITEM 9.',  'ITEM 9A.', 'ITEM 9B.',
  'ITEM 10.', 'ITEM 11.', 'ITEM 12.', 'ITEM 13.', 'ITEM 14.', 'ITEM 15.', 'ITEM 16.',
  'PART I',   'PART II',  'PART III', 'PART IV',
];

function headerPattern(label) {
  const stripped = label.replace(/\.$/, '').trim().toUpperCase();
  const parts = stripped.split(/\s+/);
  if (!parts.length) return null;
  if (parts[0] === 'ITEM' && parts.length >= 2) {
    return new RegExp(`\\bITEM\\s+${escapeRegex(parts[1])}\\b\\s*\\.?`, 'g');
  }
  if (parts[0] === 'PART' && parts.length >= 2) {
    return new RegExp(`\\bPART\\s+${escapeRegex(parts[1])}\\b`, 'g');
  }
  return new RegExp('\\b' + escapeRegex(stripped) + '\\b', 'g');
}

function findSection(text, startLabel) {
  const upper = text.toUpperCase();
  const startPat = headerPattern(startLabel);
  if (!startPat) return null;

  // Find the latest occurrence (skip the ToC entry — body comes later).
  let latest = -1;
  let m;
  startPat.lastIndex = 0;
  while ((m = startPat.exec(upper)) !== null) latest = m.index;
  if (latest < 0) return null;

  // Find the closest next header that isn't the same one.
  let end = text.length;
  for (const header of ITEM_HEADERS) {
    if (header === startLabel) continue;
    const hPat = headerPattern(header);
    if (!hPat) continue;
    hPat.lastIndex = 0;
    let hm;
    while ((hm = hPat.exec(upper)) !== null) {
      if (hm.index > latest + 20 && hm.index < end) {
        end = hm.index;
        break;
      }
    }
  }
  return [latest, end];
}

function extractSection(rawText, itemLabel) {
  const isHtml = rawText.slice(0, 200).includes('<');
  const text = isHtml ? htmlToText(rawText) : rawText;
  const span = findSection(text, itemLabel.toUpperCase());
  if (!span) return '';
  return text.slice(span[0], span[1]).trim();
}

const extractRiskFactors = (html) => extractSection(html, 'ITEM 1A.');
const extractMda         = (html) => extractSection(html, 'ITEM 7.');

// ── Composite score (mirror score.py) ────────────────────────────────────────

function composeScore(riskDrift, mdaDrift, hedgingDeltaVal) {
  const base = 70.0;
  const drifts = [riskDrift, mdaDrift].filter(d => d != null);
  const driftAvg = drifts.length ? drifts.reduce((s, v) => s + v, 0) / drifts.length : 0;
  const driftPenalty = driftAvg * 0.30;                                // 100% drift → -30 pts
  const hedgingPenalty = Math.max(0, hedgingDeltaVal || 0) * 30;       // +50% hedging → -15 pts
  let score = base - driftPenalty - hedgingPenalty;
  if (score < 0)   score = 0;
  if (score > 100) score = 100;
  return Math.round(score * 10) / 10;
}

function emptyResult(ticker, error) {
  return {
    ticker,
    score: 50.0,
    risk_drift: null, mda_drift: null,
    hedging_freq_current: null, hedging_freq_prior: null, hedging_delta: null,
    current_filing: null, prior_filing: null,
    methodology_version: METHODOLOGY_VERSION,
    timestamp: new Date().toISOString(),
    error,
  };
}

function metaToDict(meta) {
  return {
    cik:           meta.cik,
    accession:     meta.accession,
    primaryDoc:    meta.primary_doc,
    filingDate:    meta.filing_date,
    fiscalYearEnd: meta.fiscal_year_end,
    url:           meta.url,
  };
}

// ── Orchestration ───────────────────────────────────────────────────────────

async function compute(ticker, { forceRefresh = false } = {}) {
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
    } catch { /* fall through */ }
  }

  const cik = await cikForTicker(ticker);
  if (!cik) return emptyResult(ticker, 'ticker not in EDGAR CIK table');

  let submissions;
  try { submissions = await fetchSubmissions(cik); }
  catch (e) { return emptyResult(ticker, `submissions fetch failed: ${e.message}`); }

  const filings = pickRecentFilings(submissions, '10-K', 2);
  if (filings.length === 0) return emptyResult(ticker, 'no 10-K filings found');

  if (filings.length === 1) {
    const single = {
      ticker, score: 60.0,
      risk_drift: null, mda_drift: null,
      hedging_freq_current: null, hedging_freq_prior: null, hedging_delta: null,
      current_filing: metaToDict(filings[0]),
      prior_filing: null,
      methodology_version: METHODOLOGY_VERSION,
      timestamp: new Date().toISOString(),
      error: 'only one 10-K on file; YoY drift unmeasurable',
    };
    await writeCache(store, ticker, single);
    return single;
  }

  const [current, prior] = filings;
  let currentHtml, priorHtml;
  try {
    [currentHtml, priorHtml] = await Promise.all([
      fetchFilingText(current),
      fetchFilingText(prior),
    ]);
  } catch (e) {
    return emptyResult(ticker, `EDGAR fetch failed: ${e.message}`);
  }

  const riskCur = extractRiskFactors(currentHtml);
  const riskPri = extractRiskFactors(priorHtml);
  const mdaCur  = extractMda(currentHtml);
  const mdaPri  = extractMda(priorHtml);

  const riskD = (riskCur && riskPri) ? driftScore(riskCur, riskPri) : null;
  const mdaD  = (mdaCur  && mdaPri)  ? driftScore(mdaCur,  mdaPri)  : null;

  const fullCur = (riskCur + ' ' + mdaCur).trim();
  const fullPri = (riskPri + ' ' + mdaPri).trim();
  const hCur = fullCur ? hedgingFrequency(fullCur) : null;
  const hPri = fullPri ? hedgingFrequency(fullPri) : null;
  const hDelta = (fullCur && fullPri) ? hedgingDelta(fullCur, fullPri) : null;

  const score = composeScore(riskD, mdaD, hDelta);

  const result = {
    ticker,
    score,
    risk_drift:           riskD,
    mda_drift:            mdaD,
    hedging_freq_current: hCur,
    hedging_freq_prior:   hPri,
    hedging_delta:        hDelta,
    current_filing:       metaToDict(current),
    prior_filing:         metaToDict(prior),
    methodology_version:  METHODOLOGY_VERSION,
    timestamp:            new Date().toISOString(),
    error:                null,
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

// ── Handler ─────────────────────────────────────────────────────────────────

function tickerFromPath(url) {
  const parts = new URL(url).pathname.split('/').filter(Boolean);
  return (parts[parts.length - 1] || '').toUpperCase();
}

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const ticker = tickerFromPath(req.url);
  if (!ticker || ticker === 'FILINGS') {
    return Response.json({ error: 'ticker required' }, { status: 400, headers: CORS });
  }

  const refresh = new URL(req.url).searchParams.get('refresh') === '1';

  try {
    const result = await compute(ticker, { forceRefresh: refresh });
    return Response.json(result, { headers: CORS });
  } catch (err) {
    return Response.json(
      { error: err.message, stack: err.stack },
      { status: 502, headers: CORS },
    );
  }
};
