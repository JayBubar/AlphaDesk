import { useState } from 'react'
import { evaluateAll, SIGNAL_META } from '../lib/signals.js'
import { fmtPct, fmtNum, scoreColor, scoreBg } from '../lib/scoring.js'
import ScoreBar from './ScoreBar.jsx'
import Movers from './Movers.jsx'
import './Signals.css'
import './Movers.css'

const WEIGHT_KEYS = ['fundamentals', 'momentum', 'sentiment', 'filingTone', 'insider']

const DEFAULT_SETTINGS = {
  hardStopScore:    40,
  softAlertScore:   55,
  stopLossPct:      15,
  reviewDropPct:    10,
  scoreDropAlert:   15,
  scoreDropSell:    30,
  strongHoldScore:  75,
  daysBeforeReview: 90,
}

export default function Signals({ watchlist, positions, livePrices }) {
  const [settings, setSettings]       = useState({ ...DEFAULT_SETTINGS })
  const [showSettings, setShowSettings] = useState(false)
  const [expanded, setExpanded]       = useState(null)

  const results = evaluateAll(watchlist, positions, livePrices, settings)

  const counts = {
    SELL:        results.filter(r => r.signal === 'SELL').length,
    REVIEW:      results.filter(r => r.signal === 'REVIEW').length,
    HOLD:        results.filter(r => r.signal === 'HOLD').length,
    STRONG_HOLD: results.filter(r => r.signal === 'STRONG_HOLD').length,
    none:        results.filter(r => r.signal === null).length,
  }

  function setSetting(key, val) {
    setSettings(prev => ({ ...prev, [key]: Number(val) }))
  }

  return (
    <div className="signals">

      <Movers watchlist={watchlist} />

      {/* Summary bar */}
      <div className="signals-summary">
        {Object.entries(SIGNAL_META).map(([key, meta]) => (
          <div key={key} className="sig-count-card"
            style={{ borderColor: counts[key] > 0 ? meta.color : 'var(--border)' }}>
            <span className="sig-count-icon" style={{ color: meta.color }}>{meta.icon}</span>
            <span className="sig-count-num" style={{ color: counts[key] > 0 ? meta.color : 'var(--text-muted)' }}>
              {counts[key]}
            </span>
            <span className="sig-count-label">{meta.label}</span>
          </div>
        ))}
        <button
          className={`settings-toggle ${showSettings ? 'active' : ''}`}
          onClick={() => setShowSettings(s => !s)}
        >
          ⚙ Thresholds
        </button>
      </div>

      {/* Threshold settings panel */}
      {showSettings && (
        <div className="settings-panel">
          <div className="settings-title">Signal thresholds — adjust to match your risk tolerance</div>
          <div className="settings-grid">
            <div className="setting-field">
              <label>Hard sell score <span>(below this → SELL)</span></label>
              <div className="setting-input-row">
                <input type="range" min={20} max={60} step={5}
                  value={settings.hardStopScore}
                  onChange={e => setSetting('hardStopScore', e.target.value)} />
                <span>{settings.hardStopScore}</span>
              </div>
            </div>
            <div className="setting-field">
              <label>Review score <span>(below this → REVIEW)</span></label>
              <div className="setting-input-row">
                <input type="range" min={40} max={75} step={5}
                  value={settings.softAlertScore}
                  onChange={e => setSetting('softAlertScore', e.target.value)} />
                <span>{settings.softAlertScore}</span>
              </div>
            </div>
            <div className="setting-field">
              <label>Stop loss % <span>(price drop → SELL)</span></label>
              <div className="setting-input-row">
                <input type="range" min={5} max={30} step={1}
                  value={settings.stopLossPct}
                  onChange={e => setSetting('stopLossPct', e.target.value)} />
                <span>{settings.stopLossPct}%</span>
              </div>
            </div>
            <div className="setting-field">
              <label>Score drop alert <span>(pts dropped → REVIEW)</span></label>
              <div className="setting-input-row">
                <input type="range" min={5} max={25} step={5}
                  value={settings.scoreDropAlert}
                  onChange={e => setSetting('scoreDropAlert', e.target.value)} />
                <span>{settings.scoreDropAlert}pts</span>
              </div>
            </div>
            <div className="setting-field">
              <label>Score drop sell <span>(pts dropped → SELL)</span></label>
              <div className="setting-input-row">
                <input type="range" min={15} max={50} step={5}
                  value={settings.scoreDropSell}
                  onChange={e => setSetting('scoreDropSell', e.target.value)} />
                <span>{settings.scoreDropSell}pts</span>
              </div>
            </div>
            <div className="setting-field">
              <label>Strong hold score <span>(above this → STRONG HOLD)</span></label>
              <div className="setting-input-row">
                <input type="range" min={60} max={90} step={5}
                  value={settings.strongHoldScore}
                  onChange={e => setSetting('strongHoldScore', e.target.value)} />
                <span>{settings.strongHoldScore}</span>
              </div>
            </div>
            <div className="setting-field">
              <label>Days before time review</label>
              <div className="setting-input-row">
                <input type="range" min={30} max={180} step={30}
                  value={settings.daysBeforeReview}
                  onChange={e => setSetting('daysBeforeReview', e.target.value)} />
                <span>{settings.daysBeforeReview}d</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Signal cards */}
      {results.length === 0 ? (
        <div className="signals-empty">
          <p>No stocks on watchlist yet. Use the Screener to add stocks.</p>
        </div>
      ) : (
        <div className="signal-cards">
          {results.map(result => {
            const meta    = result.signal ? SIGNAL_META[result.signal] : null
            const stock   = watchlist.find(s => s.ticker === result.ticker)
            const pos     = positions[result.ticker]
            const price   = livePrices[result.ticker]?.price ?? stock?.price ?? 0
            const isOpen  = expanded === result.ticker

            return (
              <div key={result.ticker}
                className={`signal-card ${result.signal ?? 'no-position'} ${isOpen ? 'open' : ''}`}
                style={{ borderLeftColor: meta?.color ?? 'var(--border)' }}
                onClick={() => setExpanded(isOpen ? null : result.ticker)}
              >
                {/* Card header */}
                <div className="signal-card-header">
                  <div className="signal-left">
                    {meta && (
                      <span className="signal-badge"
                        style={{ color: meta.color, background: meta.bg }}>
                        {meta.icon} {meta.label}
                      </span>
                    )}
                    {!meta && (
                      <span className="signal-badge" style={{ color: 'var(--text-muted)', background: 'var(--bg-surface)' }}>
                        — No position
                      </span>
                    )}
                    <div className="signal-ticker">
                      <span className="ticker-sym">{result.ticker}</span>
                      <span className="ticker-name">{result.name}</span>
                    </div>
                  </div>

                  <div className="signal-right">
                    <div className="signal-metrics">
                      <div className="sm-item">
                        <span>Score</span>
                        <strong style={{ color: scoreColor(result.metrics.composite) }}>
                          {result.metrics.composite}
                        </strong>
                      </div>
                      {result.metrics.priceChange !== null && (
                        <div className="sm-item">
                          <span>vs Cost</span>
                          <strong style={{ color: result.metrics.priceChange >= 0 ? 'var(--green)' : 'var(--red)' }}>
                            {fmtPct(result.metrics.priceChange)}
                          </strong>
                        </div>
                      )}
                      {result.metrics.scoreDrop > 0 && (
                        <div className="sm-item">
                          <span>Score drop</span>
                          <strong style={{ color: 'var(--amber)' }}>
                            -{result.metrics.scoreDrop}pts
                          </strong>
                        </div>
                      )}
                      {result.metrics.daysHeld !== null && (
                        <div className="sm-item">
                          <span>Held</span>
                          <strong>{result.metrics.daysHeld}d</strong>
                        </div>
                      )}
                    </div>
                    <span className="expand-arrow">{isOpen ? '▲' : '▼'}</span>
                  </div>
                </div>

                {/* Primary reason (always visible) */}
                <p className="signal-primary-reason">
                  {result.reasons[0]}
                </p>

                {/* Expanded detail */}
                {isOpen && (
                  <div className="signal-detail">
                    <div className="signal-detail-cols">

                      {/* All reasons */}
                      <div className="detail-col">
                        <div className="detail-col-title">Signal reasons</div>
                        <ul className="reason-list">
                          {result.reasons.map((r, i) => (
                            <li key={i} className="reason-item">
                              <span className="reason-dot" style={{ color: meta?.color ?? 'var(--text-muted)' }}>•</span>
                              {r}
                            </li>
                          ))}
                        </ul>
                      </div>

                      {/* Pillar scores */}
                      <div className="detail-col">
                        <div className="detail-col-title">Pillar breakdown</div>
                        <div className="detail-bars">
                          {WEIGHT_KEYS.map(k => (
                            <div key={k} className="detail-bar-row">
                              <span className="db-label">{k}</span>
                              <div className="db-track">
                                <div className="db-fill"
                                  style={{
                                    width: `${stock?.scores?.[k] ?? 0}%`,
                                    background: scoreColor(stock?.scores?.[k] ?? 0)
                                  }} />
                              </div>
                              <span className="db-val" style={{ color: scoreColor(stock?.scores?.[k] ?? 0) }}>
                                {stock?.scores?.[k] ?? 0}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Position summary */}
                      <div className="detail-col">
                        <div className="detail-col-title">Position summary</div>
                        {pos ? (
                          <div className="pos-summary">
                            <div className="ps-row"><span>Shares</span><strong>{pos.shares}</strong></div>
                            <div className="ps-row"><span>Cost basis</span><strong>${fmtNum(pos.costBasis)}</strong></div>
                            <div className="ps-row"><span>Live price</span><strong>${fmtNum(price)}</strong></div>
                            <div className="ps-row">
                              <span>Market value</span>
                              <strong>${(pos.shares * price).toFixed(2)}</strong>
                            </div>
                            <div className="ps-row">
                              <span>Gain / loss</span>
                              <strong style={{ color: result.metrics.priceChange >= 0 ? 'var(--green)' : 'var(--red)' }}>
                                ${((price - pos.costBasis) * pos.shares).toFixed(2)}
                                {' '}({fmtPct(result.metrics.priceChange)})
                              </strong>
                            </div>
                            {pos.entryDate && (
                              <div className="ps-row"><span>Entry date</span><strong>{pos.entryDate}</strong></div>
                            )}
                          </div>
                        ) : (
                          <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                            Enter shares and cost basis in the Positions tab to unlock full signal analysis.
                          </p>
                        )}
                      </div>

                    </div>

                    {/* Why it was added */}
                    {stock?.why && (
                      <div className="signal-why">
                        <span className="detail-col-title">Original thesis</span>
                        <p>{stock.why}</p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
