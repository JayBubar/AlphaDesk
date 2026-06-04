/**
 * ScoreExplainer — readable breakdown of why a stock got its composite score.
 *
 * Renders three nested levels:
 *   1. Composite score with the math at the top
 *   2. Each pillar with its weight, score, and contribution
 *   3. Each metric inside the pillar with raw value, normalized score,
 *      weight, weighted contribution, AND a "why" explanation pulled from
 *      lib/methodology.js
 *
 * Links to the full methodology doc for the deeper read.
 */
import { useState } from 'react'
import { PILLAR_DEFS, METRIC_DEFS } from '../lib/methodology.js'
import { scoreColor } from '../lib/scoring.js'
import './ScoreExplainer.css'

export default function ScoreExplainer({ stock }) {
  const [openPillar, setOpenPillar] = useState(null)
  const [openMetric, setOpenMetric] = useState(null)

  if (!stock?.breakdown?.length) {
    return (
      <div className="explainer">
        <p className="explainer-empty">
          No breakdown available — run a fresh screen to populate scores.
        </p>
      </div>
    )
  }

  const composite = stock.composite ?? 0
  const totalWeight = stock.breakdown.reduce((s, p) => s + (p.weight || 0), 0) || 100

  return (
    <div className="explainer">
      <div className="explainer-head">
        <div className="explainer-title-wrap">
          <span className="explainer-label">Score explainer</span>
          <a className="explainer-doc-link" href="/methodology.html" target="_blank"
            rel="noopener noreferrer">
            Full methodology ↗
          </a>
        </div>
        <div className="explainer-composite">
          <span className="explainer-composite-num"
            style={{ color: scoreColor(composite) }}>
            {composite}
          </span>
          <span className="explainer-composite-label">composite</span>
        </div>
      </div>

      <div className="explainer-pillars">
        {stock.breakdown.map(pillar => {
          const def = PILLAR_DEFS[pillar.pillar === 'filings' ? 'filings' : pillar.pillar] || {}
          const contribToComposite = ((pillar.score || 0) * (pillar.weight || 0)) / totalWeight
          const isOpen = openPillar === pillar.pillar
          return (
            <div key={pillar.pillar} className="explainer-pillar">
              <button className="explainer-pillar-head"
                onClick={() => setOpenPillar(isOpen ? null : pillar.pillar)}>
                <span className="ep-name">{def.label || pillar.pillar}</span>
                <span className="ep-score" style={{ color: scoreColor(pillar.score) }}>
                  {Math.round(pillar.score)}
                </span>
                <span className="ep-math">
                  × {Math.round(pillar.weight)}% = <strong>{contribToComposite.toFixed(1)}</strong>
                </span>
                <span className="ep-caret">{isOpen ? '▾' : '▸'}</span>
              </button>
              {isOpen && (
                <div className="explainer-pillar-body">
                  {def.summary && <p className="ep-summary">{def.summary}</p>}
                  {def.why && <p className="ep-why"><strong>Why it matters:</strong> {def.why}</p>}
                  {pillar.contributions?.length > 0 && (
                    <ul className="explainer-metrics">
                      {pillar.contributions.map(c => {
                        const mdef = METRIC_DEFS[c.metric] || {}
                        const mOpen = openMetric === `${pillar.pillar}.${c.metric}`
                        const isNa = c.score == null
                        return (
                          <li key={c.metric}
                            className={`explainer-metric ${isNa ? 'is-na' : ''}`}>
                            <button className="em-head"
                              onClick={() => setOpenMetric(mOpen ? null : `${pillar.pillar}.${c.metric}`)}>
                              <span className="em-name">{mdef.label || c.metric}</span>
                              <span className="em-raw">
                                raw {c.raw != null ? formatRaw(c.metric, c.raw) : '—'}
                              </span>
                              <span className="em-score"
                                style={{ color: isNa ? 'var(--text-muted)' : scoreColor(c.score) }}>
                                {isNa ? 'n/a' : Math.round(c.score)}
                              </span>
                              <span className="em-weight">w{c.weight}%</span>
                              <span className="em-rationale">{c.rationale}</span>
                              <span className="em-caret">{mOpen ? '▾' : '▸'}</span>
                            </button>
                            {mOpen && (
                              <div className="em-body">
                                <p className="em-summary">{mdef.summary}</p>
                                <p className="em-why">
                                  <strong>Why it matters:</strong> {mdef.why}
                                </p>
                                {isNa && (
                                  <p className="em-na-note">
                                    Data not available for this ticker — the metric is
                                    excluded from the pillar's weighted average rather than
                                    counted as a zero.
                                  </p>
                                )}
                              </div>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="explainer-footer">
        Pillar contributions add up to the composite. Weights vary by profile —
        see the methodology doc for how value_long, growth_mid, speculative, and
        penny shift the priorities.
      </div>
    </div>
  )
}

function formatRaw(metric, raw) {
  if (raw == null) return '—'
  if (typeof raw !== 'number') return String(raw)
  // Heuristic formatting per metric type
  if (['pe', 'debt_equity'].includes(metric)) return raw.toFixed(2)
  if (['analyst_upside', 'price_change'].includes(metric)) return `${raw.toFixed(1)}%`
  if (['gross_margin', 'short_interest', 'insider_pct', 'inst_pct', 'roic'].includes(metric)) {
    return Math.abs(raw) < 2 ? `${(raw * 100).toFixed(1)}%` : `${raw.toFixed(1)}%`
  }
  if (metric === 'price_position_52w') return `${Math.round(raw * 100)}% of range`
  if (metric === 'ma_trend') return raw > 0 ? 'up' : raw < 0 ? 'down' : 'flat'
  if (metric === 'hedging_delta') return `${(raw * 100).toFixed(0)}%`
  return raw.toFixed(1)
}
