import { useEffect, useState } from 'react'
import { getSchwabStatus, connectSchwab } from '../lib/api'
import './Nav.css'

export default function Nav({ view, setView, watchlistCount }) {
  const [schwab, setSchwab] = useState(null)   // null = loading, true/false = status
  const [toast, setToast]   = useState('')

  useEffect(() => {
    // Check for ?schwab=connected redirect from OAuth callback
    const params = new URLSearchParams(window.location.search)
    if (params.get('schwab') === 'connected') {
      setToast('Schwab connected ✓')
      setTimeout(() => setToast(''), 4000)
      // Clean the URL
      window.history.replaceState({}, '', window.location.pathname)
    }

    getSchwabStatus().then(s => setSchwab(s.connected))
  }, [])

  return (
    <header className="nav">
      {toast && <div className="nav-toast">{toast}</div>}

      <div className="nav-brand">
        <span className="nav-logo">α</span>
        <span className="nav-title">AlphaDesk</span>
      </div>

      <nav className="nav-links">
        <button
          className={`nav-btn ${view === 'screener' ? 'active' : ''}`}
          onClick={() => setView('screener')}
        >
          Screener
        </button>
        <button
          className={`nav-btn ${view === 'portfolio' ? 'active' : ''}`}
          onClick={() => setView('portfolio')}
        >
          Portfolio
          {watchlistCount > 0 && (
            <span className="nav-badge">{watchlistCount}</span>
          )}
        </button>
        <button
          className={`nav-btn ${view === 'signals' ? 'active' : ''}`}
          onClick={() => setView('signals')}
        >
          Signals
        </button>
      </nav>

      <div className="nav-status">
        {schwab === null ? null : schwab ? (
          <>
            <span className="status-dot status-dot--schwab" />
            <span className="status-text">Schwab live</span>
          </>
        ) : (
          <>
            <button className="nav-connect-btn" onClick={connectSchwab}>
              Connect Schwab
            </button>
            <span className="status-dot" />
            <span className="status-text">Delayed data</span>
          </>
        )}
      </div>
    </header>
  )
}
