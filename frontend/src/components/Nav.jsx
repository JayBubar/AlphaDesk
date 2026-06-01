import { useEffect, useState } from 'react'
import { connectSchwab } from '../lib/api'
import './Nav.css'

export default function Nav({ view, setView, watchlistCount, schwabConnected }) {
  const [toast, setToast] = useState('')

  useEffect(() => {
    // Detect ?schwab=connected redirect from OAuth callback.
    const params = new URLSearchParams(window.location.search)
    if (params.get('schwab') === 'connected') {
      setToast('Schwab connected ✓ — syncing holdings…')
      setTimeout(() => setToast(''), 4000)
      window.history.replaceState({}, '', window.location.pathname)
    }
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
        {schwabConnected === null ? null : schwabConnected ? (
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
