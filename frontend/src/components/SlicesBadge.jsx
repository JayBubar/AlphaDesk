/**
 * "Slices" badge — surfaces Schwab Stock Slices eligibility on a row.
 *
 * Slices eligibility = S&P 500 membership. The screener tags every result
 * with `slices: true` when the universe entry's index is 'sp500'. Render
 * this badge anywhere a row already shows the ticker.
 */
import './SlicesBadge.css'

export default function SlicesBadge({ active, size = 'sm' }) {
  if (!active) return null
  return (
    <span className={`slices-badge slices-badge--${size}`}
      title="Schwab Stock Slices eligible · S&P 500">
      Slices
    </span>
  )
}
