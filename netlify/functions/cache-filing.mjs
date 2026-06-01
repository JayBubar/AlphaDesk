/**
 * Netlify serverless function — write-side cache for 10-K filing scores.
 *
 * Why this exists: filings.py (Python) computes the EDGAR NLP score, but
 * Netlify Blobs has no Python SDK. The frontend (FilingPanel.jsx) gets the
 * filing result back from /api/filings/{ticker}, then POSTs it here to warm
 * the blob cache that screen.mjs reads from.
 *
 * POST /api/cache-filing
 *   body: { ticker: "AAPL", payload: <FilingScore as returned by filings.py> }
 *   → { ok: true, cached_at: "2026-05-31T..." }
 */
import { getStore } from '@netlify/blobs';

const STORE_NAME = 'filing-scores';
const CORS = { 'Access-Control-Allow-Origin': '*' };

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (req.method !== 'POST') {
    return Response.json({ error: 'POST only' }, { status: 405, headers: CORS });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const ticker = (body.ticker || '').toUpperCase().trim();
    const payload = body.payload;

    if (!ticker || !payload || typeof payload !== 'object') {
      return Response.json({ error: 'ticker and payload required' }, { status: 400, headers: CORS });
    }

    // Don't cache error responses or single-filing entries — the score is
    // baseline and would just confuse the screener with non-signal data.
    if (payload.error || payload.risk_drift == null || payload.hedging_delta == null) {
      return Response.json({ ok: false, reason: 'incomplete score, not cached' }, { headers: CORS });
    }

    const cached_at = new Date().toISOString();
    const entry = { ...payload, cached_at };

    const store = getStore(STORE_NAME);
    await store.set(ticker, JSON.stringify(entry));

    return Response.json({ ok: true, cached_at }, { headers: CORS });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500, headers: CORS });
  }
};
