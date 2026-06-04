import { useEffect, useState, useCallback, Fragment } from 'react'
import { screenStocks, getUniverse } from '../lib/api.js'
import {
  scoreColor, scoreBg,
  fmtNum, fmtPct, fmtMarketCap, fmtVolume,
} from '../lib/scoring.js'
import { PROFILES, PROFILE_KEYS, DEFAULT_PROFILE, getProfile } from '../lib/profiles.js'
import { storage } from '../lib/storage.js'
import ScoreBar from './ScoreBar.jsx'
import SectorHeatmap from './SectorHeatmap.jsx'
import SlicesBadge from './SlicesBadge.jsx'
import './SectorHeatmap.css'
import './SlicesBadge.css'
import './Screener.css'

const SECTORS = [
  '', 'Technology', 'Healthcare', 'Financials',
  'Consumer Discretionary', 'Consumer Staples',
  'Industrials', 'Energy', 'Materials',
  'Communication Services', 'Real Estate', 'Utilities'
]

const CAP_OPTIONS = [
  { value: '', label: 'Any cap' },
  { value: 'sm', label: 'Small ($300M–$2B)' },
  { value: 'md', label: 'Mid ($2B–$10B)' },
  { value: 'lg', label: 'Large ($10B–$200B)' },
  { value: 'mg', label: 'Mega ($200B+)' },
]

const PILLAR_LABELS = {
  fundamentals: 'Fund',
  momentum:     'Mom',
  sentiment:    'Sent',
  filings:      'Filings',
  insider:      'Insider',
}

// API returns legacy keys for the flat pillars dict
const LEGACY_PILLAR_KEYS = ['fundamentals', 'momentum', 'sentiment', 'filingTone', 'insider']
const LEGACY_LABELS = ['Fund', 'Mom', 'Sent', 'Filings', 'Insider']

export default function Screener({ watchlist, onAddToWatchlist, onRemoveFromWatchlist }) {
  const [filters, setFilters] = useState({
    sector: '', cap: 'md',
    peMax: 40, priceMin: 10, priceMax: 500,
    volMin: 500, betaMax: 1.5,
    universeSize: 'medium',  // small (250) | medium (500) | full (~900, risk of timeout)
  })
  const [slicesOnly, setSlicesOnly] = useState(false)
  const [profile, setProfile] = useState(() => storage.loadProfile() || DEFAULT_PROFILE)
  const [results, setResults] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [sortKey, setSortKey] = useState('composite')
  const [sortDir, setSortDir] = useState(-1)
  const [expandedRow, setExpandedRow] = useState(null)
  const [methodologyVersion, setMethodologyVersion] = useState(null)
  const [universeInfo, setUniverseInfo] = useState(null)
  const [universeRefreshing, setUniverseRefreshing] = useState(false)
  const [showAll, setShowAll] = useState(false)

  const TOP_N_DEFAULT = 50

  useEffect(() => { storage.saveProfile(profile) }, [profile])

  useEffect(() => {
    getUniverse().then(setUniverseInfo).catch(() => {})
  }, [])

  async function refreshUniverse() {
    setUniverseRefreshing(true)
    try {
      const info = await getUniverse({ refresh: true })
      setUniverseInfo(info)
    } catch (e) {
      console.error('Universe refresh failed:', e)
    } finally {
      setUniverseRefreshing(false)
    }
  }

  const watchSet = new Set(watchlist.map(s => s.ticker))
  const profileMeta = getProfile(profile)

  function setFilter(k, v) {
    setFilters(prev => ({ ...prev, [k]: v }))
  }

  const runScreen = useCallback(async (overrides = null) => {
    setLoading(true)
    setError(null)
    setResults(null)
    setShowAll(false)  // collapse back to top-N when re-running
    try {
      // Accept overrides so callers (e.g. sector heatmap clicks) can run with
      // a freshly-changed filter without waiting for the setState round-trip.
      const finalParams = { ...filters, ...(overrides || {}), profile }
      const raw = await screenStocks(finalParams)
      setResults(raw)
      if (raw[0]?.methodologyVersion) setMethodologyVersion(raw[0].methodologyVersion)
      // Snapshot composite scores for the movers card on the Signals tab.
      for (const stock of raw) {
        storage.appendScoreSnapshot(stock.ticker, {
          composite: stock.composite,
          profile: stock.profile,
          methodologyVersion: stock.methodologyVersion,
        })
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [filters, profile])

  function handleSort(key) {
    if (sortKey === key) {
      setSortDir(d => d * -1)
    } else {
      setSortKey(key)
      setSortDir(-1)
    }
  }

  const sorted = results
    ? [...results]
        .filter(r => !slicesOnly || r.slices)
        .sort((a, b) => {
          const av = sortKey === 'composite' ? a.composite : (a[sortKey] ?? -999)
          const bv = sortKey === 'composite' ? b.composite : (b[sortKey] ?? -999)
          return sortDir * (av > bv ? 1 : av < bv ? -1 : 0)
        })
    : []

  function toggleRow(ticker) {
    setExpandedRow(prev => prev === ticker ? null : ticker)
  }

  return (
    <div className="screener">
      <div className="screener-header">
        <h1 className="page-title">
          Stock <em>Screener</em>
        </h1>
        <p className="page-subtitle">
          Profile-aware peer-percentile scoring · methodology {methodologyVersion || '—'}
        </p>
        {universeInfo && (
          <div className="universe-indicator">
            <span className="ui-label">Universe:</span>
            <strong>{universeInfo.count} stocks</strong>
            {universeInfo.refreshed_at && (
              <span className="ui-stale">
                · refreshed {new Date(universeInfo.refreshed_at).toLocaleDateString()}
              </span>
            )}
            {universeInfo.source === 'fallback' && (
              <span className="ui-fallback" title="Wikipedia parse failed; using fallback list">
                · fallback
              </span>
            )}
            <button className="ui-refresh-btn" onClick={refreshUniverse}
              disabled={universeRefreshing} title="Re-fetch S&P 500 / 400 from Wikipedia">
              {universeRefreshing ? '…' : '↻'}
            </button>
          </div>
        )}
      </div>

      <div className="screener-panels">
        {/* ── PASS 1 ── */}
        <section className="panel">
          <div className="panel-label">Pass 1 — Quick filter</div>
          <div className="filter-grid">
            <div className="filter-field">
              <label>Sector</label>
              <select value={filters.sector} onChange={e => setFilter('sector', e.target.value)}>
                {SECTORS.map(s => <option key={s} value={s}>{s || 'All sectors'}</option>)}
              </select>
            </div>
            <div className="filter-field">
              <label>Market cap</label>
              <select value={filters.cap} onChange={e => setFilter('cap', e.target.value)}>
                {CAP_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div className="filter-field">
              <label>P/E max</label>
              <input type="number" value={filters.peMax} min={1} max={500} step={1}
                onChange={e => setFilter('peMax', +e.target.value)} />
            </div>
            <div className="filter-field">
              <label>Price min ($)</label>
              <input type="number" value={filters.priceMin} min={0} step={1}
                onChange={e => setFilter('priceMin', +e.target.value)} />
            </div>
            <div className="filter-field">
              <label>Price max ($)</label>
              <input type="number" value={filters.priceMax} min={0} step={1}
                onChange={e => setFilter('priceMax', +e.target.value)} />
            </div>
            <div className="filter-field">
              <label>Min vol (K/day)</label>
              <input type="number" value={filters.volMin} min={0} step={100}
                onChange={e => setFilter('volMin', +e.target.value)} />
            </div>
            <div className="filter-field">
              <label>Universe</label>
              <select value={filters.universeSize}
                onChange={e => setFilter('universeSize', e.target.value)}
                title="Larger universe = broader scan but risk of timeout">
                <option value="small">Small (~100)</option>
                <option value="medium">Medium (~200)</option>
                <option value="large">Large (~400)</option>
                <option value="full">Full (~900, may time out)</option>
              </select>
            </div>
            <div className="filter-field filter-field--checkbox">
              <label htmlFor="slicesOnly">Schwab Slices</label>
              <label className="slices-toggle" title="Show only S&P 500 names eligible for Schwab Stock Slices">
                <input id="slicesOnly" type="checkbox" checked={slicesOnly}
                  onChange={e => setSlicesOnly(e.target.checked)} />
                <span>Slices-eligible only</span>
              </label>
            </div>
            <div className="filter-field">
              <label>Beta max</label>
              <input type="number" value={filters.betaMax} min={0} max={5} step={0.1}
                onChange={e => setFilter('betaMax', +e.target.value)} />
            </div>
          </div>
        </section>

        {/* ── PASS 2: PROFILE PICKER ── */}
        <section className="panel">
          <div className="panel-label">Pass 2 — Investment profile</div>

          <div className="profile-grid">
            {PROFILE_KEYS.map(key => {
              const p = PROFILES[key]
              const active = profile === key
              return (
                <button
                  key={key}
                  type="button"
                  className={`profile-card ${active ? 'active' : ''}`}
                  onClick={() => setProfile(key)}
                >
                  <div className="profile-card-label">{p.label}</div>
                  <div className="profile-card-desc">{p.description}</div>
                </button>
              )
            })}
          </div>

          <div className="profile-weights">
            <span className="profile-weights-label">Pillar weights</span>
            {Object.entries(profileMeta.pillarWeights).map(([k, v]) => (
              <span key={k} className="profile-weight-chip">
                {PILLAR_LABELS[k]} <strong>{v}</strong>
              </span>
            ))}
          </div>

          <button
            className="run-btn"
            onClick={runScreen}
            disabled={loading}
          >
            {loading ? 'Fetching live data…' : 'Run screen'}
          </button>
        </section>
      </div>

      {error && (
        <div className="error-banner">
          Could not fetch data: {error}
          {import.meta.env.DEV && (
            <span className="error-hint"> · check that the backend is running on :8000</span>
          )}
        </div>
      )}

      {loading && (
        <div className="loading-state">
          <div className="spinner" />
          <span>Fetching live data + scoring against peer set…</span>
        </div>
      )}

      {results && !loading && (
        <section className="results-section">
          <SectorHeatmap
            results={results}
            activeSector={filters.sector}
            onSectorClick={(sec) => {
              setFilter('sector', sec)
              // Pass sec as override so runScreen doesn't see the stale
              // filters value before setFilter has settled.
              runScreen({ sector: sec })
            }}
          />
          <div className="results-header">
            <div className="results-stats">
              <span className="stat"><strong>{results.length}</strong> passed filters</span>
              <span className="stat"><strong>{results.filter(s => s.composite >= 75).length}</strong> scored 75+</span>
              <span className="stat"><strong>{results.filter(s => watchSet.has(s.ticker)).length}</strong> on watchlist</span>
              <span className="stat profile-badge">Profile: <strong>{profileMeta.short}</strong></span>
              <DataSourceBadge results={results} />
            </div>
          </div>

          {results.length === 0 ? (
            <p className="empty-state">No stocks matched. Widen your filters.</p>
          ) : (
            <div className="table-wrap">
              <table className="results-table">
                <thead>
                  <tr>
                    <th onClick={() => handleSort('ticker')} className="sortable">Ticker</th>
                    <th onClick={() => handleSort('composite')} className="sortable">Score</th>
                    <th onClick={() => handleSort('price')} className="sortable">Price</th>
                    <th onClick={() => handleSort('pe')} className="sortable">P/E</th>
                    <th onClick={() => handleSort('marketCap')} className="sortable">Mkt cap</th>
                    <th onClick={() => handleSort('beta')} className="sortable">Beta</th>
                    <th>Pillar breakdown</th>
                    <th>Flags</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {(showAll ? sorted : sorted.slice(0, TOP_N_DEFAULT)).map(stock => (
                    <Fragment key={stock.ticker}>
                      <tr
                        className={`result-row ${expandedRow === stock.ticker ? 'expanded' : ''}`}
                        onClick={() => toggleRow(stock.ticker)}
                      >
                        <td>
                          <div className="ticker-cell">
                            <span className="ticker-sym">
                              {stock.ticker}
                              <SlicesBadge active={stock.slices} />
                            </span>
                            <span className="ticker-name">{stock.name}</span>
                          </div>
                        </td>
                        <td>
                          <span className="score-chip"
                            style={{ color: scoreColor(stock.composite), background: scoreBg(stock.composite) }}>
                            {stock.composite}
                          </span>
                        </td>
                        <td className="mono">${fmtNum(stock.price)}</td>
                        <td className="mono">{stock.pe ? fmtNum(stock.pe, 1) : '—'}</td>
                        <td className="mono">{fmtMarketCap(stock.marketCap)}</td>
                        <td className="mono">{fmtNum(stock.beta, 2)}</td>
                        <td>
                          <div className="mini-bars">
                            {LEGACY_PILLAR_KEYS.map((key, i) => (
                              <ScoreBar key={key} label={LEGACY_LABELS[i]} value={Math.round(stock.scores?.[key] ?? 0)} />
                            ))}
                          </div>
                        </td>
                        <td>
                          <div className="flags">
                            {stock.flags?.map((f, i) => (
                              <span key={`${f.label}-${i}`} className={`flag flag-${f.type}`}>{f.label}</span>
                            ))}
                          </div>
                        </td>
                        <td onClick={e => e.stopPropagation()}>
                          <button
                            className={`watchlist-btn ${watchSet.has(stock.ticker) ? 'active' : ''}`}
                            onClick={() => watchSet.has(stock.ticker)
                              ? onRemoveFromWatchlist(stock.ticker)
                              : onAddToWatchlist(stock)}
                          >
                            {watchSet.has(stock.ticker) ? '✓' : '+'}
                          </button>
                        </td>
                      </tr>
                      {expandedRow === stock.ticker && (
                        <tr className="detail-row">
                          <td colSpan={9}>
                            <div className="detail-panel">
                              <div className="detail-why">
                                <span className="detail-label">Why it surfaced</span>
                                <p>{stock.why || 'Deep analysis available after data fetch.'}</p>
                              </div>
                              <div className="detail-metrics">
                                <div className="dm-item"><span>52W High</span><strong>{stock.high52w ? `$${fmtNum(stock.high52w)}` : '—'}</strong></div>
                                <div className="dm-item"><span>52W Low</span><strong>{stock.low52w ? `$${fmtNum(stock.low52w)}` : '—'}</strong></div>
                                <div className="dm-item"><span>Volume</span><strong>{fmtVolume(stock.volume)}</strong></div>
                                <div className="dm-item"><span>Div Yield</span><strong>{stock.divYield ? fmtPct(stock.divYield) : '—'}</strong></div>
                                <div className="dm-item"><span>Sector</span><strong>{stock.sector || '—'}</strong></div>
                              </div>
                              {stock.breakdown && <ScoreBreakdown breakdown={stock.breakdown} />}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
              {!showAll && sorted.length > TOP_N_DEFAULT && (
                <div className="show-more-row">
                  <button className="show-more-btn" onClick={() => setShowAll(true)}>
                    Show all {sorted.length} results
                    <span className="show-more-hint">
                      · currently showing top {TOP_N_DEFAULT} by {sortKey === 'composite' ? 'composite score' : sortKey}
                    </span>
                  </button>
                </div>
              )}
              {showAll && sorted.length > TOP_N_DEFAULT && (
                <div className="show-more-row">
                  <button className="show-more-btn" onClick={() => setShowAll(false)}>
                    Collapse to top {TOP_N_DEFAULT}
                  </button>
                </div>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  )
}

/**
 * Surfaces the dataSource field that screen.mjs already sets on every result
 * but the UI was hiding. Tells the user at a glance whether they're looking
 * at Schwab real-time data or the FMP fallback (delayed).
 */
function DataSourceBadge({ results }) {
  if (!results?.length) return null
  const sources = new Set(results.map(r => r.dataSource).filter(Boolean))
  if (!sources.size) return null

  let label, tier
  if (sources.size > 1) {
    label = 'Mixed sources'
    tier  = 'mixed'
  } else {
    const src = [...sources][0]
    if (src === 'schwab+fmp') { label = 'Schwab live'; tier = 'good' }
    else if (src === 'fmp')   { label = 'FMP delayed'; tier = 'warn' }
    else                       { label = src;          tier = 'neutral' }
  }
  return (
    <span className={`stat data-source-badge data-source-badge--${tier}`}
      title="Data source: Schwab quotes are real-time, FMP is delayed ~15 min">
      {label}
    </span>
  )
}


function ScoreBreakdown({ breakdown }) {
  return (
    <div className="score-breakdown">
      <span className="detail-label">Score breakdown</span>
      <div className="bd-grid">
        {breakdown.map(pillar => (
          <div key={pillar.pillar} className="bd-pillar">
            <div className="bd-pillar-head">
              <span className="bd-pillar-name">{pillar.pillar}</span>
              <span className="bd-pillar-score">{Math.round(pillar.score)}</span>
              <span className="bd-pillar-weight">w{Math.round(pillar.weight)}</span>
            </div>
            <ul className="bd-contribs">
              {pillar.contributions.map(c => (
                <li key={c.metric} className={c.score === null ? 'bd-na' : ''}>
                  <span className="bd-metric">{c.metric}</span>
                  <span className="bd-raw">{formatRaw(c.raw)}</span>
                  <span className="bd-score">{c.score === null ? '—' : Math.round(c.score)}</span>
                  <span className="bd-rationale">{c.rationale}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  )
}

function formatRaw(v) {
  if (v === null || v === undefined) return '—'
  if (typeof v !== 'number') return String(v)
  if (Math.abs(v) < 0.01) return v.toExponential(1)
  if (Math.abs(v) < 1) return v.toFixed(3)
  if (Math.abs(v) < 100) return v.toFixed(2)
  return Math.round(v).toString()
}
