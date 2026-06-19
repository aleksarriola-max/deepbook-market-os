import { useMemo, useState } from 'react'
import { usePoll, useLoad } from '../lib/hooks'
import { listItems, addItem, removeItem, type SavedItem } from '../lib/cloudState'
import { indexer, mid, spreadBps } from '../lib/indexer'
import { buildTouchModel, backtestLadder, expectedFillStats, type LadderBacktest } from '../lib/microstructure'
import { useSession } from '../lib/session'
import { fmt, fmtPrice } from '../lib/format'
import { Panel, Stat, Tag, Empty } from '../components/ui'
import { buildIntentPlan, type IntentKind, type IntentPlan } from '../lib/strategy'

interface TemplateData {
  pool: string
  plan: IntentPlan
}

interface SweepRow {
  rungs: number
  widthPct: number
  skew: number
  bt: LadderBacktest
  score: number
}

// Grid for the ladder-shape sweep: every combination is backtested against
// this pool's own OHLC history with the current intent kind/horizon.
const SWEEP_RUNGS = [4, 6, 8, 12]
const SWEEP_WIDTH_PCT = [1, 2, 3, 5]
const SWEEP_SKEW = [0, 0.4, 0.8]

/**
 * Layer 1 — Strategy Builder.
 * Compose multi-leg ladder strategies against the live mid. Fill estimates use
 * the empirical touch model (forward OHLC excursions); the backtest replays
 * the exact ladder shape over this pool's own history vs a market-order
 * benchmark, with the same touch criterion for consistency.
 */
export function StrategyBuilder() {
  const { pool, address } = useSession()
  const ob = usePoll(() => indexer.orderbook(pool, 4), 4_000, [pool])
  const candles = usePoll(() => indexer.ohlcv(pool, '1h', 400), 60_000, [pool])
  const m = mid(ob.data)

  const [horizonH, setHorizonH] = useState(24)
  const [kind, setKind] = useState<IntentKind>('accumulate')
  const [qty, setQty] = useState(500)
  const [rungs, setRungs] = useState(8)
  const [widthPct, setWidthPct] = useState(3)
  const [skew, setSkew] = useState(0.8)
  const [localSaved, setLocalSaved] = useState<SavedItem<TemplateData>[]>([])
  const [refreshKey, setRefreshKey] = useState(0)
  const [writeError, setWriteError] = useState<string | null>(null)
  const cloudSaved = useLoad(
    () => (address ? listItems<TemplateData>(address, 'template') : Promise.resolve(null)),
    [address, refreshKey],
  )
  // Cloud sync is opt-in: no address set => behave exactly like before (local only).
  const saved = address ? (cloudSaved.data ?? []) : localSaved

  const plan = useMemo(
    () =>
      m > 0
        ? buildIntentPlan({ kind, midPrice: m, totalQuantity: qty, rungs, widthPct, skew })
        : null,
    [kind, m, qty, rungs, widthPct, skew],
  )

  // Empirical fill model: P(touch within horizon) from the distribution of
  // forward OHLC excursions in this pool's own history (no assumptions).
  const touchModel = useMemo(
    () => (candles.data ? buildTouchModel(candles.data.candles, horizonH) : null),
    [candles.data, horizonH],
  )

  const fillSim = useMemo(() => {
    if (!plan || m <= 0 || !touchModel) return null
    return expectedFillStats(plan.rungs, touchModel, m, qty)
  }, [plan, m, qty, touchModel])

  // Backtest the exact ladder shape over this pool's history, vs the benchmark
  // of crossing the spread immediately (half quoted spread + 10bps taker fee).
  const backtest = useMemo(() => {
    if (!plan || m <= 0 || !candles.data) return null
    if (new Set(plan.rungs.map((r) => r.side)).size > 1) return null // mixed-side grid
    const total = plan.rungs.reduce((a, r) => a + r.quantity, 0)
    if (total <= 0) return null
    return backtestLadder(
      candles.data.candles,
      plan.rungs.map((r) => (Math.abs(r.price - m) / m) * 100),
      plan.rungs.map((r) => r.quantity / total),
      plan.side,
      kind === 'breakout',
      horizonH,
      spreadBps(ob.data) / 2 + 10,
    )
  }, [plan, m, candles.data, horizonH, kind, ob.data])

  // Parameter sweep: backtest every (rungs, width%, skew) combination on this
  // pool's own history and rank by expected edge = avg fill rate * avg entry
  // improvement (bps). Mean-reversion grids carry inventory across windows so
  // the single-side backtest (and therefore the sweep) doesn't apply to them.
  const [sweep, setSweep] = useState<SweepRow[] | null>(null)
  const [sweeping, setSweeping] = useState(false)

  const runSweep = () => {
    if (!candles.data || m <= 0 || kind === 'mean-revert') return
    setSweeping(true)
    const benchBps = spreadBps(ob.data) / 2 + 10
    const out: SweepRow[] = []
    for (const r of SWEEP_RUNGS) {
      for (const w of SWEEP_WIDTH_PCT) {
        for (const sk of SWEEP_SKEW) {
          const p = buildIntentPlan({ kind, midPrice: m, totalQuantity: qty, rungs: r, widthPct: w, skew: sk })
          const total = p.rungs.reduce((a, x) => a + x.quantity, 0)
          if (total <= 0) continue
          const bt = backtestLadder(
            candles.data.candles,
            p.rungs.map((x) => (Math.abs(x.price - m) / m) * 100),
            p.rungs.map((x) => x.quantity / total),
            p.side,
            kind === 'breakout',
            horizonH,
            benchBps,
          )
          if (!bt) continue
          out.push({ rungs: r, widthPct: w, skew: sk, bt, score: bt.fillRateAvg * bt.improvementBpsAvg })
        }
      }
    }
    out.sort((a, b) => b.score - a.score)
    setSweep(out.slice(0, 8))
    setSweeping(false)
  }

  return (
    <div>
      <div className="screen-head">
        <h2>Strategy Builder</h2>
        <p>Ladder strategy engine on DeepBook limit-order primitives — {pool}</p>
      </div>

      <div className="stat-row">
        <Stat label="Live mid" value={fmtPrice(m)} />
        <Stat label="Strategy" value={plan?.label ?? '—'} />
        <Stat
          label={`E[fill rate] in ${horizonH}h`}
          value={fillSim ? `${(fillSim.fillRate * 100).toFixed(0)}%` : '—'}
          hint={
            fillSim
              ? `empirical touch probabilities from ${fillSim.samples} rolling ${horizonH}h windows of this pool's own OHLC history`
              : 'needs candle history'
          }
        />
        <Stat label="E[avg fill price]" value={fmtPrice(fillSim?.avgFillPrice ?? null)} />
      </div>

      <div className="screen-grid cols-32">
        <Panel title="Parameters" sub="Tune the ladder; preview updates against the live book">
          <div className="pill-row">
            {(
              [
                ['accumulate', 'Accumulation'],
                ['exit', 'Exit / TP grid'],
                ['breakout', 'Breakout entry'],
                ['mean-revert', 'Reversion grid'],
              ] as [IntentKind, string][]
            ).map(([k, label]) => (
              <button key={k} className={`pill ${kind === k ? 'on' : ''}`} onClick={() => setKind(k)}>
                {label}
              </button>
            ))}
          </div>
          <div className="form-row">
            <label className="fld">
              total quantity
              <input type="number" value={qty} onChange={(e) => setQty(+e.target.value || 0)} />
            </label>
            <label className="fld">
              rungs
              <input
                type="number"
                min={1}
                max={20}
                value={rungs}
                onChange={(e) => setRungs(+e.target.value || 1)}
              />
            </label>
          </div>
          <div className="form-row">
            <label className="fld">
              width % of mid
              <input
                type="number"
                step="0.5"
                value={widthPct}
                onChange={(e) => setWidthPct(+e.target.value || 0.5)}
              />
            </label>
            <label className="fld">
              size skew
              <input
                type="number"
                step="0.1"
                min={0}
                max={1}
                value={skew}
                onChange={(e) => setSkew(+e.target.value || 0)}
              />
            </label>
            <label className="fld">
              fill horizon
              <div className="pill-row" style={{ margin: '4px 0 0' }}>
                {[4, 8, 24, 48].map((h) => (
                  <button
                    key={h}
                    className={`pill ${horizonH === h ? 'on' : ''}`}
                    onClick={() => setHorizonH(h)}
                  >
                    {h}h
                  </button>
                ))}
              </div>
            </label>
          </div>
          {plan && (
            <button
              className="btn"
              onClick={async () => {
                if (address) {
                  try {
                    await addItem<TemplateData>(address, 'template', { pool, plan })
                    setWriteError(null)
                    setRefreshKey((k) => k + 1)
                  } catch (e) {
                    setWriteError(e instanceof Error ? e.message : String(e))
                  }
                } else {
                  setLocalSaved((s) => [{ id: Date.now(), data: { pool, plan }, createdAt: Date.now() }, ...s])
                }
              }}
            >
              Save as template
            </button>
          )}
          <p className="note" style={{ marginTop: 10 }}>
            Fill probabilities are the empirical CDF of forward price excursions: for each
            rolling {horizonH}h window of this pool's hourly OHLC history, did the extreme
            excursion reach the rung's distance from its window open? No distributional
            assumption — the pool's own behavior is the model.
          </p>
        </Panel>

        <Panel
          title="Ladder visualization"
          sub="Bid rungs below mid in green, ask rungs above in red; opacity = P(touch), bar length = rung size"
        >
          {plan && m > 0 ? (
            <LadderViz plan={plan} mid={m} probs={fillSim?.probs} />
          ) : (
            <Empty text="waiting for live mid…" />
          )}
          {plan && m > 0 && fillSim && (
            <table className="tbl" style={{ marginTop: 10 }}>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Side</th>
                  <th className="num">Rung price</th>
                  <th className="num">Dist. from mid</th>
                  <th className="num">{`P(touch in ${horizonH}h)`}</th>
                  <th className="num">Expected fill</th>
                </tr>
              </thead>
              <tbody>
                {plan.rungs.map((r, i) => {
                  const p = fillSim.probs[i] ?? 0
                  return (
                    <tr key={i}>
                      <td>{i + 1}</td>
                      <td className={r.side === 'buy' ? 'tone-up' : 'tone-down'}>{r.side}</td>
                      <td className="num">{fmtPrice(r.price)}</td>
                      <td className="num">{fillSim.distPcts[i].toFixed(2)}%</td>
                      <td className="num">{(p * 100).toFixed(0)}%</td>
                      <td className="num">{fmt(r.quantity * p)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel
          className="span-all"
          title="Backtest vs crossing the spread (this pool's own history)"
          sub={`Each rolling ${horizonH}h window: would this exact ladder have filled, and at what average entry vs an immediate market order (half-spread + 10bps taker fee) at window open?`}
        >
          {backtest ? (
            <>
              <div className="stat-row" style={{ marginTop: 0 }}>
                <Stat label="Windows tested" value={backtest.windows} />
                <Stat label="P(any fill)" value={`${(backtest.anyFillRate * 100).toFixed(0)}%`} />
                <Stat
                  label="Avg fill rate"
                  value={`${(backtest.fillRateAvg * 100).toFixed(0)}%`}
                />
                <Stat
                  label="Entry improvement (avg | median)"
                  value={`${backtest.improvementBpsAvg.toFixed(1)} | ${backtest.improvementBpsMedian.toFixed(1)} bps`}
                  tone={backtest.improvementBpsAvg > 0 ? 'up' : 'down'}
                  hint="conditional on ≥1 rung filling; positive = ladder entered better than a market order"
                />
                <Stat
                  label="p10 … p90"
                  value={`${backtest.improvementBpsP10.toFixed(1)} … ${backtest.improvementBpsP90.toFixed(1)} bps`}
                />
                <Stat
                  label="Win rate vs market order"
                  value={`${(backtest.winRate * 100).toFixed(0)}%`}
                  tone={backtest.winRate >= 0.5 ? 'up' : 'down'}
                />
              </div>
              <p className="note" style={{ marginTop: 8 }}>
                Honest caveats: windows step by {Math.max(1, Math.floor(horizonH / 4))}h so they
                overlap (samples are correlated); fills use the touch criterion (extreme excursion
                reaches the rung), which ignores queue position; and the improvement is
                conditional on filling — the {((1 - backtest.anyFillRate) * 100).toFixed(0)}% of
                windows with no fill carry opportunity cost if price runs away. The same
                trade-off the forward fill model shows, measured instead of assumed.
              </p>
            </>
          ) : (
            <Empty text="backtest needs a single-side ladder and candle history (mean-reversion grids carry inventory across windows, so this benchmark would mislead)" />
          )}
        </Panel>

        <Panel
          className="span-all"
          title="Ladder sweep"
          sub={`Backtests every combination of rungs × width% × skew (${SWEEP_RUNGS.length}×${SWEEP_WIDTH_PCT.length}×${SWEEP_SKEW.length} = ${SWEEP_RUNGS.length * SWEEP_WIDTH_PCT.length * SWEEP_SKEW.length} shapes) over this pool's own history, ranked by expected edge`}
        >
          {kind === 'mean-revert' ? (
            <Empty text="sweep needs a single-side ladder — mean-reversion grids carry inventory across windows, so the backtest doesn't apply" />
          ) : (
            <>
              <button className="btn" onClick={runSweep} disabled={sweeping || !candles.data || m <= 0}>
                {sweeping ? 'sweeping…' : 'Run sweep'}
              </button>
              {sweep && (
                sweep.length ? (
                  <>
                    <table className="tbl" style={{ marginTop: 10 }}>
                      <thead>
                        <tr>
                          <th className="num">Rungs</th>
                          <th className="num">Width %</th>
                          <th className="num">Skew</th>
                          <th className="num">P(any fill)</th>
                          <th className="num">Avg fill rate</th>
                          <th className="num">Improvement (avg)</th>
                          <th className="num">Win rate</th>
                          <th className="num">Score</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {sweep.map((s, i) => {
                          const isCurrent = s.rungs === rungs && s.widthPct === widthPct && s.skew === skew
                          return (
                            <tr key={`${s.rungs}-${s.widthPct}-${s.skew}`} className={i === 0 ? 'highlight' : ''}>
                              <td className="num">{s.rungs}</td>
                              <td className="num">{s.widthPct}</td>
                              <td className="num">{s.skew}</td>
                              <td className="num">{(s.bt.anyFillRate * 100).toFixed(0)}%</td>
                              <td className="num">{(s.bt.fillRateAvg * 100).toFixed(0)}%</td>
                              <td className={`num tone-${s.bt.improvementBpsAvg > 0 ? 'up' : 'down'}`}>
                                {s.bt.improvementBpsAvg.toFixed(1)} bps
                              </td>
                              <td className="num">{(s.bt.winRate * 100).toFixed(0)}%</td>
                              <td className="num">{s.score.toFixed(2)}</td>
                              <td>
                                {i === 0 && <Tag tone="live">best</Tag>}
                                {isCurrent ? (
                                  <Tag tone="info">current</Tag>
                                ) : (
                                  <button
                                    className="btn ghost"
                                    onClick={() => {
                                      setRungs(s.rungs)
                                      setWidthPct(s.widthPct)
                                      setSkew(s.skew)
                                    }}
                                  >
                                    apply
                                  </button>
                                )}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                    <p className="note" style={{ marginTop: 8 }}>
                      Score = avg fill rate × avg entry improvement (bps) — an expected-value proxy
                      that rewards shapes which both fill often and fill at a meaningfully better
                      price than crossing the spread. Same honest caveats as the single backtest
                      above apply to every row: overlapping windows, touch-based fills, and
                      improvement conditional on filling.
                    </p>
                  </>
                ) : (
                  <Empty text="no ladder shape in the sweep grid produced a valid backtest for this pool/horizon" />
                )
              )}
            </>
          )}
        </Panel>

        <Panel
          className="span-all"
          title="Saved strategy templates"
          sub={
            address
              ? "Synced to this wallet address — reusable across pools, devices, and the desk's delegated accounts"
              : "Templates are reusable across pools and deployable through the desk's delegated accounts (enter a wallet address in the sidebar to sync these across devices)"
          }
        >
          {address && cloudSaved.error && !cloudSaved.data?.length ? (
            <Empty text={`couldn't reach saved data: ${cloudSaved.error}`} />
          ) : saved.length === 0 ? (
            <Empty text="no templates yet — tune a ladder and save it" />
          ) : (
            <>
              {writeError && (
                <p className="note" style={{ color: 'var(--down)' }}>{writeError}</p>
              )}
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Created</th>
                    <th>Pool</th>
                    <th>Strategy</th>
                    <th className="num">Rungs</th>
                    <th className="num">Quantity</th>
                    <th className="num">Avg price</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {saved.map((s) => (
                    <tr key={s.id}>
                      <td>{new Date(s.createdAt).toLocaleTimeString()}</td>
                      <td>{s.data.pool}</td>
                      <td>{s.data.plan.label}</td>
                      <td className="num">{s.data.plan.rungs.length}</td>
                      <td className="num">{fmt(s.data.plan.rungs.reduce((a, r) => a + r.quantity, 0))}</td>
                      <td className="num">{fmtPrice(s.data.plan.avgPrice)}</td>
                      <td>
                        <button
                          className="btn ghost"
                          onClick={async () => {
                            if (address) {
                              try {
                                await removeItem(s.id)
                                setWriteError(null)
                                setRefreshKey((k) => k + 1)
                              } catch (e) {
                                setWriteError(e instanceof Error ? e.message : String(e))
                              }
                            } else {
                              setLocalSaved((ls) => ls.filter((x) => x.id !== s.id))
                            }
                          }}
                        >
                          remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </Panel>
      </div>
    </div>
  )
}

function LadderViz({
  plan,
  mid: m,
  probs,
}: {
  plan: IntentPlan
  mid: number
  probs?: number[]
}) {
  const maxQ = Math.max(...plan.rungs.map((r) => r.quantity))
  const indexed = plan.rungs.map((r, i) => ({ r, p: probs?.[i] }))
  const sorted = indexed.sort((a, b) => b.r.price - a.r.price)
  return (
    <div>
      {sorted.map(({ r, p }, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '2.5px 0' }}>
          <span
            style={{
              width: 90,
              textAlign: 'right',
              fontVariantNumeric: 'tabular-nums',
              color: r.side === 'buy' ? 'var(--up)' : 'var(--down)',
              fontSize: 12,
            }}
          >
            {fmtPrice(r.price)}
          </span>
          <div
            style={{
              height: 13,
              width: `${(r.quantity / maxQ) * 55}%`,
              background: r.side === 'buy' ? 'var(--up)' : 'var(--down)',
              opacity: 0.25 + (p ?? 0.5) * 0.6,
              borderRadius: 3,
            }}
            title={p != null ? `P(touch) = ${(p * 100).toFixed(0)}%` : undefined}
          />
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>
            {fmt(r.quantity)} · {r.note}
            {p != null && ` · P(touch) ${(p * 100).toFixed(0)}%`}
          </span>
        </div>
      ))}
      <div style={{ borderTop: '1px dashed var(--accent)', marginTop: 6, paddingTop: 4 }}>
        <span style={{ fontSize: 11, color: 'var(--accent)' }}>mid {fmtPrice(m)}</span>
      </div>
    </div>
  )
}
