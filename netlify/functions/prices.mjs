/**
 * Netlify serverless function — bulk price refresh for the Portfolio tab.
 *
 * POST /api/prices  { tickers: ["AAPL", "MSFT", ...] }
 * → { AAPL: { price: 213.49, change: 1.11 }, ... }
 *
 * Tries Schwab real-time quotes first; falls back to FMP bulk quote.
 */
import { getSchwabToken } from './shared/schwab-token.mjs';

const SCHWAB_QUOTES = 'https://api.schwabapi.com/marketdata/v1/quotes';
const FMP_QUOTE     = 'https://financialmodelingprep.com/stable/quote';
const CORS = { 'Access-Control-Allow-Origin': '*' };

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  try {
    const body    = await req.json().catch(() => ({}));
    const tickers = Array.isArray(body.tickers) ? body.tickers : [];

    if (!tickers.length) return Response.json({}, { headers: CORS });

    const result = Object.fromEntries(tickers.map(t => [t, { price: null, change: null }]));

    // ── Try Schwab ────────────────────────────────────────────────────────
    const token = await getSchwabToken();
    if (token) {
      const params = new URLSearchParams({ symbols: tickers.join(','), fields: 'quote' });
      const res = await fetch(`${SCHWAB_QUOTES}?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        for (const [sym, info] of Object.entries(data)) {
          const q = info?.quote || {};
          result[sym] = {
            price:  q.lastPrice        ?? null,
            change: q.netPercentChange ?? null,
          };
        }
        return Response.json(result, { headers: CORS });
      }
    }

    // ── Fallback: FMP bulk quote ──────────────────────────────────────────
    const fmpKey = process.env.FMP_API_KEY || '';
    if (fmpKey) {
      const url = `${FMP_QUOTE}?symbol=${encodeURIComponent(tickers.join(','))}&apikey=${fmpKey}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          for (const q of data) {
            if (!q.symbol) continue;
            result[q.symbol] = {
              price:  q.price              ?? null,
              change: q.changesPercentage  ?? null,
            };
          }
        }
      }
    }

    return Response.json(result, { headers: CORS });

  } catch (err) {
    return Response.json({ error: err.message }, { status: 500, headers: CORS });
  }
};
