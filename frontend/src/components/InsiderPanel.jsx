import { useState } from 'react'
import { getInsider } from '../lib/api.js'
import './InsiderPanel.css'

function tierOf(score) {
  if (score == null) return 'neutral'
  if (score >= 65) return 'good'
  if (score >= 45) return 'neutral'
  return 'bad'
}

function fmtMoney(v) {
  if (v == null) return '—'
  const abs = Math.abs(v)
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(1)}M`
  if (abs >= 1e3) return `$${(v / 1e3).toFixed(0)}K`
  return `$${Math.round(v)}`
}

export default function InsiderPanel({ ticker }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  async function load(forceRefresh = false) {
    setLoading(true)
    setError(null)
    try {
      const result = await getInsider(ticker, { refresh: forceRefresh })
      setData(result)
      // Fire-and-forget cache warm so the screener can fold this score in.
      fetch('/api/cache-insider', {
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
      <div className="insider-panel">
        <button className="insider-load-btn" onClick={() => load()}>
          Analyze insider activity
        </button>
        <span className="insider-hint">Form 4 buys/sells over last 90 days from SEC EDGAR</span>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="insider-panel">
        <div className="insider-loading">Pulling Form 4 filings from EDGAR…</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="insider-panel">
        <div className="insider-error">{error}</div>
        <button className="insider-load-btn" onClick={() => load()}>Retry</button>
      </div>
    )
  }

  const noActivity = data.buy_count === 0 && data.sell_count === 0
  const netSign = data.net_value > 0 ? '+' : ''

  return (
    <div className="insider-panel insider-loaded">
      <div className="insider-head">
        <span className="insider-label">Insider activity ({data.lookback_days}d)</span>
        <span className="insider-score" data-tier={tierOf(data.score)}>
          {Math.round(data.score)}
        </span>
      </div>

      {data.error && noActivity && (
        <div className="insider-warn">No qualifying open-market transactions in window.</div>
      )}

      <div className="insider-grid">
        <div className="insider-cell">
          <span className="ic-label">Buys</span>
          <span className="ic-val ic-val--good">{data.buy_count}</span>
          <span className="ic-sub">{fmtMoney(data.buy_value)}</span>
        </div>
        <div className="insider-cell">
          <span className="ic-label">Sells</span>
          <span className="ic-val ic-val--bad">{data.sell_count}</span>
          <span className="ic-sub">{fmtMoney(data.sell_value)}</span>
        </div>
        <div className="insider-cell">
          <span className="ic-label">Net</span>
          <span className="ic-val" style={{
            color: data.net_value > 0 ? 'var(--green)' : data.net_value < 0 ? 'var(--red)' : 'var(--text-muted)'
          }}>
            {data.net_value != null ? `${netSign}${fmtMoney(data.net_value)}` : '—'}
          </span>
        </div>
        <div className="insider-cell">
          <span className="ic-label">Filings</span>
          <span className="ic-val">{data.filing_count}</span>
        </div>
      </div>

      <div className="insider-meta">
        <span>EDGAR · code P (open-market buy) / S (sale)</span>
        <button className="insider-refresh" onClick={() => load(true)}
          title="Re-fetch from EDGAR">↻</button>
      </div>
    </div>
  )
}
