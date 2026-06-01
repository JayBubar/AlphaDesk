/**
 * Netlify serverless function — Perplexity-powered research card per ticker.
 *
 * GET /api/research/{ticker}            → cached (24h TTL) or fresh
 * GET /api/research/{ticker}?refresh=1  → bypass cache
 *
 * Response shape:
 *   { ticker, sentiment, summary, catalysts[], risks[], analystConsensus,
 *     cached_at, fresh: bool }
 *
 * Writes results to Netlify Blobs (store "research-cache", key = ticker).
 * screen.mjs reads from the same store to populate the sentiment pillar.
 */
import { getStore } from '@netlify/blobs';

const STORE_NAME = 'research-cache';
const TTL_MS = 24 * 60 * 60 * 1000;
const PERPLEXITY_URL = 'https://api.perplexity.ai/chat/completions';
const CORS = { 'Access-Control-Allow-Origin': '*' };

// Strict schema → Perplexity returns parsed JSON, no fragile prompt-extraction.
const RESEARCH_SCHEMA = {
  type: 'object',
  properties: {
    sentiment:        { type: 'string', enum: ['bullish', 'bearish', 'neutral'] },
    summary:          { type: 'string' },
    catalysts:        { type: 'array', items: { type: 'string' } },
    risks:            { type: 'array', items: { type: 'string' } },
    analystConsensus: { type: 'string', enum: ['buy', 'hold', 'sell'] },
  },
  required: ['sentiment', 'summary', 'catalysts', 'risks', 'analystConsensus'],
  additionalProperties: false,
};

function tickerFromPath(url) {
  const parts = new URL(url).pathname.split('/').filter(Boolean);
  // Path will be e.g. /.netlify/functions/research/AAPL  or  /api/research/AAPL
  return (parts[parts.length - 1] || '').toUpperCase();
}

async function callPerplexity(ticker, apiKey) {
  const body = {
    model: 'sonar',
    messages: [
      {
        role: 'system',
        content:
          'You are a financial research assistant. Respond ONLY with valid JSON ' +
          'matching the schema. Base your answers on news and analyst reports ' +
          'from the last 90 days. Be specific and concise.',
      },
      {
        role: 'user',
        content:
          `Provide a research card for ${ticker}:\n` +
          `- sentiment: overall news sentiment of the last 90 days\n` +
          `- summary: one-sentence bull/bear take\n` +
          `- catalysts: 2-3 specific positive catalysts or upcoming events\n` +
          `- risks: 2-3 specific risks or headwinds\n` +
          `- analystConsensus: aggregated Wall Street rating`,
      },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'research_card', schema: RESEARCH_SCHEMA, strict: true },
    },
    temperature: 0.2,
  };

  const res = await fetch(PERPLEXITY_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Perplexity ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('Perplexity returned no content');

  // With json_schema strict mode, content is a JSON string matching the schema.
  let parsed;
  try { parsed = JSON.parse(content); }
  catch { throw new Error('Perplexity returned non-JSON content'); }

  return parsed;
}

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const ticker = tickerFromPath(req.url);
  if (!ticker || ticker === 'RESEARCH') {
    return Response.json({ error: 'ticker required' }, { status: 400, headers: CORS });
  }

  const refresh = new URL(req.url).searchParams.get('refresh') === '1';
  const apiKey = process.env.PERPLEXITY_API_KEY || '';

  // Try cache first (unless refresh requested).
  let store;
  try { store = getStore(STORE_NAME); } catch { store = null; }

  if (!refresh && store) {
    try {
      const cached = await store.get(ticker, { type: 'json' });
      if (cached?.cached_at && Date.now() - new Date(cached.cached_at).getTime() < TTL_MS) {
        return Response.json({ ...cached, fresh: false }, { headers: CORS });
      }
    } catch { /* cache miss → fall through */ }
  }

  if (!apiKey) {
    return Response.json(
      { error: 'Research not configured', detail: 'PERPLEXITY_API_KEY not set' },
      { status: 503, headers: CORS },
    );
  }

  try {
    const parsed = await callPerplexity(ticker, apiKey);
    const entry = {
      ticker,
      sentiment:        parsed.sentiment,
      summary:          parsed.summary,
      catalysts:        parsed.catalysts || [],
      risks:            parsed.risks || [],
      analystConsensus: parsed.analystConsensus,
      cached_at:        new Date().toISOString(),
    };

    if (store) {
      try { await store.set(ticker, JSON.stringify(entry)); } catch { /* silent */ }
    }

    return Response.json({ ...entry, fresh: true }, { headers: CORS });
  } catch (err) {
    return Response.json(
      { error: 'Research unavailable', detail: err.message },
      { status: 502, headers: CORS },
    );
  }
};
