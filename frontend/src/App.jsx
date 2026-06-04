import { useCallback, useEffect, useState } from 'react'
import Screener from './components/Screener.jsx'
import Watchlist from './components/Watchlist.jsx'
import Portfolio from './components/Portfolio.jsx'
import Signals from './components/Signals.jsx'
import Nav from './components/Nav.jsx'
import { storage } from './lib/storage.js'
import {
  refreshPrices, getSchwabStatus, getHoldings, syncWatchlist, getUniverse,
} from './lib/api.js'
import './App.css'

/**
 * Merge a fresh Schwab holdings payload into the local positions store.
 *
 * Schwab sync no longer touches the watchlist — watchlist is now exclusively
 * the user's curated research list, populated from the Screener. Schwab
 * positions flow straight into the Portfolio tab.
 *
 * Rules:
 *  - Schwab-sourced positions (source='schwab') are refreshed each sync;
 *    if they no longer appear in Schwab they're removed.
 *  - Legacy manual positions (no source flag) are left in localStorage but
 *    Portfolio filters them out — they won't render anywhere.
 *  - Multi-account holdings of the same ticker are summed with weighted
 *    average cost basis.
 */
function mergeSchwabPositions(positions, holdings, suppressedSet = new Set()) {
  if (!holdings?.accounts) return positions

  const bySymbol = new Map()
  for (const acct of holdings.accounts) {
    for (const p of acct.positions || []) {
      if (suppressedSet.has(p.ticker)) continue
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
        existing.gainLossPct = (existing.avgCost * existing.quantity)
          ? (existing.gainLoss / (existing.avgCost * existing.quantity)) * 100
          : 0
        existing.accountNumber = 'multiple'
      }
    }
  }

  const schwabSymbols = new Set(bySymbol.keys())
  const next = { ...positions }

  // Drop Schwab-sourced positions that are no longer held.
  for (const [ticker, p] of Object.entries(next)) {
    if (p.source === 'schwab' && !schwabSymbols.has(ticker)) {
      delete next[ticker]
    }
  }

  // Add or update Schwab positions. Preserve any user-added entry notes
  // that might have come from legacy manual entry.
  for (const [ticker, sp] of bySymbol.entries()) {
    const existing = next[ticker] || {}
    next[ticker] = {
      ...existing,
      shares: sp.quantity,
      costBasis: sp.avgCost,
      entryDate: existing.entryDate || new Date().toISOString().split('T')[0],
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

  return next
}

export default function App() {
  const [view, setView] = useState('screener')
  const [watchlist, setWatchlist] = useState(() => storage.loadWatchlist())
  const [positions, setPositions] = useState(() => storage.loadPositions())
  const [favorites, setFavorites] = useState(() => storage.loadFavorites())
  const [livePrice, setLivePrice] = useState({})
  const [refreshing, setRefreshing] = useState(false)
  const [lastRefresh, setLastRefresh] = useState(null)

  const [schwabConnected, setSchwabConnected] = useState(null)
  const [schwabSyncing, setSchwabSyncing] = useState(false)
  const [schwabError, setSchwabError] = useState(null)
  const [schwabLastSync, setSchwabLastSync] = useState(null)
  const [schwabSuppressed, setSchwabSuppressed] = useState(() => storage.loadSchwabSuppressed())
  // Schwab Slices eligibility = S&P 500 membership. Pulled once on mount;
  // cached server-side for 7 days so this is essentially free.
  const [slicesSet, setSlicesSet] = useState(() => new Set())

  useEffect(() => {
    getUniverse()
      .then(u => {
        const sp500 = (u?.tickers || [])
          .filter(t => t.index === 'sp500')
          .map(t => t.symbol)
        setSlicesSet(new Set(sp500))
      })
      .catch(() => { /* graceful: no badges if universe fetch fails */ })
  }, [])

  useEffect(() => { storage.saveSchwabSuppressed(schwabSuppressed) }, [schwabSuppressed])
  useEffect(() => { storage.saveWatchlist(watchlist) }, [watchlist])
  useEffect(() => { storage.savePositions(positions) }, [positions])
  useEffect(() => { storage.saveFavorites(favorites) }, [favorites])

  // Mirror the watchlist + portfolio tickers to a server-side blob so the
  // nightly cron warms research/insider/filings caches for the union.
  // Debounced 2s; failures swallowed.
  useEffect(() => {
    const portfolioTickers = Object.keys(positions).filter(
      t => positions[t]?.source === 'schwab' && positions[t]?.assetType === 'EQUITY'
    )
    const union = Array.from(new Set([
      ...watchlist.map(w => w.ticker),
      ...portfolioTickers,
    ]))
    const timer = setTimeout(() => {
      syncWatchlist(union).catch(() => {})
    }, 2000)
    return () => clearTimeout(timer)
  }, [watchlist, positions])

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
      const currentPos = storage.loadPositions()
      const suppressedSet = new Set(storage.loadSchwabSuppressed())
      const merged = mergeSchwabPositions(currentPos, holdings, suppressedSet)
      setPositions(merged)
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

  useEffect(() => {
    if (schwabConnected) syncSchwab()
  }, [schwabConnected, syncSchwab])

  // Live prices cover BOTH watchlist (research) and Schwab equity positions.
  // ETFs/MFs get prices straight from Schwab on each sync, so we don't refresh
  // those separately.
  const refreshAllPrices = useCallback(async () => {
    const portfolioEquityTickers = Object.keys(positions).filter(
      t => positions[t]?.source === 'schwab' && positions[t]?.assetType === 'EQUITY'
    )
    const tickers = Array.from(new Set([
      ...watchlist.map(s => s.ticker),
      ...portfolioEquityTickers,
    ]))
    if (!tickers.length) return
    setRefreshing(true)
    try {
      const data = await refreshPrices(tickers)
      setLivePrice(data)
      setLastRefresh(new Date())
    } catch (e) {
      console.error('Price refresh failed:', e)
    } finally {
      setRefreshing(false)
    }
  }, [watchlist, positions])

  useEffect(() => {
    if (watchlist.length > 0 || Object.keys(positions).length > 0) refreshAllPrices()
  }, [watchlist.length, Object.keys(positions).length, refreshAllPrices])

  function addToWatchlist(stock) {
    setWatchlist(prev =>
      prev.find(s => s.ticker === stock.ticker)
        ? prev
        : [...prev, { ...stock, addedAt: new Date().toISOString() }]
    )
  }

  function removeFromWatchlist(ticker) {
    setWatchlist(prev => prev.filter(s => s.ticker !== ticker))
  }

  function setUserThesis(ticker, thesis) {
    setWatchlist(prev => prev.map(s =>
      s.ticker === ticker ? { ...s, userThesis: thesis } : s
    ))
  }

  function toggleFavorite(ticker) {
    setFavorites(prev =>
      prev.includes(ticker)
        ? prev.filter(t => t !== ticker)
        : [...prev, ticker]
    )
  }

  function unsuppressSchwab(ticker) {
    setSchwabSuppressed(prev => prev.filter(t => t !== ticker))
    if (schwabConnected) syncSchwab({ refresh: true })
  }

  function suppressSchwabPosition(ticker) {
    setSchwabSuppressed(prev => prev.includes(ticker) ? prev : [...prev, ticker])
    setPositions(prev => {
      const next = { ...prev }
      delete next[ticker]
      return next
    })
  }

  const favoritesSet = new Set(favorites)

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
        {view === 'watchlist' && (
          <Watchlist
            watchlist={watchlist}
            onRemoveFromWatchlist={removeFromWatchlist}
            livePrice={livePrice}
            refreshAllPrices={refreshAllPrices}
            refreshing={refreshing}
            lastRefresh={lastRefresh}
            favorites={favoritesSet}
            onToggleFavorite={toggleFavorite}
            onSetThesis={setUserThesis}
          />
        )}
        {view === 'portfolio' && (
          <Portfolio
            positions={positions}
            livePrice={livePrice}
            refreshAllPrices={refreshAllPrices}
            refreshing={refreshing}
            lastRefresh={lastRefresh}
            schwabConnected={schwabConnected}
            schwabSyncing={schwabSyncing}
            schwabError={schwabError}
            schwabLastSync={schwabLastSync}
            onSchwabSync={() => syncSchwab({ refresh: true })}
            schwabSuppressed={schwabSuppressed}
            onUnsuppressSchwab={unsuppressSchwab}
            onSuppressPosition={suppressSchwabPosition}
            favorites={favoritesSet}
            onToggleFavorite={toggleFavorite}
            slicesSet={slicesSet}
          />
        )}
        {view === 'signals' && (
          <Signals
            watchlist={watchlist}
            positions={positions}
            livePrices={livePrice}
            favorites={favoritesSet}
          />
        )}
      </main>
    </div>
  )
}
