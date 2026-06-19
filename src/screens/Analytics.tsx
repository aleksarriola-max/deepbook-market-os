import { useMemo, useState } from 'react'
import { usePoll } from '../lib/hooks'
import { indexer } from '../lib/indexer'
import {
  tradeCostAnalysis,
  tcaScore,
  kyleLambda,
  bookShape,
  impactCurve,
  exploreRoutes,
  type RouteQuote,
} from '../lib/microstructure'
import { useSession } from '../lib/session'
import { fmt, fmtPrice, clock, shortAddr } from '../lib/format'
import { Panel, Stat, ScoreBar, Gauge, LiveBadge, Empty, Tag } from '../components/ui'
import { ImpactCurve, TcaTimeSeries, type ImpactPoint, type TcaPoint } from '../components/charts'

/**
 * Layer 1/3 — Execution Analytics.
 * Real transaction-cost analysis on the live tape:
 *  - effective / realized spread / price-impact decomposition (Hasbrouck)
 *  - Kyle's lambda with R² from the canonical impact regression
 *  - exact walk-the-book impact curves
 *  - multi-hop route comparison across DeepBook's shared-liquidity pools
 */
export function Analytics() {
  const { pool } = useSession()
  const ob = usePoll(() => indexer.orderbook(pool, 60), 3_000, [pool])
  const trades = usePoll(() => indexer.trades(pool, 100), 5_000, [pool])
  const orderUpdates = usePoll(() => indexer.orderUpdates(pool, 40), 8_000, [pool])
  const pools = usePoll(() => indexer.pools(), 120_000)

  const tca = useMemo(() => (trades.data ? tradeCostAnalysis(trades.data) : null), [trades.data])
  const lambda = useMemo(() => (trades.data ? kyleLambda(trades.data) : null), [trades.data])
  const shape = useMemo(() => (ob.data ? bookShape(ob.data) : null), [ob.data])

  const curves = useMemo(() => {
    if (!ob.data) return null
    const askDepth = ob.data.asks.reduce((a, [, q]) => a + parseFloat(q), 0)
    const bidDepth = ob.data.bids.reduce((a, [, q]) => a + parseFloat(q), 0)
    const depth = Math.min(askDepth, bidDepth)
    if (depth <= 0) return null
    const fracs = [0.01, 0.02, 0.05, 0.1, 0.2, 0.4, 0.7, 1.0]
    const sizes = fracs.map((f) => depth * f)
    return {
      fracs,
      sizes,
      buy: impactCurve(ob.data, 'buy', sizes),
      sell: impactCurve(ob.data, 'sell', sizes),
    }
  }, [ob.data])

  const curvePoints = useMemo<ImpactPoint[] | null>(() => {
    if (!curves) return null
    return curves.fracs.map((f, i) => ({
      pct: f * 100,
      buyBps: curves.buy[i].slippageBps,
      sellBps: curves.sell[i].slippageBps,
      buyFillable: curves.buy[i].fillable,
      sellFillable: curves.sell[i].fillable,
    }))
  }, [curves])

  const avgScore = useMemo(() => {
    if (!tca || !shape) return null
    const scores = tca.rows.map((r) => tcaScore(r.effectiveBps, shape.quotedSpreadBps))
    return scores.reduce((a, s) => a + s, 0) / scores.length
  }, [tca, shape])

  // tca.rows arrives newest-first; the time series reads oldest -> newest.
  const tcaSeries = useMemo<TcaPoint[] | null>(() => {
    if (!tca) return null
    return [...tca.rows]
      .reverse()
      .map((r) => ({
        timestamp: r.trade.timestamp,
        effectiveBps: r.effectiveBps,
        impactBps: r.impactBps,
        realizedBps: r.realizedBps,
      }))
  }, [tca])

  // ------------------------- route explorer state -------------------------
  const [routeQty, setRouteQty] = useState(1000)
  const [routes, setRoutes] = useState<RouteQuote[] | null>(null)
  const [routing, setRouting] = useState(false)
  const [base, quote] = pool.split('_')

  const quoteRoutes = async () => {
    if (!pools.data) return
    setRouting(true)
    try {
      setRoutes(await exploreRoutes(pools.data, base, quote, 'sell', routeQty))
    } finally {
      setRouting(false)
    }
  }

  const placed = (orderUpdates.data ?? []).filter((o) => o.status === 'Placed').length
  const canceled = (orderUpdates.data ?? []).filter((o) => o.status === 'Canceled').length

  return (
    <div>
      <div className="screen-head">
        <h2>Execution Analytics</h2>
        <p>Transaction-cost analysis, price impact and routing for {pool} — all from live data</p>
        <LiveBadge ok={!trades.error && !!trades.data} />
      </div>

      <div className="stat-row">
        <Stat
          label="Avg effective spread"
          value={tca ? `${tca.avgEffectiveBps.toFixed(2)} bps` : '—'}
          hint="2q(p−m)/m per trade; what takers actually paid vs local mid"
        />
        <Stat
          label="Avg price impact (5-trade)"
          value={tca ? `${tca.avgImpactBps.toFixed(2)} bps` : '—'}
          tone={tca && tca.avgImpactBps > 0 ? 'down' : 'neutral'}
          hint="2q(m₅−m)/m: permanent move after the trade — information content"
        />
        <Stat
          label="Avg realized spread (maker edge)"
          value={tca ? `${tca.avgRealizedBps.toFixed(2)} bps` : '—'}
          tone={tca && tca.avgRealizedBps > 0 ? 'up' : 'down'}
          hint="effective − impact: what liquidity providers net after adverse selection"
        />
        <Stat
          label="Kyle's λ"
          value={lambda ? `${lambda.lambdaBpsPerPct.toFixed(2)} bps/1% vol` : '—'}
          hint="slope of Δmid on signed normalized volume (impact regression)"
        />
        <Stat
          label="λ fit (R² · n)"
          value={lambda ? `R²=${lambda.r2.toFixed(2)} · n=${lambda.n}` : '—'}
          tone={lambda && lambda.r2 < 0.1 ? 'down' : 'neutral'}
          hint="R² near zero on thin tape → treat λ with caution"
        />
        <Stat
          label="Book imbalance (±50bps)"
          value={shape ? `${(shape.imbalance * 100).toFixed(0)}%` : '—'}
          tone={shape && shape.imbalance > 0 ? 'up' : 'down'}
          hint="(bid−ask)/(bid+ask) depth near mid — short-horizon pressure signal"
        />
        <Stat
          label="Avg execution score"
          value={avgScore != null ? <Gauge score={avgScore} /> : '—'}
          hint="0-100 from tcaScore (effective spread vs quoted spread): <40 poor · 40-70 fair · >70 good"
        />
      </div>
      {lambda && lambda.r2 < 0.1 && (
        <p className="note" style={{ marginTop: 6 }}>
          <b>Caveat:</b> Kyle's λ has R²={lambda.r2.toFixed(2)} on this tape — near zero, so λ is
          noisy and shouldn't be treated as a reliable impact estimate right now.
        </p>
      )}

      <div className="screen-grid cols-2">
        <Panel
          title="Price impact curve (exact, walk-the-book)"
          sub="Deterministic slippage from consuming visible depth — not a model. Sizes scaled to current book depth; dashed/grey segments exceed visible depth on that side."
        >
          {curves && curvePoints ? (
            <>
              <ImpactCurve points={curvePoints} />
              <p className="note" style={{ margin: '4px 0 8px' }}>
                <span style={{ color: 'var(--accent)' }}>■</span> buy (consume asks) ·{' '}
                <span style={{ color: 'var(--accent2)' }}>■</span> sell (consume bids) ·{' '}
                <span style={{ color: 'var(--muted)' }}>- - -</span> exceeds visible depth
              </p>
              <table className="tbl">
                <thead>
                  <tr>
                    <th className="num">Size (base)</th>
                    <th className="num">Buy slippage</th>
                    <th className="num">Sell slippage</th>
                    <th>Fillable</th>
                  </tr>
                </thead>
                <tbody>
                  {curves.sizes.map((s, i) => (
                    <tr key={s}>
                      <td className="num">{fmt(s)}</td>
                      <td className="num tone-down">
                        {Number.isNaN(curves.buy[i].slippageBps)
                          ? '—'
                          : `${curves.buy[i].slippageBps.toFixed(2)} bps`}
                      </td>
                      <td className="num tone-down">
                        {Number.isNaN(curves.sell[i].slippageBps)
                          ? '—'
                          : `${curves.sell[i].slippageBps.toFixed(2)} bps`}
                      </td>
                      <td>
                        <Tag tone={curves.buy[i].fillable && curves.sell[i].fillable ? 'live' : 'warn'}>
                          {curves.buy[i].fillable && curves.sell[i].fillable
                            ? 'both sides'
                            : 'exceeds visible depth'}
                        </Tag>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <Empty text="loading book…" />
          )}
        </Panel>

        <Panel
          title="Smart route explorer"
          sub={`Every ≤3-hop path from ${base} to ${quote} (up to 2 intermediate assets) is simulated against its real books, with taker fees compounded per hop`}
        >
          <div className="form-row">
            <label className="fld">
              sell quantity ({base})
              <input
                type="number"
                value={routeQty}
                onChange={(e) => setRouteQty(+e.target.value || 1)}
              />
            </label>
            <button className="btn" onClick={quoteRoutes} disabled={routing || !pools.data}>
              {routing ? 'walking books…' : 'Quote all routes'}
            </button>
          </div>
          {routes ? (
            routes.length ? (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Route</th>
                    <th className="num">Legs</th>
                    <th className="num">Effective price</th>
                    <th className="num">Slippage</th>
                    <th className="num">Fees</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {routes.map((r, i) => (
                    <tr key={r.path.join('-')} className={i === 0 ? 'highlight' : ''}>
                      <td>
                        {r.path.join(' → ')} {i === 0 && <Tag tone="live">best</Tag>}
                      </td>
                      <td className="num">{r.path.length - 1}</td>
                      <td className="num">{fmtPrice(r.effectivePrice)}</td>
                      <td className="num">{r.totalSlippageBps.toFixed(2)} bps</td>
                      <td className="num">{r.totalFeeBps} bps</td>
                      <td>
                        <Tag tone={r.fillable ? 'live' : 'warn'}>
                          {r.fillable ? 'fully fillable' : 'partial depth'}
                        </Tag>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <Empty text="no quotable routes right now" />
            )
          ) : (
            <Empty text="click “Quote all routes” to walk every candidate path's live book" />
          )}
          {routes && routes.length > 1 && (
            <p className="note" style={{ marginTop: 8 }}>
              Why the best route wins: lower compounded slippage on deeper legs outweighs the
              extra {routes[1].totalFeeBps - routes[0].totalFeeBps >= 0 ? 'hop fee' : 'fee saving'}.
              Both legs are walked level-by-level, so the comparison is exact at quote time.
            </p>
          )}
        </Panel>

        <Panel
          title="Per-trade cost decomposition (live tape)"
          sub="effective = realized + impact, per trade vs ±90s local mid; score normalizes by the pool's own quoted spread"
        >
          {tcaSeries && (
            <>
              <TcaTimeSeries points={tcaSeries} />
              <p className="note" style={{ margin: '4px 0 8px' }}>
                <span style={{ color: 'var(--accent)' }}>■</span> effective spread ·{' '}
                <span style={{ color: 'var(--accent2)' }}>■</span> price impact (5-trade horizon) — both in bps, oldest to newest
              </p>
            </>
          )}
          {tca && shape ? (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Side</th>
                  <th className="num">Price</th>
                  <th className="num">Eff. spread (bps)</th>
                  <th className="num">Impact (bps)</th>
                  <th className="num">Realized (bps)</th>
                  <th>Score</th>
                </tr>
              </thead>
              <tbody>
                {tca.rows.slice(0, 12).map(({ trade: t, effectiveBps, impactBps, realizedBps }) => (
                  <tr key={t.trade_id}>
                    <td>{clock(t.timestamp)}</td>
                    <td>
                      <Tag tone={t.type === 'buy' ? 'live' : 'warn'}>{t.type}</Tag>
                    </td>
                    <td className={`num ${t.type === 'buy' ? 'tone-up' : 'tone-down'}`}>
                      {fmtPrice(t.price)}
                    </td>
                    <td className="num">{effectiveBps.toFixed(2)}</td>
                    <td className="num">{impactBps.toFixed(2)}</td>
                    <td className={`num ${realizedBps >= 0 ? 'tone-up' : 'tone-down'}`}>
                      {realizedBps.toFixed(2)}
                    </td>
                    <td style={{ width: 100 }}>
                      <ScoreBar score={tcaScore(effectiveBps, shape.quotedSpreadBps)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty text="need ≥10 trades in the window — pick a more active pool" />
          )}
        </Panel>

        <Panel
          title="Order activity stream"
          sub={`Place:cancel ${placed}:${canceled} — quoting intensity feeds the liquidity reputation system`}
        >
          {orderUpdates.data?.length ? (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Manager</th>
                  <th>Status</th>
                  <th className="num">Price</th>
                  <th className="num">Qty</th>
                  <th className="num">Filled</th>
                </tr>
              </thead>
              <tbody>
                {orderUpdates.data.slice(0, 12).map((o) => (
                  <tr key={`${o.order_id}-${o.timestamp}-${o.status}`}>
                    <td>{clock(o.timestamp)}</td>
                    <td title={o.balance_manager_id}>{shortAddr(o.balance_manager_id)}</td>
                    <td className={o.status === 'Placed' ? 'tone-up' : 'tone-down'}>{o.status}</td>
                    <td className="num">{fmt(o.price, 4)}</td>
                    <td className="num">{fmt(o.original_quantity)}</td>
                    <td className="num">{fmt(o.filled_quantity)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty text="no recent order updates" />
          )}
        </Panel>
      </div>

      <div className="banner">
        <b>Method notes:</b> mid at trade time is the median tape price within ±90s (the on-chain
        tape has no historical book snapshots; this is the standard local-reference fallback).
        Impact uses a 5-trade horizon. Kyle's λ is the slope of Δp on signed normalized volume —
        the R² shown tells you how much to trust it. All formulas are documented in the product
        spec's methodology appendix.
      </div>
    </div>
  )
}
