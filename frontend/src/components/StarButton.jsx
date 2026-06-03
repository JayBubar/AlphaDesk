/**
 * Shared favorite toggle. Used in Watchlist + Portfolio rows.
 * Starred tickers surface in the Signals tab.
 */
import './StarButton.css'

export default function StarButton({ active, onToggle, title }) {
  return (
    <button
      type="button"
      className={`star-btn ${active ? 'star-btn--active' : ''}`}
      onClick={(e) => { e.stopPropagation(); onToggle?.(); }}
      title={title || (active ? 'Remove from favorites' : 'Add to favorites · shows in Signals')}
      aria-label={active ? 'Unstar' : 'Star'}
    >
      {active ? '★' : '☆'}
    </button>
  )
}
