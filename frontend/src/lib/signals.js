/**
 * AlphaDesk — Sell Signal / Hold Engine
 * Pure logic, no API calls. Runs on scores + position data.
 */

export const SIGNAL = {
  STRONG_HOLD: 'STRONG_HOLD',
  HOLD:        'HOLD',
  REVIEW:      'REVIEW',
  SELL:        'SELL',
}

export const SIGNAL_META = {
  STRONG_HOLD: { label: 'Strong Hold', color: 'var(--green)',  bg: 'var(--green-dim)',  icon: '▲' },
  HOLD:        { label: 'Hold',         color: 'var(--blue)',   bg: 'var(--blue-dim)',   icon: '●' },
  REVIEW:      { label: 'Review',       color: 'var(--amber)',  bg: 'var(--amber-dim)',  icon: '⚠' },
  SELL:        { label: 'Sell',         color: 'var(--red)',    bg: 'var(--red-dim)',    icon: '▼' },
}

/**
 * Evaluate a single position and return a signal + reasons.
 *
 * @param {object} stock      - Full stock object from screener (includes scores, composite)
 * @param {object} position   - { shares, costBasis, entryDate, entryScore }
 * @param {number} livePrice  - Current market price
 * @param {object} settings   - User-configured thresholds
 * @returns {object}          - { signal, reasons, metrics }
 */
export function evaluateSignal(stock, position, livePrice, settings = {}) {
  const {
    hardStopScore    = 40,   // composite below this → SELL
    softAlertScore   = 55,   // composite below this → REVIEW
    stopLossPct      = 15,   // % down from cost → SELL
    reviewDropPct    = 10,   // % down from cost → REVIEW
    scoreDropAlert   = 15,   // points dropped from entry score → REVIEW
    scoreDropSell    = 30,   // points dropped from entry score → SELL
    strongHoldScore  = 75,   // composite above this → STRONG HOLD
    daysBeforeReview = 90,   // days held before time-based review
  } = settings

  const reasons = []
  const sellTriggers   = []
  const reviewTriggers = []

  const composite   = stock.composite ?? 0
  const scores      = stock.scores ?? {}
  const entryScore  = position.entryScore ?? composite
  const costBasis   = position.costBasis ?? 0
  const entryDate   = position.entryDate ? new Date(position.entryDate) : null
  const daysHeld    = entryDate
    ? Math.floor((Date.now() - entryDate.getTime()) / (1000 * 60 * 60 * 24))
    : null

  const priceChange = costBasis > 0
    ? ((livePrice - costBasis) / costBasis) * 100
    : null
  const scoreDrop   = entryScore - composite

  // ── HARD SELL triggers ────────────────────────────────────────────────

  if (composite < hardStopScore) {
    sellTriggers.push(`Composite score ${composite} is below hard stop of ${hardStopScore}`)
  }

  if (priceChange !== null && priceChange <= -stopLossPct) {
    sellTriggers.push(`Price down ${Math.abs(priceChange).toFixed(1)}% from cost basis — stop loss triggered`)
  }

  if (scoreDrop >= scoreDropSell) {
    sellTriggers.push(`Score dropped ${scoreDrop} points from entry (was ${entryScore}, now ${composite})`)
  }

  // Individual pillar collapse
  const weakPillars = Object.entries(scores).filter(([, v]) => v < 35)
  if (weakPillars.length >= 3) {
    sellTriggers.push(`${weakPillars.length} of 5 pillars below 35 — broad deterioration`)
  }

  // ── SOFT REVIEW triggers ──────────────────────────────────────────────

  if (composite < softAlertScore && composite >= hardStopScore) {
    reviewTriggers.push(`Composite score ${composite} below ${softAlertScore} — momentum weakening`)
  }

  if (priceChange !== null && priceChange <= -reviewDropPct && priceChange > -stopLossPct) {
    reviewTriggers.push(`Price down ${Math.abs(priceChange).toFixed(1)}% — approaching stop loss`)
  }

  if (scoreDrop >= scoreDropAlert && scoreDrop < scoreDropSell) {
    reviewTriggers.push(`Score dropped ${scoreDrop} points from entry — thesis eroding`)
  }

  if (daysHeld !== null && daysHeld >= daysBeforeReview && composite < strongHoldScore) {
    reviewTriggers.push(`Held ${daysHeld} days — time to re-evaluate thesis`)
  }

  // Sentiment flip
  if (scores.sentiment < 40) {
    reviewTriggers.push('Sentiment pillar weak — analyst/market tone turned negative')
  }

  // Filing tone warning
  if (scores.filingTone < 40) {
    reviewTriggers.push('Filing tone score low — language in recent filings may have shifted')
  }

  // ── STRONG HOLD conditions ────────────────────────────────────────────

  const strongHoldReasons = []
  if (composite >= strongHoldScore) {
    strongHoldReasons.push(`Composite score ${composite} — above strong hold threshold`)
  }
  if (priceChange !== null && priceChange > 20) {
    strongHoldReasons.push(`Up ${priceChange.toFixed(1)}% — momentum intact`)
  }
  if (scores.fundamentals >= 75 && scores.momentum >= 70) {
    strongHoldReasons.push('Fundamentals + momentum both strong — core thesis intact')
  }

  // ── Determine final signal ────────────────────────────────────────────

  let signal
  if (sellTriggers.length > 0) {
    signal = SIGNAL.SELL
    reasons.push(...sellTriggers)
  } else if (reviewTriggers.length > 0) {
    signal = SIGNAL.REVIEW
    reasons.push(...reviewTriggers)
  } else if (strongHoldReasons.length >= 2) {
    signal = SIGNAL.STRONG_HOLD
    reasons.push(...strongHoldReasons)
  } else {
    signal = SIGNAL.HOLD
    reasons.push(`Composite score ${composite} — no sell or review triggers active`)
    if (priceChange !== null && priceChange > 0) {
      reasons.push(`Up ${priceChange.toFixed(1)}% from cost — position profitable`)
    }
  }

  return {
    signal,
    reasons,
    metrics: {
      composite,
      entryScore,
      scoreDrop,
      priceChange,
      daysHeld,
      weakPillars: weakPillars.map(([k]) => k),
    }
  }
}

/**
 * Evaluate all watchlist positions at once.
 * Returns array sorted by urgency (SELL first, then REVIEW, HOLD, STRONG_HOLD).
 */
export function evaluateAll(watchlist, positions, livePrices, settings = {}) {
  const ORDER = { SELL: 0, REVIEW: 1, HOLD: 2, STRONG_HOLD: 3 }

  return watchlist
    .map(stock => {
      const pos   = positions[stock.ticker]
      const price = livePrices[stock.ticker]?.price ?? stock.price ?? 0
      if (!pos?.shares || !pos?.costBasis) {
        return {
          ticker: stock.ticker,
          name: stock.name,
          signal: null,  // no position entered
          reasons: ['No position data — enter shares and cost basis to get a signal'],
          metrics: { composite: stock.composite ?? 0 },
        }
      }
      const result = evaluateSignal(stock, pos, price, settings)
      return { ticker: stock.ticker, name: stock.name, ...result }
    })
    .sort((a, b) => {
      const ao = a.signal ? ORDER[a.signal] : 4
      const bo = b.signal ? ORDER[b.signal] : 4
      return ao - bo
    })
}
