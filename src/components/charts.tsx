import type { ReactNode } from 'react'
import type { Candle, OrderbookSnapshot } from '../lib/indexer'
import type { VolPoint } from '../lib/microstructure'
import { fmtPrice } from '../lib/format'

export interface TcaPoint {
  timestamp: number
  effectiveBps: number
  impactBps: number
  realizedBps: number
}

export interface SmilePoint {
  strikePct: number
  sigma: number
}

// ----------------------------- Sparkline -----------------------------------

export function Sparkline(props: { values: number[]; width?: number; height?: number }) {
  const { values } = props
  const w = props.width ?? 110
  const h = props.height ?? 28
  if (values.length < 2) return <svg width={w} height={h} />
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const pts = values
    .map(
      (v, i) =>
        `${((i / (values.length - 1)) * (w - 2) + 1).toFixed(1)},${(h - 2 - ((v - min) / span) * (h - 4)).toFixed(1)}`,
    )
    .join(' ')
  const up = values[values.length - 1] >= values[0]
  return (
    <svg width={w} height={h} className="sparkline">
      <polyline points={pts} fill="none" stroke={up ? 'var(--up)' : 'var(--down)'} strokeWidth="1.5" />
    </svg>
  )
}

// ------------------------------ Candles ------------------------------------

export function Candles(props: { candles: Candle[]; height?: number }) {
  const cs = props.candles.filter((c) => c[4] > 0).slice().sort((a, b) => a[0] - b[0])
  const h = props.height ?? 260
  const axisH = 18
  const w = 760
  if (cs.length < 2) return <div className="empty">no candle data for this pool</div>
  const lows = cs.map((c) => c[3])
  const highs = cs.map((c) => c[2])
  const min = Math.min(...lows)
  const max = Math.max(...highs)
  const span = max - min || 1
  const bw = Math.max(2, Math.floor((w - 50) / cs.length) - 2)
  const y = (p: number) => 8 + (1 - (p - min) / span) * (h - 30)
  const vols = cs.map((c) => c[5])
  const maxVol = Math.max(...vols) || 1

  const tickCount = Math.min(6, cs.length)
  const tickIdxs = Array.from(
    new Set(
      Array.from({ length: tickCount }, (_, k) =>
        Math.round((k / (tickCount - 1)) * (cs.length - 1)),
      ),
    ),
  )
  const axisLabel = (ts: number) => {
    const d = new Date(ts)
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:00`
  }

  return (
    <svg viewBox={`0 0 ${w} ${h + axisH}`} className="candles" preserveAspectRatio="none">
      {/* gridlines */}
      {[0, 0.25, 0.5, 0.75, 1].map((f) => (
        <g key={f}>
          <line x1={0} x2={w - 48} y1={y(min + f * span)} y2={y(min + f * span)} className="grid" />
          <text x={w - 44} y={y(min + f * span) + 3} className="axis">
            {fmtPrice(min + f * span)}
          </text>
        </g>
      ))}
      {cs.map((c, i) => {
        const x = 4 + i * ((w - 56) / cs.length)
        const up = c[4] >= c[1]
        const col = up ? 'var(--up)' : 'var(--down)'
        return (
          <g key={c[0]}>
            <rect
              x={x}
              y={h - 4 - (c[5] / maxVol) * 26}
              width={bw}
              height={(c[5] / maxVol) * 26}
              fill="var(--vol)"
            />
            <line x1={x + bw / 2} x2={x + bw / 2} y1={y(c[2])} y2={y(c[3])} stroke={col} />
            <rect
              x={x}
              y={Math.min(y(c[1]), y(c[4]))}
              width={bw}
              height={Math.max(1.5, Math.abs(y(c[1]) - y(c[4])))}
              fill={col}
            />
          </g>
        )
      })}
      {/* time axis */}
      {tickIdxs.map((i) => {
        const x = 4 + i * ((w - 56) / cs.length) + bw / 2
        const anchor = i === 0 ? 'start' : i === cs.length - 1 ? 'end' : 'middle'
        return (
          <text key={i} x={x} y={h + axisH - 5} className="axis" textAnchor={anchor}>
            {axisLabel(cs[i][0])}
          </text>
        )
      })}
    </svg>
  )
}

// ------------------------------ Depth ---------------------------------------

export function DepthRows(props: { ob: OrderbookSnapshot; rows?: number }) {
  const n = props.rows ?? 8
  const bids = props.ob.bids.slice(0, n).map(([p, q]) => [parseFloat(p), parseFloat(q)] as const)
  const asks = props.ob.asks.slice(0, n).map(([p, q]) => [parseFloat(p), parseFloat(q)] as const)
  const maxQ = Math.max(...bids.map((b) => b[1]), ...asks.map((a) => a[1]), 1)
  const bestBid = bids[0]?.[0]
  const bestAsk = asks[0]?.[0]
  const spreadAbs = bestBid != null && bestAsk != null ? bestAsk - bestBid : null
  const spreadBpsVal =
    spreadAbs != null && bestBid != null && bestAsk != null
      ? (spreadAbs / ((bestBid + bestAsk) / 2)) * 10_000
      : null
  return (
    <div>
      {spreadAbs != null && (
        <div className="depth-spread">
          spread <b>{fmtPrice(spreadAbs)}</b> · {spreadBpsVal!.toFixed(1)} bps
        </div>
      )}
      <div className="depth">
        <div className="depth-col">
          <div className="depth-header">
            <span>Bid size</span>
            <span>Price</span>
          </div>
          {bids.map(([p, q], i) => (
            <div className="depth-row bid" key={i}>
              <div className="depth-fill bid" style={{ width: `${(q / maxQ) * 100}%` }} />
              <span>{q.toLocaleString()}</span>
              <span className="tone-up">{fmtPrice(p)}</span>
            </div>
          ))}
        </div>
        <div className="depth-col">
          <div className="depth-header">
            <span>Price</span>
            <span>Ask size</span>
          </div>
          {asks.map(([p, q], i) => (
            <div className="depth-row ask" key={i}>
              <div className="depth-fill ask" style={{ width: `${(q / maxQ) * 100}%` }} />
              <span className="tone-down">{fmtPrice(p)}</span>
              <span>{q.toLocaleString()}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// --------------------------- Impact curve -----------------------------------

export interface ImpactPoint {
  pct: number
  buyBps: number
  sellBps: number
  buyFillable: boolean
  sellFillable: boolean
}

/** SVG line chart: x = size as % of book depth, y = slippage (bps). Unfillable
 *  segments are drawn dashed/grey rather than in the buy/sell colors. */
export function ImpactCurve(props: { points: ImpactPoint[] }) {
  const w = 720
  const h = 220
  const pts = props.points
  const ys = pts.flatMap((p) => [p.buyBps, p.sellBps]).filter((v) => !Number.isNaN(v))
  const yMax = (Math.max(...ys, 1) || 1) * 1.08
  const X = (pct: number) => 8 + (pct / 100) * (w - 60)
  const Y = (bps: number) => h - 26 - (Math.max(0, bps) / yMax) * (h - 42)

  const segments = (key: 'buyBps' | 'sellBps', fillKey: 'buyFillable' | 'sellFillable', color: string) => {
    const out: ReactNode[] = []
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]
      const b = pts[i + 1]
      if (Number.isNaN(a[key]) || Number.isNaN(b[key])) continue
      const ok = a[fillKey] && b[fillKey]
      out.push(
        <line
          key={`${key}-${i}`}
          x1={X(a.pct)}
          y1={Y(a[key])}
          x2={X(b.pct)}
          y2={Y(b[key])}
          stroke={ok ? color : 'var(--muted)'}
          strokeWidth={ok ? 2 : 1.5}
          strokeDasharray={ok ? undefined : '4 3'}
        />,
      )
    }
    return out
  }

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="payoff" preserveAspectRatio="none">
      <line x1={8} x2={w - 52} y1={Y(0)} y2={Y(0)} className="grid strong" />
      {[0, 0.5, 1].map((f) => (
        <text key={f} x={w - 48} y={Y(yMax * f) + 3} className="axis">
          {(yMax * f).toFixed(1)} bps
        </text>
      ))}
      {segments('sellBps', 'sellFillable', 'var(--accent2)')}
      {segments('buyBps', 'buyFillable', 'var(--accent)')}
      {pts.map((p) => (
        <text key={p.pct} x={X(p.pct)} y={h - 8} className="axis" textAnchor="middle">
          {p.pct.toFixed(0)}%
        </text>
      ))}
      <text x={8} y={14} className="axis">
        size as % of book depth
      </text>
    </svg>
  )
}

// ------------------------------ Payoff --------------------------------------

export function PayoffChart(props: {
  spot: number
  payoff: (s: number) => number
  widthPct?: number
}) {
  const w = 720
  const h = 240
  const range = (props.widthPct ?? 40) / 100
  const lo = props.spot * (1 - range)
  const hi = props.spot * (1 + range)
  const n = 160
  const xs: number[] = []
  const ys: number[] = []
  for (let i = 0; i <= n; i++) {
    const s = lo + ((hi - lo) * i) / n
    xs.push(s)
    ys.push(props.payoff(s))
  }
  const yMin = Math.min(...ys, 0)
  const yMax = Math.max(...ys, 0)
  const span = yMax - yMin || 1
  const X = (s: number) => ((s - lo) / (hi - lo)) * (w - 60) + 8
  const Y = (v: number) => 10 + (1 - (v - yMin) / span) * (h - 40)
  const pts = xs.map((s, i) => `${X(s).toFixed(1)},${Y(ys[i]).toFixed(1)}`).join(' ')

  // Break-even points: linear-interpolate where the payoff crosses zero.
  const breakEvens: number[] = []
  for (let i = 1; i < ys.length; i++) {
    const a = ys[i - 1]
    const b = ys[i]
    if (a === 0) breakEvens.push(xs[i - 1])
    else if (a < 0 !== b < 0) {
      const frac = a / (a - b)
      breakEvens.push(xs[i - 1] + (xs[i] - xs[i - 1]) * frac)
    }
  }

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="payoff" preserveAspectRatio="none">
      <line x1={8} x2={w - 52} y1={Y(0)} y2={Y(0)} className="grid strong" />
      <line x1={X(props.spot)} x2={X(props.spot)} y1={8} y2={h - 28} className="grid spot" />
      <text x={X(props.spot) + 4} y={20} className="axis">
        spot {fmtPrice(props.spot)}
      </text>
      <polyline points={pts} fill="none" stroke="var(--accent)" strokeWidth="2" />
      {breakEvens.map((s, i) => (
        <g key={i}>
          <circle cx={X(s)} cy={Y(0)} r={4} fill="var(--up)" />
          <text x={X(s)} y={Y(0) - 8} className="axis" textAnchor="middle">
            B/E {fmtPrice(s)}
          </text>
        </g>
      ))}
      {[lo, props.spot, hi].map((s) => (
        <text key={s} x={X(s) - 14} y={h - 12} className="axis">
          {fmtPrice(s)}
        </text>
      ))}
      <text x={w - 48} y={Y(yMax) + 4} className="axis">
        {yMax.toFixed(0)}
      </text>
      <text x={w - 48} y={Y(yMin)} className="axis">
        {yMin.toFixed(0)}
      </text>
    </svg>
  )
}

// ----------------------------- Volatility cone ------------------------------

/** Grouped bar chart: one bar per realized-vol horizon (annualized %). */
export function VolConeChart(props: { cone: VolPoint[] }) {
  const { cone } = props
  const w = 360
  const h = 160
  const padL = 36
  const padB = 22
  const maxVol = Math.max(...cone.map((c) => c.volAnnual), 0.01)
  const barW = (w - padL - 10) / Math.max(1, cone.length)
  const Y = (v: number) => h - padB - (v / maxVol) * (h - padB - 10)

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="payoff" preserveAspectRatio="none">
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line
            x1={padL}
            x2={w - 4}
            y1={Y(maxVol * f)}
            y2={Y(maxVol * f)}
            className="grid"
          />
          <text x={padL - 4} y={Y(maxVol * f) + 3} className="axis" textAnchor="end">
            {(maxVol * f * 100).toFixed(0)}%
          </text>
        </g>
      ))}
      {cone.map((c, i) => {
        const x = padL + i * barW + barW * 0.18
        const bw = barW * 0.64
        const y = Y(c.volAnnual)
        return (
          <g key={c.label}>
            <rect x={x} y={y} width={bw} height={h - padB - y} fill="var(--accent)" rx={2} />
            <text x={x + bw / 2} y={y - 4} className="axis" textAnchor="middle">
              {(c.volAnnual * 100).toFixed(0)}%
            </text>
            <text x={x + bw / 2} y={h - 6} className="axis" textAnchor="middle">
              {c.label}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

// --------------------------- TCA time series ---------------------------------

/** Effective spread / price impact / realized spread per trade, oldest to newest. */
export function TcaTimeSeries(props: { points: TcaPoint[] }) {
  const w = 720
  const h = 200
  const pts = props.points
  if (pts.length < 2) return <div className="empty">not enough trades for a time series</div>
  const yMax = Math.max(...pts.flatMap((p) => [Math.abs(p.effectiveBps), Math.abs(p.impactBps)]), 0.5) * 1.15
  const X = (i: number) => 8 + (i / (pts.length - 1)) * (w - 16)
  const Y = (v: number) => h / 2 - (v / yMax) * (h / 2 - 18)
  const poly = (key: 'effectiveBps' | 'impactBps') =>
    pts.map((p, i) => `${X(i).toFixed(1)},${Y(p[key]).toFixed(1)}`).join(' ')

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="payoff" preserveAspectRatio="none">
      <line x1={8} x2={w - 8} y1={Y(0)} y2={Y(0)} className="grid strong" />
      <text x={w - 8} y={Y(yMax) + 10} className="axis" textAnchor="end">
        {yMax.toFixed(1)} bps
      </text>
      <text x={w - 8} y={Y(-yMax) - 2} className="axis" textAnchor="end">
        {(-yMax).toFixed(1)} bps
      </text>
      <polyline points={poly('impactBps')} fill="none" stroke="var(--accent2)" strokeWidth="1.5" />
      <polyline points={poly('effectiveBps')} fill="none" stroke="var(--accent)" strokeWidth="2" />
      <text x={8} y={14} className="axis">
        oldest → newest ({pts.length} trades)
      </text>
    </svg>
  )
}

// ----------------------------- Vol smile --------------------------------------

/** Implied vol vs strike from the empirical up/down realized-vol skew. */
export function VolSmileChart(props: { points: SmilePoint[] }) {
  const w = 360
  const h = 160
  const padL = 40
  const padB = 20
  const pts = props.points
  if (pts.length < 2) return <div className="empty">not enough history for a vol smile</div>
  const sigmas = pts.map((p) => p.sigma)
  const yMin = Math.min(...sigmas) * 0.95
  const yMax = Math.max(...sigmas) * 1.05
  const span = yMax - yMin || 1
  const k0 = pts[0].strikePct
  const kSpan = pts[pts.length - 1].strikePct - k0 || 1
  const X = (k: number) => padL + ((k - k0) / kSpan) * (w - padL - 8)
  const Y = (v: number) => h - padB - ((v - yMin) / span) * (h - padB - 10)
  const line = pts.map((p) => `${X(p.strikePct).toFixed(1)},${Y(p.sigma).toFixed(1)}`).join(' ')

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="payoff" preserveAspectRatio="none">
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line x1={padL} x2={w - 4} y1={Y(yMin + f * span)} y2={Y(yMin + f * span)} className="grid" />
          <text x={padL - 4} y={Y(yMin + f * span) + 3} className="axis" textAnchor="end">
            {((yMin + f * span) * 100).toFixed(0)}%
          </text>
        </g>
      ))}
      <polyline points={line} fill="none" stroke="var(--accent)" strokeWidth="2" />
      {pts.map((p) => (
        <circle key={p.strikePct} cx={X(p.strikePct)} cy={Y(p.sigma)} r={2.5} fill="var(--accent)" />
      ))}
      {pts.map((p) => (
        <text key={`l-${p.strikePct}`} x={X(p.strikePct)} y={h - 4} className="axis" textAnchor="middle">
          {p.strikePct > 0 ? '+' : ''}
          {p.strikePct}%
        </text>
      ))}
    </svg>
  )
}
