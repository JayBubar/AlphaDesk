/**
 * Netlify serverless function — bulk price refresh for the Portfolio tab.
 *
 * POST /api/prices  { tickers: ["AAPL", "MSFT", ...] }
 * → { AAPL: { price: 213.49, change: 1.11 }, ... }
 *
 * Tries Schwab real-time quotes first; falls back to yahoo-finance2.
 */
import { getSchwabToken } from './shared/schwab-token.mjs';
import yahooFinance from 'yahoo-finance2';

yahooFinance.setGlobalConfig({ validation: { logErrors: false } });

const SCHWAB_QUOTES = 'https://api.schwabapi.com/marketdata/v1/quotes';

const CORS = { 'Access-Control-Allow-Origin': '*' };

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  try {
    const body    = await req.json().catch(() => ({}));
    const tickers = Array.isArray(body.tickers) ? body.tickers : [];

    if (!tickers.length) {
      return Response.json({}, { headers: CORS });
    }

    // ── Try Schwab ────────────────────────────────────────────────────────
    const token = await getSchwabToken();
    if (token) {
      const params = new URLSearchParams({
        symbols: tickers.join(','),
        fields:  'quote',
      });
      const res = await fetch(`${SCHWAB_QUOTES}?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (res.ok) {
        const data = await res.json();
        const result = {};
        for (const [sym, info] of Object.entries(data)) {
          const q = info?.quote || {};
          result[sym] = {
            price:  q.lastPrice  ?? null,
            change: q.netPercentChange ?? null,
          };
        }
        return Response.json(result, { headers: CORS });
      }
    }

    // ── Fallback: yahoo-finance2 ──────────────────────────────────────────
    const settled = await Promise.allSettled(
      tickers.map(t =>
        yahooFinance.quote(t, {}, { validateResult: false }).then(q => ({ t, q })),
      ),
    );

    const result = {};
    for (const r of settled) {
      if (r.status === 'fulfilled') {
        const { t, q } = r.value;
        result[t] = {
          price:  q?.regularMarketPrice        ?? null,
          change: q?.regularMarketChangePercent ?? null,
        };
      }
    }

    return Response.json(result, { headers: CORS });

  } catch (err) {
    return Response.json({ error: err.message }, { status: 500, headers: CORS });
  }
};
