import type { ReactNode } from 'react'

export function Panel(props: {
  title: string
  sub?: string
  right?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={`panel ${props.className ?? ''}`}>
      <header className="panel-head">
        <div>
          <h3>{props.title}</h3>
          {props.sub && <p className="panel-sub">{props.sub}</p>}
        </div>
        {props.right && <div className="panel-right">{props.right}</div>}
      </header>
      <div className="panel-body">{props.children}</div>
    </section>
  )
}

export function Stat(props: {
  label: string
  value: ReactNode
  tone?: 'up' | 'down' | 'neutral'
  hint?: string
}) {
  return (
    <div className="stat" title={props.hint}>
      <span className="stat-label">{props.label}</span>
      <span className={`stat-value tone-${props.tone ?? 'neutral'}`}>{props.value}</span>
    </div>
  )
}

export function Tag(props: { children: ReactNode; tone?: 'live' | 'sim' | 'warn' | 'info' }) {
  return <span className={`tag tag-${props.tone ?? 'info'}`}>{props.children}</span>
}

export function LiveBadge(props: { ok: boolean; label?: string }) {
  return (
    <span className={`live-badge ${props.ok ? 'ok' : 'bad'}`}>
      <span className="dot" />
      {props.label ?? (props.ok ? 'LIVE · mainnet indexer' : 'reconnecting…')}
    </span>
  )
}

export function Empty(props: { text: string; tone?: 'error' }) {
  return <div className={`empty ${props.tone === 'error' ? 'error' : ''}`}>{props.text}</div>
}

export function Modal(props: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="modal-overlay" onClick={props.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h3>{props.title}</h3>
          <button className="btn ghost" onClick={props.onClose}>
            ✕
          </button>
        </header>
        <div className="modal-body">{props.children}</div>
      </div>
    </div>
  )
}

export function ScoreBar(props: { score: number }) {
  const tone = props.score >= 80 ? 'up' : props.score >= 55 ? 'neutral' : 'down'
  return (
    <div className="scorebar">
      <div className={`scorebar-fill tone-bg-${tone}`} style={{ width: `${props.score}%` }} />
      <span>{props.score.toFixed(0)}</span>
    </div>
  )
}

/** 0-100 execution-quality gauge: <40 poor, 40-70 fair, >70 good. */
export function Gauge(props: { score: number }) {
  const pct = Math.min(100, Math.max(0, props.score))
  const tone = pct >= 70 ? 'up' : pct >= 40 ? 'neutral' : 'down'
  const label = pct >= 70 ? 'good' : pct >= 40 ? 'fair' : 'poor'
  return (
    <div className="gauge">
      <div className="gauge-bar">
        <div className={`gauge-fill tone-bg-${tone}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="gauge-label">
        {pct.toFixed(0)} · {label}
      </span>
    </div>
  )
}
