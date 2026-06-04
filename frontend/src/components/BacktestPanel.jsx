/**
 * BacktestPanel — per-ticker historical replay.
 *
 * Renders a chart of composite score vs price across quarterly snapshots,
 * plus a summary table: at composite ≥70, what was the realized 30/60/90/180-day
 * return and how did it compare to SPY?
 *
 * Reads from /api/backtest/{ticker} which is FMP-backed and cached locally on
 * the function for 30 days. First call per ticker is ~3-5s while FMP responds.
 */
import { useEffect, useState } from 'react'
import {
  LineChart, Line, XAxis, YAxis, Tooltip, Legend,
  ReferenceLine, ResponsiveContainer, CartesianGrid,
} from 'recharts'
import { getBacktest } from '../lib/api.js'
import './BacktestPanel.css'

function fmtPct(n) {
  if (n == null) return '—'
  const sign = n > 0 ? '+' : ''
  return `${sign}${n.toFixed(1)}%`
}

function returnColor(n) {
  if (n == null) return 'var(--text-muted)'
  return n > 0 ? 'var(--green)' : 'var(--red)'
}

export default function BacktestPanel({ ticker }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    let alive = true
    getBacktest(ticker, { cacheOnly: true })
      .then(r => { if (alive && r && r.cached !== false) setData(r) })
      .catch(() => { /* silent */ })
    return () => { alive = false }
  }, [ticker])

  async function load(forceRefresh = false) {
    setLoading(true)
    setError(null)
    try {
      const result = await getBacktest(ticker, { refresh: forceRefresh })
      setData(result)
      // Fire-and-forget cache warm so the result is also available to other
      // panels that may want to read from blob storage in future.
      fetch('/api/cache-backtest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker, payload: result }),
      }).catch(() => {})
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  if (!data && !loading && !error) {
    return (
      <div className="backtest-panel">
        <button className="backtest-load-btn" onClick={() => load()}>
          Run historical backtest
        </button>
        <span className="backtest-hint">
          Replays scoring on quarterly snapshots vs realized forward returns (~3s)
        </span>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="backtest-panel">
        <div className="backtest-loading">Pulling historical fundamentals + prices from FMP…</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="backtest-panel">
        <div className="backtest-error">{error}</div>
        <button className="backtest-load-btn" onClick={() => load()}>Retry</button>
      </div>
    )
  }

  if (data.error) {
    return (
      <div className="backtest-panel">
        <div className="backtest-warn">{data.error}</div>
      </div>
    )
  }

  // Sort snapshots oldest → newest for the chart x-axis.
  const chartData = (data.snapshots || [])
    .slice()
    .sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date))
    .map(s => ({
      date: s.snapshot_date.slice(0, 7),  // YYYY-MM
      composite: s.composite,
      price: s.snapshot_price,
      return_90d: s.return_90d,
    }))

  const summary = data.summary || {}
  const threshold = summary.high_band_threshold ?? 70

  return (
    <div className="backtest-panel backtest-loaded">
      <div className="backtest-head">
        <span className="backtest-label">Historical backtest</span>
        <span className="backtest-sub">
          {chartData.length} quarterly snapshot{chartData.length === 1 ? '' : 's'}
        </span>
        <button className="backtest-refresh" onClick={() => load(true)}
          title="Re-fetch from FMP">↻</button>
      </div>

      {chartData.length > 0 && (
        <div className="backtest-chart">
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={chartData} margin={{ top: 6, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="date" tick={{ fill: 'var(--text-muted)', fontSize: 10 }} />
              <YAxis yAxisId="score" domain={[0, 100]}
                tick={{ fill: 'var(--text-muted)', fontSize: 10 }}
                label={{ value: 'Score', angle: -90, position: 'insideLeft',
                         fill: 'var(--text-muted)', fontSize: 10 }} />
              <YAxis yAxisId="price" orientation="right"
                tick={{ fill: 'var(--text-muted)', fontSize: 10 }}
                label={{ value: 'Price', angle: 90, position: 'insideRight',
                         fill: 'var(--text-muted)', fontSize: 10 }} />
              <Tooltip
                contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border-accent)',
                               borderRadius: 6, fontSize: 12 }}
                labelStyle={{ color: 'var(--text-muted)' }}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <ReferenceLine y={threshold} yAxisId="score" stroke="var(--gold-border)"
                strokeDasharray="3 3"
                label={{ value: `≥${threshold} band`, fill: 'var(--gold)', fontSize: 9, position: 'right' }} />
              <Line yAxisId="score" type="monotone" dataKey="composite" name="Composite"
                stroke="var(--gold)" strokeWidth={2} dot={{ r: 3 }} />
              <Line yAxisId="price" type="monotone" dataKey="price" name="Price ($)"
                stroke="var(--blue)" strokeWidth={1.5} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="backtest-summary">
        <div className="bs-title">
          When composite was ≥{threshold} historically, forward returns averaged:
        </div>
        <div className="bs-grid">
          {['30d', '60d', '90d', '180d'].map(w => {
            const s = summary[w]
            return (
              <div key={w} className="bs-cell">
                <span className="bs-label">{w}</span>
                {s ? (
                  <>
                    <span className="bs-return" style={{ color: returnColor(s.mean_return) }}>
                      {fmtPct(s.mean_return)}
                    </span>
                    <span className="bs-excess" style={{ color: returnColor(s.mean_excess) }}>
                      vs SPY {fmtPct(s.mean_excess)}
                    </span>
                    <span className="bs-hits">{s.hit_rate}% hit · n={s.n}</span>
                  </>
                ) : (
                  <span className="bs-na">n/a</span>
                )}
              </div>
            )
          })}
        </div>
      </div>

      <div className="backtest-note">
        {data.methodology_note}
      </div>
    </div>
  )
}
