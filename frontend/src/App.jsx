import { useEffect, useState } from 'react'
import Screener from './components/Screener.jsx'
import Portfolio from './components/Portfolio.jsx'
import Nav from './components/Nav.jsx'
import { storage } from './lib/storage.js'
import './App.css'

export default function App() {
  const [view, setView] = useState('screener')
  const [watchlist, setWatchlist] = useState(() => storage.loadWatchlist())

  useEffect(() => {
    storage.saveWatchlist(watchlist)
  }, [watchlist])

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
          />
        )}
      </main>
    </div>
  )
}
