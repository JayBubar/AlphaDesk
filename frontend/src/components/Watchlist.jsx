/**
 * Watchlist — the research bench.
 *
 * Manual picks from the Screener. Each row expands to show the full research
 * stack: FilingPanel (10-K NLP), ResearchPanel (Perplexity), InsiderPanel
 * (SEC Form 4), BacktestPanel (FMP history replay). The Signals tab consumes
 * the subset of these the user stars as favorites.
 */
import { useEffect, useState, Fragment } from 'react'
import { fmtNum, fmtPct, scoreColor, scoreBg } from '../lib/scoring.js'
import ScoreBar from './ScoreBar.jsx'
import StarButton from './StarButton.jsx'
import SlicesBadge from './SlicesBadge.jsx'
import FilingPanel from './FilingPanel.jsx'
import ResearchPanel from './ResearchPanel.jsx'
import InsiderPanel from './InsiderPanel.jsx'
import BacktestPanel from './BacktestPanel.jsx'
import './SlicesBadge.css'
import './Watchlist.css'

const PILLAR_KEYS = ['fundamentals', 'momentum', 'sentiment', 'filingTone', 'insider']

function fmtDateCell(iso) {
  if (!iso) return { label: '—', tier: 'muted' }
  const days = Math.ceil((new Date(iso).getTime() - Date.now()) / 86400_000)
  if (days < 0) return { label: '—', tier: 'muted' }
  const date = new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  let tier = 'muted'
  if (days <= 7) tier = 'soon'
  else if (days <= 14) tier = 'near'
  return { label: `${date} (${days}d)`, tier }
}

/**
 * Inline thesis editor. Loads the saved user thesis, falls back to the
 * screener-generated `why` if none. Auto-saves on blur. The fallback text
 * is shown as placeholder so the user can see what was auto-generated
 * without it polluting the saved value.
 */
function ThesisEditor({ stock, onSetThesis }) {
  const [value, setValue] = useState(stock.userThesis || '')
  const [savedFeedback, setSavedFeedback] = useState(false)

  // Re-sync when switching between tickers (component reused across rows).
  useEffect(() => { setValue(stock.userThesis || '') }, [stock.ticker, stock.userThesis])

  function handleBlur() {
    const next = value.trim()
    if (next === (stock.userThesis || '').trim()) return  // no change
    onSetThesis?.(stock.ticker, next)
    setSavedFeedback(true)
    setTimeout(() => setSavedFeedback(false), 1200)
  }

  return (
    <div className="wl-thesis">
      <div className="wl-thesis-head">
        <span className="wl-thesis-label">Why I'm watching</span>
        {savedFeedback && <span className="wl-thesis-saved">saved ✓</span>}
      </div>
      <textarea
        className="wl-thesis-input"
        value={value}
        onChange={e => setValue(e.target.value)}
        onBlur={handleBlur}
        placeholder={stock.why ? `Auto: ${stock.why}` : 'What caught your eye? Save on click-away.'}
        rows={2}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  )
}

export default function Watchlist({
  watchlist,
  onRemoveFromWatchlist,
  livePrice,
  refreshAllPrices,
  refreshing,
  lastRefresh,
  favorites,
  onToggleFavorite,
  onSetThesis,
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
                <th onClick={() => handleSort('nextEarnings')} className="sortable">Earnings</th>
                <th onClick={() => handleSort('nextDividend')} className="sortable">Ex-div</th>
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
                        <div className="ticker-sym">
                          {r.ticker}
                          <SlicesBadge active={r.slices} />
                        </div>
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
                      <td className="mono">
                        {(() => {
                          const e = fmtDateCell(r.nextEarnings)
                          return <span className={`date-cell date-cell--${e.tier}`}>{e.label}</span>
                        })()}
                      </td>
                      <td className="mono">
                        {(() => {
                          const d = fmtDateCell(r.nextDividend)
                          return (
                            <span className={`date-cell date-cell--${d.tier}`}>
                              {d.label}
                              {r.divAmount > 0 && d.tier !== 'muted' && (
                                <span className="div-amount"> ${r.divAmount.toFixed(2)}</span>
                              )}
                            </span>
                          )
                        })()}
                      </td>
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
                        <td colSpan={10}>
                          <div className="wl-expanded">
                            <ThesisEditor stock={r} onSetThesis={onSetThesis} />
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
