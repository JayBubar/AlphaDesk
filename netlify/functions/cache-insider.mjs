/**
 * Netlify serverless function — write-side cache for insider-activity scores.
 * Mirrors cache-filing.mjs since Netlify Blobs has no Python SDK.
 *
 * POST /api/cache-insider
 *   body: { ticker, payload: <InsiderScore from insider.py> }
 *   → { ok: true, cached_at: "..." }
 */
import { getStore } from '@netlify/blobs';

const STORE_NAME = 'insider-scores';
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

    // Cache "no data in window" results too — a zero-activity ticker is a
    // valid signal (score 50 = neutral) and we don't want to refetch EDGAR
    // every time the screener runs just because that ticker is quiet.
    const cached_at = new Date().toISOString();
    const entry = { ...payload, cached_at };

    const store = getStore(STORE_NAME);
    await store.set(ticker, JSON.stringify(entry));

    return Response.json({ ok: true, cached_at }, { headers: CORS });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500, headers: CORS });
  }
};
