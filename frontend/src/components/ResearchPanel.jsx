import { useState } from 'react'
import { getResearch } from '../lib/api.js'
import './ResearchPanel.css'

const SENTIMENT_META = {
  bullish: { color: 'var(--green)', bg: 'rgba(62, 207, 142, 0.15)', label: 'Bullish' },
  bearish: { color: 'var(--red)',   bg: 'rgba(248, 113, 113, 0.15)', label: 'Bearish' },
  neutral: { color: 'var(--text-muted)', bg: 'var(--bg-input)',     label: 'Neutral' },
}

const CONSENSUS_META = {
  buy:  { color: 'var(--green)', label: 'Buy' },
  hold: { color: 'var(--amber)', label: 'Hold' },
  sell: { color: 'var(--red)',   label: 'Sell' },
}

export default function ResearchPanel({ ticker }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  async function load(forceRefresh = false) {
    setLoading(true)
    setError(null)
    try {
      const result = await getResearch(ticker, { refresh: forceRefresh })
      setData(result)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  if (!data && !loading && !error) {
    return (
      <div className="research-panel">
        <button className="research-load-btn" onClick={() => load()}>
          Research with Perplexity
        </button>
        <span className="research-hint">News sentiment + analyst consensus, 24h cache</span>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="research-panel">
        <div className="research-loading">Asking Perplexity…</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="research-panel">
        <div className="research-error">{error}</div>
        <button className="research-load-btn" onClick={() => load()}>Retry</button>
      </div>
    )
  }

  const sentMeta = SENTIMENT_META[data.sentiment] || SENTIMENT_META.neutral
  const consMeta = CONSENSUS_META[data.analystConsensus] || CONSENSUS_META.hold
  const cachedAt = data.cached_at ? new Date(data.cached_at).toLocaleString() : null

  return (
    <div className="research-panel research-loaded">
      <div className="research-head">
        <span className="research-label">Research</span>
        <span className="research-sentiment-badge"
          style={{ color: sentMeta.color, background: sentMeta.bg }}>
          {sentMeta.label}
        </span>
        <span className="research-consensus-badge" style={{ color: consMeta.color }}>
          Analyst · {consMeta.label}
        </span>
      </div>

      {data.summary && (
        <p className="research-summary">{data.summary}</p>
      )}

      <div className="research-grid">
        <div className="research-col">
          <div className="research-col-title research-col-title--good">Catalysts</div>
          <ul className="research-list">
            {(data.catalysts || []).map((c, i) => (
              <li key={i}><span className="research-bullet research-bullet--good">•</span>{c}</li>
            ))}
            {(data.catalysts || []).length === 0 && (
              <li className="research-empty">No catalysts identified</li>
            )}
          </ul>
        </div>
        <div className="research-col">
          <div className="research-col-title research-col-title--bad">Risks</div>
          <ul className="research-list">
            {(data.risks || []).map((r, i) => (
              <li key={i}><span className="research-bullet research-bullet--bad">•</span>{r}</li>
            ))}
            {(data.risks || []).length === 0 && (
              <li className="research-empty">No risks identified</li>
            )}
          </ul>
        </div>
      </div>

      <div className="research-meta">
        {cachedAt && (
          <span className="research-cached">
            {data.fresh ? 'Fresh · ' : 'Cached · '}{cachedAt}
          </span>
        )}
        <button className="research-refresh" onClick={() => load(true)}
          title="Bypass cache, ask Perplexity again">↻</button>
      </div>
    </div>
  )
}
