/**
 * Sector heatmap — mean composite score per sector across the current results.
 * Click a cell to set the sector filter and re-run. Surfaces "which sectors
 * are scoring well right now" in one glance.
 */
const SECTOR_ORDER = [
  'Information Technology',
  'Communication Services',
  'Consumer Discretionary',
  'Consumer Staples',
  'Health Care',
  'Financials',
  'Industrials',
  'Energy',
  'Materials',
  'Utilities',
  'Real Estate',
]

function sectorColor(score) {
  if (score == null) return 'var(--bg-input)'
  // 0 → red, 50 → neutral gray, 100 → green. Use HSL for smooth gradient.
  const clamped = Math.max(0, Math.min(100, score))
  if (clamped >= 50) {
    // 50→100 maps to gray→green
    const t = (clamped - 50) / 50
    return `hsl(155, ${30 + t * 40}%, ${22 + t * 8}%)`
  }
  // 0→50 maps to red→gray
  const t = clamped / 50
  return `hsl(0, ${50 - t * 30}%, ${22 + t * 4}%)`
}

function textColor(score) {
  if (score == null) return 'var(--text-muted)'
  return score >= 30 ? 'var(--text-primary)' : 'rgba(255,255,255,0.75)'
}

export default function SectorHeatmap({ results, activeSector, onSectorClick }) {
  if (!results || results.length === 0) return null

  // Aggregate by GICS sector
  const buckets = new Map()
  for (const r of results) {
    const sec = r.sector || 'Unknown'
    if (!buckets.has(sec)) buckets.set(sec, { sum: 0, count: 0, top: null })
    const b = buckets.get(sec)
    b.sum += r.composite ?? 0
    b.count += 1
    if (!b.top || (r.composite ?? 0) > (b.top.composite ?? 0)) b.top = r
  }

  // Always show all 11 GICS cells (including ones with no data — empty state)
  // plus any extra sector strings that appeared in results.
  const known = new Set(SECTOR_ORDER)
  const extras = Array.from(buckets.keys()).filter(s => !known.has(s))
  const all = [...SECTOR_ORDER, ...extras]

  return (
    <section className="sector-heatmap">
      <div className="sh-header">
        <span className="sh-title">Sector heatmap</span>
        <span className="sh-sub">mean composite · click to filter</span>
      </div>
      <div className="sh-grid">
        {all.map(sec => {
          const b = buckets.get(sec)
          const mean = b ? Math.round(b.sum / b.count) : null
          const isActive = activeSector === sec
          const isClickable = !!onSectorClick && b
          return (
            <button key={sec}
              type="button"
              className={`sh-cell ${isActive ? 'active' : ''} ${b ? '' : 'empty'}`}
              style={{
                background: sectorColor(mean),
                color: textColor(mean),
                cursor: isClickable ? 'pointer' : 'default',
              }}
              disabled={!isClickable}
              onClick={() => isClickable && onSectorClick(isActive ? '' : sec)}
              title={b ? `${b.count} stocks · top: ${b.top.ticker} (${b.top.composite})` : 'no results in this sector'}
            >
              <span className="sh-cell-name">{sec}</span>
              <span className="sh-cell-score">{mean != null ? mean : '—'}</span>
              <span className="sh-cell-count">{b ? `${b.count} stk` : ''}</span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
