import './Nav.css'

export default function Nav({ view, setView, watchlistCount }) {
  return (
    <header className="nav">
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
      </nav>
      <div className="nav-status">
        <span className="status-dot" />
        <span className="status-text">Live data</span>
      </div>
    </header>
  )
}
