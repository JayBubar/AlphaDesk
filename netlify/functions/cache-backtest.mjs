/**
 * Netlify serverless function — write-side cache for backtest results.
 * Same pattern as cache-filing.mjs and cache-insider.mjs.
 *
 * POST /api/cache-backtest
 *   body: { ticker, payload: <BacktestResult from backtest.py> }
 *   → { ok: true, cached_at: "..." }
 */
import { getStore } from '@netlify/blobs';

const STORE_NAME = 'backtest-results';
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
    if (payload.error || !Array.isArray(payload.snapshots) || payload.snapshots.length === 0) {
      return Response.json({ ok: false, reason: 'no snapshots, not cached' }, { headers: CORS });
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
