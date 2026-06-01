import { useCallback, useEffect, useState } from 'react'
import Screener from './components/Screener.jsx'
import Portfolio from './components/Portfolio.jsx'
import Signals from './components/Signals.jsx'
import Nav from './components/Nav.jsx'
import { storage } from './lib/storage.js'
import { refreshPrices } from './lib/api.js'
import './App.css'

export default function App() {
  const [view, setView] = useState('screener')
  const [watchlist, setWatchlist] = useState(() => storage.loadWatchlist())
  const [positions, setPositions] = useState(() => storage.loadPositions())
  const [livePrice, setLivePrice] = useState({})
  const [refreshing, setRefreshing] = useState(false)
  const [lastRefresh, setLastRefresh] = useState(null)

  useEffect(() => { storage.saveWatchlist(watchlist) }, [watchlist])
  useEffect(() => { storage.savePositions(positions) }, [positions])

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

  // Refresh whenever the watchlist size changes so Portfolio and Signals share
  // the same fresh prices regardless of which tab opened first.
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
  }

  return (
    <div className="app-shell">
      <Nav view={view} setView={setView} watchlistCount={watchlist.length} />
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
