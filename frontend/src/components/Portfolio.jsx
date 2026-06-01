import { useState } from 'react'
import {
  PieChart, Pie, Cell,
  BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer
} from 'recharts'
import { fmtNum, fmtPct, scoreColor, scoreBg } from '../lib/scoring.js'
import ScoreBar from './ScoreBar.jsx'
import FilingPanel from './FilingPanel.jsx'
import ResearchPanel from './ResearchPanel.jsx'
import InsiderPanel from './InsiderPanel.jsx'
import './Portfolio.css'

const WEIGHT_KEYS = ['fundamentals', 'momentum', 'sentiment', 'filingTone', 'insider']

const SECTOR_COLORS = [
  '#c9a84c', '#60a5fa', '#3ecf8e', '#f87171', '#a78bfa',
  '#fb923c', '#34d399', '#f472b6', '#38bdf8', '#facc15'
]

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

export default function Portfolio({
  watchlist,
  onRemoveFromWatchlist,
  positions,
  setPositions,
  livePrice,
  refreshAllPrices,
  refreshing,
  lastRefresh,
  schwabConnected,
  schwabSyncing,
  schwabError,
  schwabLastSync,
  onSchwabSync,
}) {
  const [editTicker, setEditTicker]   = useState(null)
  const [editShares, setEditShares]   = useState('')
  const [editCost, setEditCost]       = useState('')
  const [activeTab, setActiveTab]     = useState('positions')

  function openEdit(ticker) {
    const p = positions[ticker] || {}
    setEditTicker(ticker)
    setEditShares(p.shares ?? '')
    setEditCost(p.costBasis ?? '')
  }

  function saveEdit() {
    if (!editTicker) return
    setPositions(prev => ({
      ...prev,
      [editTicker]: {
        shares: parseFloat(editShares) || 0,
        costBasis: parseFloat(editCost) || 0,
        entryDate: prev[editTicker]?.entryDate || new Date().toISOString().split('T')[0],
        entryScore: prev[editTicker]?.entryScore || 0,
      }
    }))
    setEditTicker(null)
  }

  // Enrich each watchlist item with live price + position data.
  // Schwab-sourced positions carry authoritative current price + market value
  // straight from the broker; those override the /api/prices snapshot.
  const rows = watchlist.map(s => {
    const pos      = positions[s.ticker]
    const isLive   = pos?.source === 'schwab'
    const price    = (isLive && pos.currentPrice != null) ? pos.currentPrice
                   : livePrice[s.ticker]?.price ?? s.price ?? 0
    const change   = livePrice[s.ticker]?.change ?? s.change ?? 0
    const mktValue = isLive && pos.marketValue != null
                     ? pos.marketValue
                     : (pos?.shares ? pos.shares * price : 0)
    const cost     = pos?.shares ? pos.shares * pos.costBasis : 0
    const gainAbs  = isLive && pos.gainLoss != null ? pos.gainLoss : (mktValue - cost)
    const gainPct  = isLive && pos.gainLossPct != null ? pos.gainLossPct
                   : (cost > 0 ? (gainAbs / cost) * 100 : 0)
    return { ...s, price, change, pos, mktValue, cost, gainAbs, gainPct, isLive }
  })

  const totalValue   = rows.reduce((s, r) => s + r.mktValue, 0)
  const totalCost    = rows.reduce((s, r) => s + r.cost, 0)
  const totalGain    = totalValue - totalCost
  const totalGainPct = totalCost > 0 ? (totalGain / totalCost) * 100 : 0
  const positionedCount = rows.filter(r => r.pos?.shares > 0).length

  const dayChange = rows.reduce((s, r) => {
    if (!r.pos?.shares || !r.price) return s
    const prev = r.price / (1 + (r.change || 0) / 100)
    return s + r.pos.shares * (r.price - prev)
  }, 0)

  // Sector pie data (only positioned stocks)
  const sectorMap = {}
  rows.forEach(r => {
    if (!r.mktValue) return
    const sec = r.sector || 'Other'
    sectorMap[sec] = (sectorMap[sec] || 0) + r.mktValue
  })
  const sectorData = Object.entries(sectorMap).map(([name, value]) => ({
    name, value: +value.toFixed(2),
    pct: totalValue > 0 ? ((value / totalValue) * 100).toFixed(1) : '0'
  }))

  // P&L bar data
  const glData = rows
    .filter(r => r.pos?.shares > 0)
    .map(r => ({ ticker: r.ticker, gain: +r.gainAbs.toFixed(2) }))
    .sort((a, b) => b.gain - a.gain)

  // Score comparison data
  const scoreData = watchlist.map(s => ({
    ticker: s.ticker,
    Score: s.composite ?? 0,
  }))

  return (
    <div className="portfolio">
      <div className="portfolio-header">
        <div>
          <h1 className="page-title">Portfolio <em>Tracker</em></h1>
          <p className="page-subtitle">Watchlist · positions · P&amp;L · analytics</p>
        </div>
        <div className="header-actions">
          {schwabConnected && (
            <>
              {schwabLastSync && (
                <span className="last-refresh schwab-sync-time">
                  Schwab synced {relativeTime(schwabLastSync)}
                </span>
              )}
              <button className="refresh-btn schwab-sync-btn" onClick={onSchwabSync}
                disabled={schwabSyncing} title="Re-pull positions from Schwab">
                {schwabSyncing ? 'Syncing…' : 'Sync Schwab'}
              </button>
            </>
          )}
          {lastRefresh && <span className="last-refresh">Quotes {lastRefresh.toLocaleTimeString()}</span>}
          <button className="refresh-btn" onClick={refreshAllPrices} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh prices'}
          </button>
        </div>
      </div>

      {schwabError && (
        <div className="schwab-error-banner">{schwabError}</div>
      )}

      {/* Summary cards */}
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
          <span className="sum-label">Positions entered</span>
          <span className="sum-val">{positionedCount} of {watchlist.length}</span>
        </div>
      </div>

      {watchlist.length === 0 ? (
        <div className="empty-portfolio">
          <p className="empty-title">No stocks on watchlist yet.</p>
          <p className="empty-sub">Use the Screener tab to find and add stocks.</p>
        </div>
      ) : (
        <>
          <div className="tab-bar">
            {['positions', 'charts', 'scores'].map(t => (
              <button key={t}
                className={`tab-btn ${activeTab === t ? 'active' : ''}`}
                onClick={() => setActiveTab(t)}>
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>

          {/* ── POSITIONS TAB ── */}
          {activeTab === 'positions' && (
            <div className="portfolio-table-wrap">
              <table className="portfolio-table">
                <thead>
                  <tr>
                    <th>Ticker</th><th>Score</th><th>Price</th>
                    <th>Day</th><th>Shares</th><th>Cost</th>
                    <th>Value</th><th>Gain / loss</th><th>Pillars</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.ticker} className={`port-row${r.noScore ? ' port-row--noscore' : ''}`}>
                      <td>
                        <div className="ticker-sym">
                          {r.ticker}
                          {r.isLive && <span className="live-badge" title={`Schwab ${r.pos?.accountNumber || ''} · ${r.pos?.assetType || ''}`}>LIVE</span>}
                          {r.noScore && r.pos?.assetType && r.pos.assetType !== 'EQUITY' && (
                            <span className="asset-type-badge">{r.pos.assetType}</span>
                          )}
                        </div>
                        <div className="ticker-name">{r.name}</div>
                      </td>
                      <td>
                        {r.noScore ? (
                          <span className="score-chip score-chip--na" title="ETFs and mutual funds aren't scored">—</span>
                        ) : (
                          <span className="score-chip"
                            style={{ color: scoreColor(r.composite ?? 0), background: scoreBg(r.composite ?? 0) }}>
                            {r.composite ?? '—'}
                          </span>
                        )}
                      </td>
                      <td className="mono">
                        {refreshing && !r.isLive ? <span style={{ color: 'var(--text-muted)' }}>…</span> : `$${fmtNum(r.price)}`}
                      </td>
                      <td className="mono" style={{ color: r.change >= 0 ? 'var(--green)' : 'var(--red)' }}>
                        {r.change != null ? fmtPct(r.change) : '—'}
                      </td>
                      <td className="mono">{r.pos?.shares ?? '—'}</td>
                      <td className="mono">{r.pos?.costBasis ? `$${fmtNum(r.pos.costBasis)}` : '—'}</td>
                      <td className="mono">{r.mktValue ? `$${r.mktValue.toFixed(2)}` : '—'}</td>
                      <td>
                        {r.cost > 0 ? (
                          <span style={{ color: r.gainAbs >= 0 ? 'var(--green)' : 'var(--red)', fontFamily: 'var(--font-mono)', fontWeight: 500 }}>
                            {r.gainAbs >= 0 ? '+' : ''}${Math.abs(r.gainAbs).toFixed(2)}
                            <span style={{ fontSize: 11, opacity: 0.8 }}> ({fmtPct(r.gainPct)})</span>
                          </span>
                        ) : '—'}
                      </td>
                      <td>
                        {r.noScore ? (
                          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>n/a</span>
                        ) : (
                          <div className="mini-bars">
                            {WEIGHT_KEYS.map(k => (
                              <ScoreBar key={k} label={k.slice(0, 4)} value={r.scores?.[k] ?? 0} />
                            ))}
                          </div>
                        )}
                      </td>
                      <td>
                        <div className="port-actions">
                          <button className="edit-btn" onClick={() => openEdit(r.ticker)}
                            title={r.isLive ? 'Schwab-synced — edits will be overwritten on next sync' : 'Enter position'}
                            disabled={r.isLive}>
                            ✎
                          </button>
                          <button className="remove-btn" onClick={() => onRemoveFromWatchlist(r.ticker)} title="Remove">✕</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* ── CHARTS TAB ── */}
          {activeTab === 'charts' && (
            <div className="charts-grid">

              <div className="chart-card">
                <div className="chart-title">Sector allocation</div>
                {sectorData.length === 0 ? (
                  <p className="chart-empty">Enter position sizes to see allocation.</p>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem', flexWrap: 'wrap' }}>
                    <ResponsiveContainer width={200} height={200}>
                      <PieChart>
                        <Pie data={sectorData} dataKey="value" nameKey="name"
                          cx="50%" cy="50%" outerRadius={85} innerRadius={45}>
                          {sectorData.map((_, i) => (
                            <Cell key={i} fill={SECTOR_COLORS[i % SECTOR_COLORS.length]} />
                          ))}
                        </Pie>
                        <Tooltip formatter={v => `$${v.toFixed(2)}`}
                          contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border-accent)', borderRadius: 8, fontSize: 12 }} />
                      </PieChart>
                    </ResponsiveContainer>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {sectorData.map((s, i) => (
                        <div key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                          <div style={{ width: 10, height: 10, borderRadius: 2, flexShrink: 0, background: SECTOR_COLORS[i % SECTOR_COLORS.length] }} />
                          <span style={{ color: 'var(--text-secondary)' }}>{s.name}</span>
                          <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)', marginLeft: 'auto', paddingLeft: 20 }}>{s.pct}%</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="chart-card">
                <div className="chart-title">Gain / loss by position ($)</div>
                {glData.length === 0 ? (
                  <p className="chart-empty">Enter cost basis and shares to see P&amp;L.</p>
                ) : (
                  <ResponsiveContainer width="100%" height={200}>
                    <BarChart data={glData} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                      <XAxis dataKey="ticker" tick={{ fontSize: 11, fill: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fontSize: 10, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} width={55} tickFormatter={v => `$${v}`} />
                      <Tooltip content={<ChartTooltip />} />
                      <Bar dataKey="gain" name="Gain/Loss" radius={[4, 4, 0, 0]}>
                        {glData.map((e, i) => (
                          <Cell key={i} fill={e.gain >= 0 ? 'var(--green)' : 'var(--red)'} fillOpacity={0.8} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>

              <div className="chart-card wide">
                <div className="chart-title">Composite score — all watchlist stocks</div>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={scoreData} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                    <XAxis dataKey="ticker" tick={{ fontSize: 11, fill: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }} axisLine={false} tickLine={false} />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} width={30} />
                    <Tooltip contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border-accent)', borderRadius: 8, fontSize: 12 }} />
                    <Bar dataKey="Score" radius={[4, 4, 0, 0]}>
                      {scoreData.map((e, i) => (
                        <Cell key={i} fill={scoreColor(e.Score)} fillOpacity={0.85} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>

            </div>
          )}

          {/* ── SCORES TAB ── */}
          {activeTab === 'scores' && (
            <div className="scores-grid">
              {watchlist.map(stock => (
                <div key={stock.ticker} className="score-card">
                  <div className="score-card-header">
                    <div>
                      <div className="ticker-sym">{stock.ticker}</div>
                      <div className="ticker-name">{stock.name}</div>
                    </div>
                    <span className="score-chip"
                      style={{ color: scoreColor(stock.composite ?? 0), background: scoreBg(stock.composite ?? 0), fontSize: 18, padding: '4px 14px' }}>
                      {stock.composite ?? '—'}
                    </span>
                  </div>
                  <div className="score-card-bars">
                    {WEIGHT_KEYS.map(k => (
                      <div key={k} className="sc-row">
                        <span className="sc-label">{k}</span>
                        <div className="sc-track">
                          <div className="sc-fill"
                            style={{ width: `${stock.scores?.[k] ?? 0}%`, background: scoreColor(stock.scores?.[k] ?? 0) }} />
                        </div>
                        <span className="sc-val" style={{ color: scoreColor(stock.scores?.[k] ?? 0) }}>
                          {stock.scores?.[k] ?? 0}
                        </span>
                      </div>
                    ))}
                  </div>
                  <p className="score-card-why">{stock.why}</p>
                  <div className="score-card-flags">
                    {stock.flags?.map((f, i) => (
                      <span key={i} className={`flag flag-${f.type}`}>{f.label}</span>
                    ))}
                  </div>
                  <FilingPanel ticker={stock.ticker} />
                  <ResearchPanel ticker={stock.ticker} />
                  <InsiderPanel ticker={stock.ticker} />
                </div>
              ))}
            </div>
          )}

        </>
      )}

      {editTicker && (
        <div className="modal-backdrop" onClick={() => setEditTicker(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3 className="modal-title">Position — {editTicker}</h3>
            <div className="modal-field">
              <label>Shares owned</label>
              <input type="number" value={editShares} onChange={e => setEditShares(e.target.value)}
                placeholder="e.g. 10" min={0} step={0.001} />
            </div>
            <div className="modal-field">
              <label>Avg cost basis per share ($)</label>
              <input type="number" value={editCost} onChange={e => setEditCost(e.target.value)}
                placeholder="e.g. 185.50" min={0} step={0.01} />
            </div>
            <div className="modal-actions">
              <button className="modal-cancel" onClick={() => setEditTicker(null)}>Cancel</button>
              <button className="modal-save" onClick={saveEdit}>Save position</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
