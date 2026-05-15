const BASE = import.meta.env.DEV ? '/api' : '/.netlify/functions'

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
