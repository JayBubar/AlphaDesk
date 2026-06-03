import { useCallback, useEffect, useState } from 'react'
import Screener from './components/Screener.jsx'
import Portfolio from './components/Portfolio.jsx'
import Signals from './components/Signals.jsx'
import Nav from './components/Nav.jsx'
import { storage } from './lib/storage.js'
import { refreshPrices, getSchwabStatus, getHoldings, syncWatchlist } from './lib/api.js'
import './App.css'

/**
 * Merge a fresh Schwab holdings payload into the local watchlist + positions.
 *
 * Rules:
 *  - Schwab-sourced items (source='schwab') are refreshed each sync; if they
 *    no longer appear in Schwab they're removed.
 *  - Purely manual entries (no source flag) are left untouched.
 *  - New Schwab tickers are auto-added to both stores.
 *  - Non-EQUITY assets (ETFs, mutual funds) are marked noScore so Portfolio
 *    renders them without score bars.
 */
function mergeSchwabHoldings(watchlist, positions, holdings) {
  if (!holdings?.accounts) return { watchlist, positions }

  // Flatten all positions across accounts; keep latest if a ticker is held in
  // multiple accounts (Schwab will return separate rows). We'll sum quantities
  // since the same ticker held in two accounts should aggregate.
  const bySymbol = new Map()
  for (const acct of holdings.accounts) {
    for (const p of acct.positions || []) {
      const existing = bySymbol.get(p.ticker)
      if (!existing) {
        bySymbol.set(p.ticker, { ...p, accountNumber: acct.accountNumber })
      } else {
        const totalQty = existing.quantity + p.quantity
        const totalCost = existing.avgCost * existing.quantity + p.avgCost * p.quantity
        existing.quantity = totalQty
        existing.avgCost = totalQty ? totalCost / totalQty : existing.avgCost
        existing.marketValue += p.marketValue
        existing.gainLoss += p.gainLoss
        existing.gainLossPct = (existing.marketValue - existing.avgCost * existing.quantity)
          && (existing.avgCost * existing.quantity)
            ? (existing.gainLoss / (existing.avgCost * existing.quantity)) * 100
            : 0
        existing.accountNumber = 'multiple'
      }
    }
  }

  const schwabSymbols = new Set(bySymbol.keys())

  // ── Watchlist merge ────────────────────────────────────────────────────────
  const wlBySymbol = new Map(watchlist.map(w => [w.ticker, w]))

  // Drop Schwab-sourced entries that are no longer held.
  for (const [ticker, w] of wlBySymbol.entries()) {
    if (w.source === 'schwab' && !schwabSymbols.has(ticker)) {
      wlBySymbol.delete(ticker)
    }
  }

  // Add or update Schwab tickers in the watchlist.
  for (const [ticker, sp] of bySymbol.entries()) {
    const existing = wlBySymbol.get(ticker)
    const noScore = sp.assetType !== 'EQUITY'
    if (existing) {
      wlBySymbol.set(ticker, {
        ...existing,
        name: existing.name || sp.name,
        assetType: sp.assetType,
        noScore: existing.noScore ?? noScore,
      })
    } else {
      wlBySymbol.set(ticker, {
        ticker,
        name: sp.name,
        assetType: sp.assetType,
        source: 'schwab',
        noScore,
        addedAt: new Date().toISOString(),
      })
    }
  }

  // ── Positions merge ────────────────────────────────────────────────────────
  const nextPositions = { ...positions }

  // Drop Schwab-sourced positions that are no longer held.
  for (const [ticker, p] of Object.entries(nextPositions)) {
    if (p.source === 'schwab' && !schwabSymbols.has(ticker)) {
      delete nextPositions[ticker]
    }
  }

  // Add or update Schwab positions. Keep user-added notes/stars/entryDate/entryScore.
  for (const [ticker, sp] of bySymbol.entries()) {
    const existing = nextPositions[ticker] || {}
    nextPositions[ticker] = {
      ...existing,
      shares: sp.quantity,
      costBasis: sp.avgCost,
      entryDate: existing.entryDate || new Date().toISOString().split('T')[0],
      entryScore: existing.entryScore || 0,
      source: 'schwab',
      currentPrice: sp.currentPrice,
      marketValue: sp.marketValue,
      gainLoss: sp.gainLoss,
      gainLossPct: sp.gainLossPct,
      assetType: sp.assetType,
      accountNumber: sp.accountNumber,
      lastSynced: holdings.cached_at,
    }
  }

  return {
    watchlist: Array.from(wlBySymbol.values()),
    positions: nextPositions,
  }
}

export default function App() {
  const [view, setView] = useState('screener')
  const [watchlist, setWatchlist] = useState(() => storage.loadWatchlist())
  const [positions, setPositions] = useState(() => storage.loadPositions())
  const [livePrice, setLivePrice] = useState({})
  const [refreshing, setRefreshing] = useState(false)
  const [lastRefresh, setLastRefresh] = useState(null)

  const [schwabConnected, setSchwabConnected] = useState(null) // null = loading
  const [schwabSyncing, setSchwabSyncing] = useState(false)
  const [schwabError, setSchwabError] = useState(null)
  const [schwabLastSync, setSchwabLastSync] = useState(null)

  useEffect(() => { storage.saveWatchlist(watchlist) }, [watchlist])
  useEffect(() => { storage.savePositions(positions) }, [positions])

  // Mirror the watchlist to a server-side blob so the nightly cache-warmer
  // knows which tickers to pre-fetch research + insider for. Debounced 2s
  // so rapid edits collapse into one POST. Failures are silently dropped.
  useEffect(() => {
    const tickers = watchlist.map(w => w.ticker)
    const timer = setTimeout(() => {
      syncWatchlist(tickers).catch(() => {})
    }, 2000)
    return () => clearTimeout(timer)
  }, [watchlist])

  // Check Schwab connection status on mount.
  useEffect(() => {
    getSchwabStatus().then(s => setSchwabConnected(s.connected)).catch(() => {
      setSchwabConnected(false)
    })
  }, [])

  const syncSchwab = useCallback(async ({ refresh = false } = {}) => {
    setSchwabSyncing(true)
    setSchwabError(null)
    try {
      const holdings = await getHoldings({ refresh })
      setSchwabLastSync(holdings.cached_at)
      // Read fresh state via the storage layer to avoid a closure stale-read
      // (this callback's deps would otherwise need watchlist/positions, which
      // would re-fire the effect on every merge — infinite loop risk).
      const currentWl = storage.loadWatchlist()
      const currentPos = storage.loadPositions()
      const merged = mergeSchwabHoldings(currentWl, currentPos, holdings)
      setWatchlist(merged.watchlist)
      setPositions(merged.positions)
    } catch (e) {
      if (e.status === 401) {
        setSchwabConnected(false)
        setSchwabError('Schwab token expired — reconnect to sync holdings.')
      } else {
        setSchwabError('Schwab sync failed — showing last known positions.')
      }
    } finally {
      setSchwabSyncing(false)
    }
  }, [])

  // Auto-sync once when Schwab connection is confirmed.
  useEffect(() => {
    if (schwabConnected) syncSchwab()
  }, [schwabConnected, syncSchwab])

  const refreshAllPrices = useCallback(async () => {
    if (!watchlist.length) return
    setRefreshing(true)
    try {
      const data = await refreshPrices(watchlist.map(s => s.ticker))
      setLivePrice(data)
      setLastRefresh(new Date())
    } catch (e) {
      console.error('Price refresh failed:', e)
    } finally {
      setRefreshing(false)
    }
  }, [watchlist])

  useEffect(() => {
    if (watchlist.length > 0) refreshAllPrices()
  }, [watchlist.length, refreshAllPrices])

  function addToWatchlist(stock) {
    setWatchlist(prev =>
      prev.find(s => s.ticker === stock.ticker)
        ? prev
        : [...prev, { ...stock, addedAt: new Date().toISOString() }]
    )
  }

  function removeFromWatchlist(ticker) {
    setWatchlist(prev => prev.filter(s => s.ticker !== ticker))
    // If user explicitly removed, also drop the linked position to avoid
    // orphaning. They can always re-add manually or via Schwab sync.
    setPositions(prev => {
      const next = { ...prev }
      delete next[ticker]
      return next
    })
  }

  return (
    <div className="app-shell">
      <Nav
        view={view}
        setView={setView}
        watchlistCount={watchlist.length}
        schwabConnected={schwabConnected}
      />
      <main className="app-main">
        {view === 'screener' && (
          <Screener
            watchlist={watchlist}
            onAddToWatchlist={addToWatchlist}
            onRemoveFromWatchlist={removeFromWatchlist}
          />
        )}
        {view === 'portfolio' && (
          <Portfolio
            watchlist={watchlist}
            onRemoveFromWatchlist={removeFromWatchlist}
            positions={positions}
            setPositions={setPositions}
            livePrice={livePrice}
            refreshAllPrices={refreshAllPrices}
            refreshing={refreshing}
            lastRefresh={lastRefresh}
            schwabConnected={schwabConnected}
            schwabSyncing={schwabSyncing}
            schwabError={schwabError}
            schwabLastSync={schwabLastSync}
            onSchwabSync={() => syncSchwab({ refresh: true })}
          />
        )}
        {view === 'signals' && (
          <Signals
            watchlist={watchlist}
            positions={positions}
            livePrices={livePrice}
          />
        )}
      </main>
    </div>
  )
}
