/**
 * Movers card — biggest 7-day composite score changes across the watchlist.
 *
 * Pulls per-ticker history from storage.loadScoreHistory(), compares the most
 * recent snapshot to the closest snapshot from 7 days ago, and surfaces the
 * top N up/down movers. Surfaces *what shifted* since the last visit, which is
 * the actual reason to come back to the app.
 */
import { storage } from '../lib/storage.js'
import { scoreColor } from '../lib/scoring.js'

const LOOKBACK_DAYS = 7
const TOP_N = 5

function pickComparison(snapshots, lookbackMs) {
  if (snapshots.length < 2) return null
  // snapshots is newest-first.
  const latest = snapshots[0]
  const cutoff = new Date(latest.savedAt).getTime() - lookbackMs

  // Find the snapshot that's just before the cutoff (or the oldest available).
  let baseline = snapshots[snapshots.length - 1]
  for (const s of snapshots) {
    if (new Date(s.savedAt).getTime() <= cutoff) {
      baseline = s
      break
    }
  }
  if (baseline === latest) return null
  return { latest, baseline }
}

export default function Movers({ watchlist }) {
  if (!watchlist?.length) return null

  const lookbackMs = LOOKBACK_DAYS * 24 * 60 * 60 * 1000
  const all = []

  for (const w of watchlist) {
    if (w.noScore) continue  // ETFs/MFs have no composite
    const snapshots = storage.loadScoreHistory(w.ticker) || []
    const cmp = pickComparison(snapshots, lookbackMs)
    if (!cmp) continue
    const delta = cmp.latest.composite - cmp.baseline.composite
    if (Math.abs(delta) < 1) continue  // ignore noise

    all.push({
      ticker:   w.ticker,
      name:     w.name,
      latest:   cmp.latest.composite,
      baseline: cmp.baseline.composite,
      delta,
      daysAgo:  Math.round((new Date(cmp.latest.savedAt) - new Date(cmp.baseline.savedAt)) / 86_400_000),
    })
  }

  if (!all.length) {
    return (
      <section className="movers-card">
        <div className="movers-head">
          <span className="movers-title">{LOOKBACK_DAYS}-day movers</span>
          <span className="movers-sub">no score history yet · run the screener twice</span>
        </div>
      </section>
    )
  }

  const sortedDesc = [...all].sort((a, b) => b.delta - a.delta)
  const winners = sortedDesc.slice(0, TOP_N).filter(m => m.delta > 0)
  const losers  = [...sortedDesc].reverse().slice(0, TOP_N).filter(m => m.delta < 0)

  return (
    <section className="movers-card">
      <div className="movers-head">
        <span className="movers-title">{LOOKBACK_DAYS}-day movers</span>
        <span className="movers-sub">biggest composite shifts vs ~{LOOKBACK_DAYS} days ago</span>
      </div>

      <div className="movers-grid">
        <div className="movers-col">
          <div className="movers-col-title movers-col-title--up">↑ Improving</div>
          {winners.length === 0
            ? <div className="movers-empty">no winners</div>
            : winners.map(m => <MoverRow key={m.ticker} m={m} />)}
        </div>
        <div className="movers-col">
          <div className="movers-col-title movers-col-title--down">↓ Deteriorating</div>
          {losers.length === 0
            ? <div className="movers-empty">no losers</div>
            : losers.map(m => <MoverRow key={m.ticker} m={m} />)}
        </div>
      </div>
    </section>
  )
}

function MoverRow({ m }) {
  const sign = m.delta > 0 ? '+' : ''
  const color = m.delta > 0 ? 'var(--green)' : 'var(--red)'
  return (
    <div className="mover-row">
      <div className="mover-tk">
        <span className="mover-ticker">{m.ticker}</span>
        <span className="mover-name">{m.name}</span>
      </div>
      <div className="mover-scores">
        <span className="mover-baseline" title={`${m.daysAgo}d ago`}>{m.baseline}</span>
        <span className="mover-arrow">→</span>
        <span className="mover-latest" style={{ color: scoreColor(m.latest) }}>{m.latest}</span>
        <span className="mover-delta" style={{ color }}>
          {sign}{m.delta.toFixed(0)}
        </span>
      </div>
    </div>
  )
}
