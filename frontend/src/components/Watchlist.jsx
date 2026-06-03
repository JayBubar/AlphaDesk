/**
 * Watchlist — the research bench.
 *
 * Manual picks from the Screener. Each row expands to show the full research
 * stack: FilingPanel (10-K NLP), ResearchPanel (Perplexity), InsiderPanel
 * (SEC Form 4), BacktestPanel (FMP history replay). The Signals tab consumes
 * the subset of these the user stars as favorites.
 */
import { useState, Fragment } from 'react'
import { fmtNum, fmtPct, scoreColor, scoreBg } from '../lib/scoring.js'
import ScoreBar from './ScoreBar.jsx'
import StarButton from './StarButton.jsx'
import FilingPanel from './FilingPanel.jsx'
import ResearchPanel from './ResearchPanel.jsx'
import InsiderPanel from './InsiderPanel.jsx'
import BacktestPanel from './BacktestPanel.jsx'
import './Watchlist.css'

const PILLAR_KEYS = ['fundamentals', 'momentum', 'sentiment', 'filingTone', 'insider']

export default function Watchlist({
  watchlist,
  onRemoveFromWatchlist,
  livePrice,
  refreshAllPrices,
  refreshing,
  lastRefresh,
  favorites,
  onToggleFavorite,
}) {
  const [expanded, setExpanded] = useState(null)
  const [sortKey, setSortKey] = useState('composite')
  const [sortDir, setSortDir] = useState(-1)

  function handleSort(key) {
    if (sortKey === key) setSortDir(d => d * -1)
    else { setSortKey(key); setSortDir(-1) }
  }

  const rows = watchlist.map(s => {
    const price  = livePrice[s.ticker]?.price ?? s.price ?? 0
    const change = livePrice[s.ticker]?.change ?? s.change ?? 0
    return { ...s, price, change }
  })

  const sorted = [...rows].sort((a, b) => {
    const av = sortKey === 'composite' ? (a.composite ?? -1) : (a[sortKey] ?? -Infinity)
    const bv = sortKey === 'composite' ? (b.composite ?? -1) : (b[sortKey] ?? -Infinity)
    if (typeof av === 'string' || typeof bv === 'string') {
      return sortDir * String(av).localeCompare(String(bv))
    }
    return sortDir * (av > bv ? 1 : av < bv ? -1 : 0)
  })

  const starredCount = rows.filter(r => favorites.has(r.ticker)).length

  return (
    <div className="watchlist">
      <div className="watchlist-header">
        <div>
          <h1 className="page-title">Research <em>Watchlist</em></h1>
          <p className="page-subtitle">
            {watchlist.length} stocks · {starredCount} starred ·
            click any row to expand 10-K, news, insider, and backtest
          </p>
        </div>
        <div className="header-actions">
          {lastRefresh && (
            <span className="last-refresh">Quotes {lastRefresh.toLocaleTimeString()}</span>
          )}
          <button className="refresh-btn" onClick={refreshAllPrices} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh prices'}
          </button>
        </div>
      </div>

      {watchlist.length === 0 ? (
        <div className="watchlist-empty">
          <p className="empty-title">No stocks on the watchlist yet.</p>
          <p className="empty-sub">Use the Screener tab to find and add candidates.</p>
        </div>
      ) : (
        <div className="watchlist-table-wrap">
          <table className="watchlist-table">
            <thead>
              <tr>
                <th className="th-star"></th>
                <th onClick={() => handleSort('ticker')} className="sortable">Ticker</th>
                <th onClick={() => handleSort('composite')} className="sortable">Score</th>
                <th onClick={() => handleSort('price')} className="sortable">Price</th>
                <th onClick={() => handleSort('change')} className="sortable">Day</th>
                <th>Pillars</th>
                <th>Sector</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(r => {
                const isOpen = expanded === r.ticker
                const isStarred = favorites.has(r.ticker)
                return (
                  <Fragment key={r.ticker}>
                    <tr className={`wl-row ${isOpen ? 'expanded' : ''}`}
                      onClick={() => setExpanded(isOpen ? null : r.ticker)}>
                      <td className="td-star" onClick={(e) => e.stopPropagation()}>
                        <StarButton
                          active={isStarred}
                          onToggle={() => onToggleFavorite(r.ticker)}
                        />
                      </td>
                      <td>
                        <div className="ticker-sym">{r.ticker}</div>
                        <div className="ticker-name">{r.name}</div>
                      </td>
                      <td>
                        <span className="score-chip"
                          style={{
                            color: scoreColor(r.composite ?? 0),
                            background: scoreBg(r.composite ?? 0),
                          }}>
                          {r.composite ?? '—'}
                        </span>
                      </td>
                      <td className="mono">
                        {refreshing ? <span className="muted">…</span> : `$${fmtNum(r.price)}`}
                      </td>
                      <td className="mono"
                        style={{ color: r.change >= 0 ? 'var(--green)' : 'var(--red)' }}>
                        {r.change != null ? fmtPct(r.change) : '—'}
                      </td>
                      <td>
                        <div className="mini-bars">
                          {PILLAR_KEYS.map(k => (
                            <ScoreBar key={k} label={k.slice(0, 4)} value={r.scores?.[k] ?? 0} />
                          ))}
                        </div>
                      </td>
                      <td className="muted">{r.sector || '—'}</td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <button className="remove-btn"
                          onClick={() => onRemoveFromWatchlist(r.ticker)}
                          title="Remove from watchlist">
                          ✕
                        </button>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="wl-expanded-row">
                        <td colSpan={8}>
                          <div className="wl-expanded">
                            {r.why && (
                              <div className="wl-thesis">
                                <span className="wl-thesis-label">Why I'm watching</span>
                                <p>{r.why}</p>
                              </div>
                            )}
                            <FilingPanel ticker={r.ticker} />
                            <ResearchPanel ticker={r.ticker} />
                            <InsiderPanel ticker={r.ticker} />
                            <BacktestPanel ticker={r.ticker} />
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
