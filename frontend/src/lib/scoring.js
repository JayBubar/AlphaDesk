export const DEFAULT_WEIGHTS = {
  fundamentals: 25,
  momentum: 20,
  sentiment: 20,
  filingTone: 20,
  insider: 15,
}

export function computeComposite(scores, weights = DEFAULT_WEIGHTS) {
  const total = Object.values(weights).reduce((a, b) => a + b, 0)
  if (total === 0) return 0
  const raw =
    (scores.fundamentals * weights.fundamentals +
      scores.momentum * weights.momentum +
      scores.sentiment * weights.sentiment +
      scores.filingTone * weights.filingTone +
      scores.insider * weights.insider) /
    total
  return Math.round(raw)
}

export function scoreColor(n) {
  if (n >= 75) return 'var(--green)'
  if (n >= 55) return 'var(--amber)'
  return 'var(--red)'
}

export function scoreBg(n) {
  if (n >= 75) return 'var(--green-dim)'
  if (n >= 55) return 'var(--amber-dim)'
  return 'var(--red-dim)'
}

export function fmtNum(n, decimals = 1) {
  if (n === null || n === undefined) return 'N/A'
  return Number(n).toFixed(decimals)
}

export function fmtPct(n) {
  if (n === null || n === undefined) return 'N/A'
  const sign = n >= 0 ? '+' : ''
  return `${sign}${Number(n).toFixed(2)}%`
}

export function fmtMarketCap(n) {
  if (!n) return 'N/A'
  if (n >= 1e12) return `$${(n / 1e12).toFixed(1)}T`
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`
  return `$${n.toLocaleString()}`
}

export function fmtVolume(n) {
  if (!n) return 'N/A'
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`
  return String(n)
}

export function weightsValid(w) {
  return Object.values(w).reduce((a, b) => a + b, 0) === 100
}
