import './ScoreBar.css'

export default function ScoreBar({ label, value }) {
  const color = value >= 75 ? 'var(--green)' : value >= 55 ? 'var(--amber)' : 'var(--red)'
  return (
    <div className="score-bar-row">
      <span className="sb-label">{label}</span>
      <div className="sb-track">
        <div className="sb-fill" style={{ width: `${value}%`, background: color }} />
      </div>
      <span className="sb-val" style={{ color }}>{value}</span>
    </div>
  )
}
