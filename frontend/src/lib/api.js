// In dev: Vite proxies /api → FastAPI on :8000 (see vite.config.js).
// In production: Netlify routes /api/* → /.netlify/functions/:splat.
const BASE = import.meta.env.DEV ? '/api' : '/api'

export async function screenStocks(filters) {
  const params = new URLSearchParams()
  Object.entries(filters).forEach(([k, v]) => {
    if (v !== '' && v !== null && v !== undefined) params.set(k, v)
  })
  const res = await fetch(`${BASE}/screen?${params}`)
  if (!res.ok) throw new Error(`Screen failed: ${res.status}`)
  return res.json()
}

export async function getFiling(ticker, { refresh = false } = {}) {
  const url = `${BASE}/filings/${ticker.toUpperCase()}${refresh ? '?refresh=1' : ''}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Filing fetch failed: ${res.status}`)
  return res.json()
}

export async function getQuote(ticker) {
  const res = await fetch(`${BASE}/quote/${ticker}`)
  if (!res.ok) throw new Error(`Quote failed: ${res.status}`)
  return res.json()
}

export async function getDetail(ticker) {
  const res = await fetch(`${BASE}/detail/${ticker}`)
  if (!res.ok) throw new Error(`Detail failed: ${res.status}`)
  return res.json()
}

export async function refreshPrices(tickers) {
  const res = await fetch(`${BASE}/prices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tickers })
  })
  if (!res.ok) throw new Error(`Prices failed: ${res.status}`)
  return res.json()
}

export async function getSchwabStatus() {
  try {
    const res = await fetch(`${BASE}/schwab-status`)
    if (!res.ok) return { connected: false }
    return res.json()
  } catch {
    return { connected: false }
  }
}

export async function connectSchwab() {
  window.location.href = `${BASE}/schwab-auth`
}

export async function getResearch(ticker, { refresh = false } = {}) {
  const url = `${BASE}/research/${ticker.toUpperCase()}${refresh ? '?refresh=1' : ''}`
  const res = await fetch(url)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || `Research fetch failed: ${res.status}`)
  }
  return res.json()
}

export async function getUniverse({ refresh = false } = {}) {
  const url = `${BASE}/universe${refresh ? '?refresh=1' : ''}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Universe fetch failed: ${res.status}`)
  return res.json()
}

export async function getInsider(ticker, { refresh = false } = {}) {
  const url = `${BASE}/insider/${ticker.toUpperCase()}${refresh ? '?refresh=1' : ''}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Insider fetch failed: ${res.status}`)
  return res.json()
}

export async function getHoldings({ refresh = false } = {}) {
  const url = `${BASE}/holdings${refresh ? '?refresh=1' : ''}`
  const res = await fetch(url)
  if (res.status === 401) {
    const err = new Error('Schwab not connected')
    err.status = 401
    throw err
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    const err = new Error(body.error || `Holdings fetch failed: ${res.status}`)
    err.status = res.status
    err.detail = body.detail
    throw err
  }
  return res.json()
}
