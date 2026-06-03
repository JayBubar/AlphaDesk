// Thin localStorage adapter. Single source of truth for keys + serialization,
// so we don't sprinkle JSON.parse/stringify and key strings through components.

const KEY = {
  watchlist: 'alphadesk:watchlist:v1',
  positions: 'alphadesk:positions:v1',
  profile:   'alphadesk:profile:v1',
  weights:   'alphadesk:weights:v1',
  scoreHistory: 'alphadesk:scoreHistory:v1',
  schwabSuppressed: 'alphadesk:schwabSuppressed:v1',
}

function read(key, fallback) {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(key)
    if (raw === null) return fallback
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

function write(key, value) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // quota exceeded or storage unavailable — silent
  }
}

export const storage = {
  loadWatchlist: () => read(KEY.watchlist, []),
  saveWatchlist: (list) => write(KEY.watchlist, list),

  loadPositions: () => read(KEY.positions, {}),
  savePositions: (positions) => write(KEY.positions, positions),

  loadProfile: () => read(KEY.profile, null),
  saveProfile: (profile) => write(KEY.profile, profile),

  loadWeights: () => read(KEY.weights, null),
  saveWeights: (weights) => write(KEY.weights, weights),

  // Append a score snapshot to per-ticker history (newest first, capped).
  appendScoreSnapshot: (ticker, snapshot, maxPerTicker = 60) => {
    const all = read(KEY.scoreHistory, {})
    const next = [{ ...snapshot, savedAt: new Date().toISOString() }, ...(all[ticker] || [])]
    all[ticker] = next.slice(0, maxPerTicker)
    write(KEY.scoreHistory, all)
  },
  loadScoreHistory: (ticker) => {
    const all = read(KEY.scoreHistory, {})
    return ticker ? (all[ticker] || []) : all
  },

  // Tickers the user explicitly removed from a Schwab sync. The merge logic
  // checks this set and skips matches, so manually-excluded names don't
  // silently re-add on the next sync.
  loadSchwabSuppressed: () => read(KEY.schwabSuppressed, []),
  saveSchwabSuppressed: (tickers) => write(KEY.schwabSuppressed, tickers),
}
