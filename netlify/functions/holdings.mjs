/**
 * Netlify serverless function — Schwab account holdings sync.
 *
 * GET /api/holdings            → cached (5min TTL) or fresh
 * GET /api/holdings?refresh=1  → bypass cache
 *
 * Two Schwab endpoints are involved:
 *   1. /trader/v1/accounts/accountNumbers
 *        → list of { accountNumber, hashValue }. The hash is what subsequent
 *          calls actually use — Schwab keeps raw account numbers out of URLs.
 *   2. /trader/v1/accounts/{hashValue}?fields=positions
 *        → securitiesAccount payload with positions[] and currentBalances.
 *
 * Requires the "Accounts and Trading Production" entitlement on the Schwab
 * developer-portal app. Returns 401 if the OAuth token doesn't carry it.
 */
import { getStore } from '@netlify/blobs';
import { getSchwabToken } from './shared/schwab-token.mjs';

const SCHWAB_BASE = 'https://api.schwabapi.com/trader/v1';
const STORE_NAME = 'holdings-cache';
const CACHE_KEY = 'positions';
const TTL_MS = 5 * 60 * 1000;
const CORS = { 'Access-Control-Allow-Origin': '*' };

function maskAccount(num) {
  if (!num) return '';
  const last4 = String(num).slice(-4);
  return `...${last4}`;
}

// Schwab's assetType vocabulary differs from how people talk about them.
// COLLECTIVE_INVESTMENT covers most ETFs; we expose "ETF" for clarity.
function normalizeAssetType(raw, description = '') {
  if (!raw) return 'EQUITY';
  if (raw === 'COLLECTIVE_INVESTMENT') return 'ETF';
  if (raw === 'MUTUAL_FUND') return 'MUTUAL_FUND';
  if (raw === 'OPTION') return 'OPTION';
  if (raw === 'FIXED_INCOME') return 'FIXED_INCOME';
  if (raw === 'CASH_EQUIVALENT') return 'CASH';
  return raw;  // EQUITY, INDEX, CURRENCY, etc.
}

function parsePosition(p) {
  const inst = p?.instrument || {};
  const symbol = inst.symbol || '';
  if (!symbol) return null;

  // Net quantity: long minus short. Most retail accounts are long-only.
  const longQty = Number(p.longQuantity || 0);
  const shortQty = Number(p.shortQuantity || 0);
  const quantity = longQty - shortQty;
  if (quantity === 0) return null;

  const avgCost = Number(p.averagePrice || 0);
  const marketValue = Number(p.marketValue || 0);
  const currentPrice = quantity ? marketValue / quantity : null;

  // Schwab provides open P/L for long positions. Fall back to computed
  // (marketValue - cost basis) when missing or short.
  const cost = avgCost * quantity;
  const gainLoss = (p.longOpenProfitLoss != null)
    ? Number(p.longOpenProfitLoss)
    : (marketValue - cost);
  const gainLossPct = cost ? (gainLoss / cost) * 100 : 0;

  return {
    ticker:       symbol.toUpperCase(),
    name:         inst.description || symbol,
    quantity:     +quantity.toFixed(4),
    avgCost:      +avgCost.toFixed(2),
    currentPrice: currentPrice != null ? +currentPrice.toFixed(2) : null,
    marketValue:  +marketValue.toFixed(2),
    gainLoss:     +gainLoss.toFixed(2),
    gainLossPct:  +gainLossPct.toFixed(2),
    assetType:    normalizeAssetType(inst.assetType, inst.description),
    cusip:        inst.cusip || null,
  };
}

async function fetchAccountHashes(token) {
  const res = await fetch(`${SCHWAB_BASE}/accounts/accountNumbers`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`accountNumbers ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data.map(e => ({
    accountNumber: e.accountNumber,
    hashValue:     e.hashValue,
  }));
}

async function fetchAccountPositions(token, hash) {
  const url = `${SCHWAB_BASE}/accounts/${encodeURIComponent(hash)}?fields=positions`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`positions ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const refresh = new URL(req.url).searchParams.get('refresh') === '1';

  let store;
  try { store = getStore(STORE_NAME); } catch { store = null; }

  // Try cache first.
  if (!refresh && store) {
    try {
      const cached = await store.get(CACHE_KEY, { type: 'json' });
      if (cached?.cached_at &&
          Date.now() - new Date(cached.cached_at).getTime() < TTL_MS) {
        return Response.json({ ...cached, fresh: false }, { headers: CORS });
      }
    } catch { /* miss → fall through */ }
  }

  const token = await getSchwabToken();
  if (!token) {
    return Response.json({ error: 'Schwab not connected' }, { status: 401, headers: CORS });
  }

  try {
    const accountRefs = await fetchAccountHashes(token);
    if (!accountRefs.length) {
      return Response.json({ accounts: [], totalValue: 0, cached_at: new Date().toISOString() },
                           { headers: CORS });
    }

    const perAccount = await Promise.all(accountRefs.map(async ref => {
      const data = await fetchAccountPositions(token, ref.hashValue);
      const sec = data?.securitiesAccount || {};
      const positions = (sec.positions || [])
        .map(parsePosition)
        .filter(Boolean);
      return {
        accountNumber: maskAccount(ref.accountNumber),
        accountType:   sec.type || null,   // MARGIN | CASH
        positions,
      };
    }));

    const totalValue = perAccount.reduce(
      (sum, acct) => sum + acct.positions.reduce((s, p) => s + (p.marketValue || 0), 0),
      0,
    );

    const entry = {
      accounts: perAccount,
      totalValue: +totalValue.toFixed(2),
      cached_at: new Date().toISOString(),
    };

    if (store) {
      try { await store.set(CACHE_KEY, JSON.stringify(entry)); } catch { /* silent */ }
    }

    return Response.json({ ...entry, fresh: true }, { headers: CORS });
  } catch (err) {
    // Distinguish "token expired" (401 surfaced by Schwab) from real outages.
    const msg = err.message || String(err);
    const looksLikeAuth = /401|unauthor/i.test(msg);
    return Response.json(
      { error: looksLikeAuth ? 'Schwab not connected' : 'Schwab API unavailable', detail: msg },
      { status: looksLikeAuth ? 401 : 502, headers: CORS },
    );
  }
};
