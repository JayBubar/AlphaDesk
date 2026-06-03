/**
 * Shared SEC EDGAR client for Netlify functions (filings, insider, etc.).
 *
 * Ported from backend/filings/edgar.py. Same throttle (~9 req/sec), same
 * required User-Agent, same logical caches — but the disk-backed cache is
 * replaced with Netlify Blobs because functions are stateless across cold
 * starts.
 *
 * What's cached in Blobs:
 *   - CIK lookup table (~500KB, refreshed every 30 days). Avoids a 500KB
 *     download on every invocation.
 *   - Per-CIK submissions index (24h TTL). Avoids hammering data.sec.gov
 *     when the same ticker is hit multiple times in quick succession.
 *
 * What's NOT cached: filing HTMLs. They're large and only fetched 2x per
 * filings analysis. Each caller (filings.mjs, insider.mjs) caches its own
 * scored output instead.
 */
import { getStore } from '@netlify/blobs';

export const SEC_USER_AGENT = 'AlphaDesk research@alphadesk.app';
export const EDGAR_BASE = 'https://www.sec.gov';
export const EDGAR_DATA = 'https://data.sec.gov';

const CIK_BLOB_STORE = 'edgar-cache';
const CIK_BLOB_KEY   = 'cik_table';
const CIK_TTL_MS     = 30 * 24 * 60 * 60 * 1000;

const SUBMISSIONS_BLOB_STORE = 'edgar-cache';
const SUBMISSIONS_TTL_MS     = 24 * 60 * 60 * 1000;

// ── Throttle ───────────────────────────────────────────────────────────────
// Per-invocation only (function instances are short-lived). Multiple
// concurrent invocations could collectively exceed 10/sec, but each
// individual function makes few EDGAR calls so the steady-state load is low.
const MIN_INTERVAL_MS = 110;  // ~9 req/sec, comfortably under SEC's 10/sec cap
let lastCallAt = 0;

async function throttle() {
  const now = Date.now();
  const wait = MIN_INTERVAL_MS - (now - lastCallAt);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCallAt = Date.now();
}

function hostFor(url) {
  return url.startsWith(EDGAR_DATA) ? 'data.sec.gov' : 'www.sec.gov';
}

/**
 * Throttled EDGAR HTTPS fetch. Returns the Response — caller decides whether
 * to read as JSON, text, or buffer. Throws on non-2xx so callers can decide
 * whether to swallow or surface the error.
 */
export async function edgarGet(url, { timeoutMs = 15000 } = {}) {
  await throttle();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent':    SEC_USER_AGENT,
        'Accept':        '*/*',
        'Host':          hostFor(url),
      },
    });
    if (!res.ok) {
      throw new Error(`EDGAR ${res.status} ${res.statusText}: ${url}`);
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// ── CIK lookup ─────────────────────────────────────────────────────────────

/**
 * Returns { TICKER: '0000320193', ... } for all SEC-registered tickers.
 * The raw company_tickers.json is ~500KB; we transform once and cache the
 * compact ticker→cik mapping.
 */
export async function getCikTable() {
  let store;
  try { store = getStore(CIK_BLOB_STORE); } catch { store = null; }

  if (store) {
    try {
      const cached = await store.get(CIK_BLOB_KEY, { type: 'json' });
      if (cached?.cached_at &&
          Date.now() - new Date(cached.cached_at).getTime() < CIK_TTL_MS) {
        return cached.table;
      }
    } catch { /* cache miss → fall through */ }
  }

  const res = await edgarGet(`${EDGAR_BASE}/files/company_tickers.json`);
  const raw = await res.json();

  const table = {};
  for (const entry of Object.values(raw)) {
    if (entry?.ticker && entry.cik_str !== undefined) {
      table[String(entry.ticker).toUpperCase()] =
        String(entry.cik_str).padStart(10, '0');
    }
  }

  if (store) {
    try {
      await store.set(CIK_BLOB_KEY, JSON.stringify({
        table,
        cached_at: new Date().toISOString(),
      }));
    } catch { /* silent */ }
  }
  return table;
}

export async function cikForTicker(ticker) {
  const table = await getCikTable();
  return table[String(ticker).toUpperCase()] || null;
}

// ── Submissions index ─────────────────────────────────────────────────────

/**
 * Fetch /submissions/CIK{cik}.json. Cached per-CIK with 24h TTL.
 * Returns the full submissions object — caller filters by form type.
 */
export async function fetchSubmissions(cik) {
  let store;
  try { store = getStore(SUBMISSIONS_BLOB_STORE); } catch { store = null; }
  const cacheKey = `submissions_${cik}`;

  if (store) {
    try {
      const cached = await store.get(cacheKey, { type: 'json' });
      if (cached?.cached_at &&
          Date.now() - new Date(cached.cached_at).getTime() < SUBMISSIONS_TTL_MS) {
        return cached.data;
      }
    } catch { /* miss */ }
  }

  const res = await edgarGet(`${EDGAR_DATA}/submissions/CIK${cik}.json`);
  const data = await res.json();

  if (store) {
    try {
      await store.set(cacheKey, JSON.stringify({
        data,
        cached_at: new Date().toISOString(),
      }));
    } catch { /* silent */ }
  }
  return data;
}

// ── Filing fetch ──────────────────────────────────────────────────────────

/**
 * @typedef {Object} FilingMeta
 * @property {string} cik             zero-padded 10-digit
 * @property {string} accession       e.g. 0000320193-24-000123
 * @property {string} primary_doc     filename of the primary document
 * @property {string} filing_date     YYYY-MM-DD
 * @property {string} fiscal_year_end YYYY-MM-DD or ''
 * @property {string} url             full URL to the primary document
 */

export function buildFilingUrl(cik, accession, primaryDoc) {
  const accNoDash = accession.replace(/-/g, '');
  return `${EDGAR_BASE}/Archives/edgar/data/${parseInt(cik, 10)}/${accNoDash}/${primaryDoc}`;
}

/**
 * Walk a submissions payload and return up to N most-recent filings matching
 * `formType` (e.g. "10-K", "4"). Newest first because EDGAR's recent[] array
 * is already sorted newest-first.
 */
export function pickRecentFilings(submissions, formType, max = 2, opts = {}) {
  const { sinceDate = null } = opts;
  const recent = submissions?.filings?.recent || {};
  const forms = recent.form || [];
  const accs = recent.accessionNumber || [];
  const primaries = recent.primaryDocument || [];
  const dates = recent.filingDate || [];
  const periods = recent.reportDate || [];

  const out = [];
  const cik = submissions?.cik
    ? String(submissions.cik).padStart(10, '0')
    : null;

  for (let i = 0; i < forms.length; i++) {
    if (forms[i] !== formType) continue;
    if (sinceDate && dates[i] && dates[i] < sinceDate) break;

    const acc = accs[i];
    const primary = primaries[i];
    if (!acc || !primary || !cik) continue;

    out.push({
      cik,
      accession:        acc,
      primary_doc:      primary,
      filing_date:      dates[i] || '',
      fiscal_year_end:  periods[i] || '',
      url:              buildFilingUrl(cik, acc, primary),
    });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Fetch a single filing's primary document body. Returns raw HTML/XML text.
 * Not cached at this layer — filings.mjs and insider.mjs cache their scored
 * results instead.
 */
export async function fetchFilingText(meta) {
  const res = await edgarGet(meta.url, { timeoutMs: 25000 });
  return res.text();
}
