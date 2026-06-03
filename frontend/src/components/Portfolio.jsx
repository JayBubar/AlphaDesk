/**
 * Portfolio — Schwab-synced holdings only.
 *
 * No manual entry: positions come exclusively from the /api/holdings sync.
 * Research panels (FilingPanel / ResearchPanel / InsiderPanel / BacktestPanel)
 * live in the row expand-out and are collapsed by default since the primary
 * use case here is P&L tracking, not research.
 *
 * Stars work across both tabs; this row also exposes the star toggle so you
 * can favorite a current holding for the Signals tab.
 */
import { useState, Fragment } from 'react'
import {
  PieChart, Pie, Cell,
  BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer,
} from 'recharts'
import { fmtNum, fmtPct, scoreColor, scoreBg } from '../lib/scoring.js'
import StarButton from './StarButton.jsx'
import FilingPanel from './FilingPanel.jsx'
import ResearchPanel from './ResearchPanel.jsx'
import InsiderPanel from './InsiderPanel.jsx'
import BacktestPanel from './BacktestPanel.jsx'
import './Portfolio.css'

const SECTOR_COLORS = [
  '#c9a84c', '#60a5fa', '#3ecf8e', '#f87171', '#a78bfa',
  '#fb923c', '#34d399', '#f472b6', '#38bdf8', '#facc15',
]

function relativeTime(iso) {
  if (!iso) return null
  const elapsedMs = Date.now() - new Date(iso).getTime()
  if (elapsedMs < 60_000) return 'just now'
  const mins = Math.floor(elapsedMs / 60_000)
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

const ChartTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null
  return (
    <div style={{
      background: 'var(--bg-card)', border: '1px solid var(--border-accent)',
      borderRadius: '8px', padding: '10px 14px', fontSize: '12px'
    }}>
      <p style={{ color: 'var(--text-muted)', marginBottom: 4 }}>{label}</p>
      {payload.map((p, i) => (
        <p key={i} style={{ color: p.color || 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
          {p.name}: {typeof p.value === 'number' && p.name !== 'Score'
            ? `$${p.value.toFixed(2)}`
            : p.value}
        </p>
      ))}
    </div>
  )
}

export default function Portfolio({
  positions,
  livePrice,
  refreshAllPrices,
  refreshing,
  lastRefresh,
  schwabConnected,
  schwabSyncing,
  schwabError,
  schwabLastSync,
  onSchwabSync,
  schwabSuppressed = [],
  onUnsuppressSchwab,
  onSuppressPosition,
  favorites,
  onToggleFavorite,
}) {
  const [activeTab, setActiveTab] = useState('positions')
  const [expanded, setExpanded] = useState(null)
  const [showSuppressed, setShowSuppressed] = useState(false)

  // Only Schwab-sourced positions render in Portfolio. Legacy manual entries
  // (no source flag) stay in localStorage but don't appear here.
  const schwabTickers = Object.keys(positions).filter(t => positions[t]?.source === 'schwab')

  const rows = schwabTickers.map(ticker => {
    const pos = positions[ticker]
    const isEquity = pos.assetType === 'EQUITY'
    // Schwab's currentPrice is authoritative; livePrice from /api/prices is
    // a fallback if Schwab's snapshot is stale.
    const price = pos.currentPrice ?? livePrice[ticker]?.price ?? 0
    const change = livePrice[ticker]?.change ?? null
    return {
      ticker,
      name: pos.name || ticker,
      pos,
      isEquity,
      price,
      change,
      shares: pos.shares,
      costBasis: pos.costBasis,
      mktValue: pos.marketValue ?? (pos.shares * price),
      gainAbs:  pos.gainLoss ?? 0,
      gainPct:  pos.gainLossPct ?? 0,
      assetType: pos.assetType || 'EQUITY',
      accountNumber: pos.accountNumber,
    }
  })

  const totalValue = rows.reduce((s, r) => s + (r.mktValue || 0), 0)
  const totalCost  = rows.reduce((s, r) => s + (r.shares * r.costBasis || 0), 0)
  const totalGain  = totalValue - totalCost
  const totalGainPct = totalCost > 0 ? (totalGain / totalCost) * 100 : 0

  const dayChange = rows.reduce((s, r) => {
    if (!r.shares || !r.price || r.change == null) return s
    const prev = r.price / (1 + (r.change || 0) / 100)
    return s + r.shares * (r.price - prev)
  }, 0)

  // Sector pie (Schwab doesn't give sector — leave for v2; show asset-type pie instead).
  const assetTypeMap = {}
  rows.forEach(r => {
    if (!r.mktValue) return
    const key = r.assetType || 'OTHER'
    assetTypeMap[key] = (assetTypeMap[key] || 0) + r.mktValue
  })
  const assetTypeData = Object.entries(assetTypeMap).map(([name, value]) => ({
    name, value: +value.toFixed(2),
    pct: totalValue > 0 ? ((value / totalValue) * 100).toFixed(1) : '0',
  }))

  const glData = rows
    .filter(r => r.shares > 0)
    .map(r => ({ ticker: r.ticker, gain: +(r.gainAbs || 0).toFixed(2) }))
    .sort((a, b) => b.gain - a.gain)

  return (
    <div className="portfolio">
      <div className="portfolio-header">
        <div>
          <h1 className="page-title">Portfolio <em>Tracker</em></h1>
          <p className="page-subtitle">
            {schwabConnected
              ? `${rows.length} live Schwab holdings`
              : 'Connect Schwab to sync your portfolio'}
          </p>
        </div>
        <div className="header-actions">
          {(lastRefresh || schwabLastSync) && (
            <div className="freshness-stack">
              {lastRefresh && (
                <span className="freshness-line">
                  <span className="freshness-dot" />
                  Quotes {lastRefresh.toLocaleTimeString()}
                </span>
              )}
              {schwabConnected && schwabLastSync && (
                <span className="freshness-line freshness-line--schwab">
                  <span className="freshness-dot freshness-dot--schwab" />
                  Schwab {relativeTime(schwabLastSync)}
                </span>
              )}
            </div>
          )}
          {schwabConnected && (
            <button className="refresh-btn schwab-sync-btn" onClick={onSchwabSync}
              disabled={schwabSyncing} title="Re-pull positions from Schwab">
              {schwabSyncing ? 'Syncing…' : 'Sync Schwab'}
            </button>
          )}
          <button className="refresh-btn" onClick={refreshAllPrices} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh prices'}
          </button>
        </div>
      </div>

      {schwabError && (
        <div className="schwab-error-banner">{schwabError}</div>
      )}

      {schwabConnected && schwabSuppressed.length > 0 && (
        <div className="schwab-origin-bar">
          <span className="origin-summary">{rows.length} live positions</span>
          <button className="origin-suppressed-btn"
            onClick={() => setShowSuppressed(s => !s)}>
            {schwabSuppressed.length} hidden {showSuppressed ? '▲' : '▼'}
          </button>
        </div>
      )}

      {showSuppressed && schwabSuppressed.length > 0 && (
        <div className="schwab-suppressed-panel">
          <div className="suppressed-title">
            Hidden Schwab positions
            <span className="suppressed-hint">click to re-include and trigger sync</span>
          </div>
          <div className="suppressed-chips">
            {schwabSuppressed.map(t => (
              <button key={t} className="suppressed-chip"
                onClick={() => onUnsuppressSchwab?.(t)}
                title={`Re-include ${t} on the next Schwab sync`}>
                {t} <span className="suppressed-chip-x">×</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="summary-cards">
        <div className="sum-card">
          <span className="sum-label">Portfolio value</span>
          <span className="sum-val">${totalValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        </div>
        <div className="sum-card">
          <span className="sum-label">Total gain / loss</span>
          <span className="sum-val" style={{ color: totalGain >= 0 ? 'var(--green)' : 'var(--red)' }}>
            {totalGain >= 0 ? '+' : ''}${Math.abs(totalGain).toFixed(2)}
            <span style={{ fontSize: 13, marginLeft: 6 }}>({fmtPct(totalGainPct)})</span>
          </span>
        </div>
        <div className="sum-card">
          <span className="sum-label">Today's change</span>
          <span className="sum-val" style={{ color: dayChange >= 0 ? 'var(--green)' : 'var(--red)' }}>
            {dayChange >= 0 ? '+' : ''}${Math.abs(dayChange).toFixed(2)}
          </span>
        </div>
        <div className="sum-card">
          <span className="sum-label">Positions</span>
          <span className="sum-val">{rows.length}</span>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="empty-portfolio">
          {!schwabConnected ? (
            <>
              <p className="empty-title">Connect Schwab to populate the portfolio.</p>
              <p className="empty-sub">Use the Connect button in the top right.</p>
            </>
          ) : (
            <>
              <p className="empty-title">No Schwab positions yet.</p>
              <p className="empty-sub">Try the Sync Schwab button — or check that account holdings are visible in Schwab.</p>
            </>
          )}
        </div>
      ) : (
        <>
          <div className="tab-bar">
            {['positions', 'charts'].map(t => (
              <button key={t}
                className={`tab-btn ${activeTab === t ? 'active' : ''}`}
                onClick={() => setActiveTab(t)}>
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>

          {activeTab === 'positions' && (
            <div className="portfolio-table-wrap">
              <table className="portfolio-table">
                <thead>
                  <tr>
                    <th className="th-star"></th>
                    <th>Ticker</th>
                    <th>Type</th>
                    <th>Price</th>
                    <th>Day</th>
                    <th>Shares</th>
                    <th>Cost</th>
                    <th>Value</th>
                    <th>Gain / loss</th>
                    <th>Account</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => {
                    const isOpen = expanded === r.ticker
                    const isStarred = favorites?.has(r.ticker)
                    return (
                      <Fragment key={r.ticker}>
                        <tr className={`port-row ${isOpen ? 'expanded' : ''}`}
                          onClick={() => setExpanded(isOpen ? null : r.ticker)}>
                          <td className="td-star" onClick={(e) => e.stopPropagation()}>
                            <StarButton active={isStarred}
                              onToggle={() => onToggleFavorite(r.ticker)} />
                          </td>
                          <td>
                            <div className="ticker-sym">
                              {r.ticker}
                              <span className="live-badge"
                                title={`Schwab ${r.accountNumber || ''} · ${r.assetType}`}>LIVE</span>
                            </div>
                            <div className="ticker-name">{r.name}</div>
                          </td>
                          <td>
                            <span className={`asset-type-badge ${r.isEquity ? 'asset-type-badge--equity' : ''}`}>
                              {r.assetType}
                            </span>
                          </td>
                          <td className="mono">${fmtNum(r.price)}</td>
                          <td className="mono"
                            style={{ color: (r.change || 0) >= 0 ? 'var(--green)' : 'var(--red)' }}>
                            {r.change != null ? fmtPct(r.change) : '—'}
                          </td>
                          <td className="mono">{r.shares}</td>
                          <td className="mono">{r.costBasis ? `$${fmtNum(r.costBasis)}` : '—'}</td>
                          <td className="mono">{r.mktValue ? `$${r.mktValue.toFixed(2)}` : '—'}</td>
                          <td>
                            <span style={{
                              color: r.gainAbs >= 0 ? 'var(--green)' : 'var(--red)',
                              fontFamily: 'var(--font-mono)',
                              fontWeight: 500,
                            }}>
                              {r.gainAbs >= 0 ? '+' : ''}${Math.abs(r.gainAbs).toFixed(2)}
                              <span style={{ fontSize: 11, opacity: 0.8 }}>
                                {' '}({fmtPct(r.gainPct)})
                              </span>
                            </span>
                          </td>
                          <td className="mono muted">{r.accountNumber || '—'}</td>
                          <td onClick={(e) => e.stopPropagation()}>
                            <button className="remove-btn"
                              onClick={() => onSuppressPosition?.(r.ticker)}
                              title="Hide from portfolio view (does not affect actual holdings)">
                              ✕
                            </button>
                          </td>
                        </tr>
                        {isOpen && r.isEquity && (
                          <tr className="port-expanded-row">
                            <td colSpan={11}>
                              <div className="port-expanded">
                                <p className="port-research-hint">
                                  Research panels load on demand. Same data as Watchlist.
                                </p>
                                <FilingPanel ticker={r.ticker} />
                                <ResearchPanel ticker={r.ticker} />
                                <InsiderPanel ticker={r.ticker} />
                                <BacktestPanel ticker={r.ticker} />
                              </div>
                            </td>
                          </tr>
                        )}
                        {isOpen && !r.isEquity && (
                          <tr className="port-expanded-row">
                            <td colSpan={11}>
                              <div className="port-expanded port-expanded--noscore">
                                <p>{r.assetType} holdings aren't scored. Schwab data only.</p>
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

          {activeTab === 'charts' && (
            <div className="charts-grid">
              <div className="chart-card">
                <div className="chart-title">Allocation by asset type</div>
                {assetTypeData.length === 0 ? (
                  <p className="chart-empty">No positions yet.</p>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem', flexWrap: 'wrap' }}>
                    <ResponsiveContainer width={200} height={200}>
                      <PieChart>
                        <Pie data={assetTypeData} dataKey="value" nameKey="name"
                          cx="50%" cy="50%" outerRadius={85} innerRadius={45}>
                          {assetTypeData.map((_, i) => (
                            <Cell key={i} fill={SECTOR_COLORS[i % SECTOR_COLORS.length]} />
                          ))}
                        </Pie>
                        <Tooltip formatter={v => `$${v.toFixed(2)}`}
                          contentStyle={{
                            background: 'var(--bg-card)', border: '1px solid var(--border-accent)',
                            borderRadius: 8, fontSize: 12,
                          }} />
                      </PieChart>
                    </ResponsiveContainer>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {assetTypeData.map((s, i) => (
                        <div key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                          <div style={{ width: 10, height: 10, borderRadius: 2, flexShrink: 0,
                            background: SECTOR_COLORS[i % SECTOR_COLORS.length] }} />
                          <span style={{ color: 'var(--text-secondary)' }}>{s.name}</span>
                          <span style={{
                            fontFamily: 'var(--font-mono)', color: 'var(--text-primary)',
                            marginLeft: 'auto', paddingLeft: 20,
                          }}>{s.pct}%</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="chart-card">
                <div className="chart-title">Gain / loss by position ($)</div>
                {glData.length === 0 ? (
                  <p className="chart-empty">No positions yet.</p>
                ) : (
                  <ResponsiveContainer width="100%" height={Math.max(180, glData.length * 22)}>
                    <BarChart data={glData} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}
                      layout="vertical">
                      <XAxis type="number" tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                        axisLine={false} tickLine={false}
                        tickFormatter={v => `$${v}`} />
                      <YAxis type="category" dataKey="ticker" width={60}
                        tick={{ fontSize: 11, fill: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}
                        axisLine={false} tickLine={false} />
                      <Tooltip content={<ChartTooltip />} />
                      <Bar dataKey="gain" name="Gain/Loss" radius={[0, 4, 4, 0]}>
                        {glData.map((e, i) => (
                          <Cell key={i} fill={e.gain >= 0 ? 'var(--green)' : 'var(--red)'} fillOpacity={0.8} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
