import { useState } from 'react'
import { getFiling } from '../lib/api.js'
import './FilingPanel.css'

export default function FilingPanel({ ticker }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  async function load(forceRefresh = false) {
    setLoading(true)
    setError(null)
    try {
      const result = await getFiling(ticker, { refresh: forceRefresh })
      setData(result)
      // Fire-and-forget: warm the Netlify Blobs cache so the next /api/screen
      // run can fold this ticker's filing_drift / hedging_delta into scoring.
      // Failures here don't surface to the user; the EDGAR result is what matters.
      fetch('/api/cache-filing', {
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
      <div className="filing-panel">
        <button className="filing-load-btn" onClick={() => load()}>
          Analyze 10-K language drift
        </button>
        <span className="filing-hint">Fetches the two latest 10-Ks from SEC EDGAR (~3s)</span>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="filing-panel">
        <div className="filing-loading">Pulling 10-K filings from EDGAR…</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="filing-panel">
        <div className="filing-error">{error}</div>
        <button className="filing-load-btn" onClick={() => load()}>Retry</button>
      </div>
    )
  }

  return (
    <div className="filing-panel filing-loaded">
      <div className="filing-head">
        <span className="filing-label">10-K filing tone</span>
        <span className="filing-score" data-tier={tierOf(data.score)}>{Math.round(data.score)}</span>
      </div>

      {data.error && <div className="filing-warn">{data.error}</div>}

      <div className="filing-grid">
        <div className="filing-cell">
          <span className="fc-label">Risk Factors drift</span>
          <span className="fc-val">{data.risk_drift !== null ? `${Math.round(data.risk_drift)}/100` : '—'}</span>
        </div>
        <div className="filing-cell">
          <span className="fc-label">MD&amp;A drift</span>
          <span className="fc-val">{data.mda_drift !== null ? `${Math.round(data.mda_drift)}/100` : '—'}</span>
        </div>
        <div className="filing-cell">
          <span className="fc-label">Hedging YoY</span>
          <span className="fc-val">{data.hedging_delta !== null ? formatDelta(data.hedging_delta) : '—'}</span>
        </div>
        <div className="filing-cell">
          <span className="fc-label">Hedging hits / 1k words</span>
          <span className="fc-val">
            {data.hedging_freq_current !== null ? data.hedging_freq_current.toFixed(1) : '—'}
            {data.hedging_freq_prior !== null && (
              <span className="fc-sub"> (prior {data.hedging_freq_prior.toFixed(1)})</span>
            )}
          </span>
        </div>
      </div>

      {data.current_filing && (
        <div className="filing-meta">
          <a href={data.current_filing.url} target="_blank" rel="noopener noreferrer">
            Current 10-K · {data.current_filing.filingDate}
          </a>
          {data.prior_filing && (
            <>
              <span className="filing-meta-sep">·</span>
              <a href={data.prior_filing.url} target="_blank" rel="noopener noreferrer">
                Prior · {data.prior_filing.filingDate}
              </a>
            </>
          )}
          <button className="filing-refresh" onClick={() => load(true)} title="Re-fetch from EDGAR">↻</button>
        </div>
      )}
    </div>
  )
}

function tierOf(score) {
  if (score >= 70) return 'good'
  if (score >= 50) return 'warn'
  return 'bad'
}

function formatDelta(d) {
  const pct = Math.round(d * 100)
  const sign = pct >= 0 ? '+' : ''
  return `${sign}${pct}%`
}
