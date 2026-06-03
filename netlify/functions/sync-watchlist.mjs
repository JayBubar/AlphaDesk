/**
 * Netlify serverless function — mirror the user's watchlist to a Blob so the
 * scheduled cache-warming function knows which tickers to pre-fetch.
 *
 * The watchlist lives in localStorage on the client (no auth = single user).
 * App.jsx debounces and POSTs here whenever watchlist changes.
 *
 * POST /api/sync-watchlist  { tickers: ["AAPL", "MSFT", ...] }
 * GET  /api/sync-watchlist  → { tickers, synced_at } (for the cron and debug)
 */
import { getStore } from '@netlify/blobs';

const STORE_NAME = 'user-watchlist';
const CACHE_KEY = 'default';
const CORS = { 'Access-Control-Allow-Origin': '*' };

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  let store;
  try { store = getStore(STORE_NAME); } catch {
    return Response.json({ error: 'Blobs unavailable' }, { status: 500, headers: CORS });
  }

  if (req.method === 'GET') {
    try {
      const data = await store.get(CACHE_KEY, { type: 'json' });
      return Response.json(data || { tickers: [], synced_at: null }, { headers: CORS });
    } catch {
      return Response.json({ tickers: [], synced_at: null }, { headers: CORS });
    }
  }

  if (req.method !== 'POST') {
    return Response.json({ error: 'POST or GET only' }, { status: 405, headers: CORS });
  }

  try {
    const body = await req.json().catch(() => ({}));
    let tickers = Array.isArray(body.tickers) ? body.tickers : [];
    // Normalize, dedupe, and cap to a sane size so a runaway watchlist can't
    // explode the cron's request volume.
    tickers = Array.from(new Set(
      tickers.map(t => String(t || '').toUpperCase().trim()).filter(Boolean)
    )).slice(0, 100);

    const entry = { tickers, synced_at: new Date().toISOString() };
    await store.set(CACHE_KEY, JSON.stringify(entry));
    return Response.json({ ok: true, count: tickers.length, synced_at: entry.synced_at },
                         { headers: CORS });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500, headers: CORS });
  }
};
