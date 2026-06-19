import { useMemo, useState } from 'react'
import { usePoll } from '../lib/hooks'
import { indexer, mid, spreadBps } from '../lib/indexer'
import { useSession } from '../lib/session'
import { fmt, fmtPrice, clock } from '../lib/format'
import { Panel, Stat, Tag, LiveBadge, Empty } from '../components/ui'
import { Candles, DepthRows } from '../components/charts'
import { buildIntentPlan, type IntentKind } from '../lib/strategy'
import { walkBook } from '../lib/microstructure'
import { describeLadder } from '../lib/deepbook'

/**
 * Layer 1 — Smart Execution Terminal.
 * Users express intents ("accumulate", "exit gradually", "buy breakout") and
 * the engine decomposes them into DeepBook limit-order ladders, rendered as
 * the exact SDK calls that scripts/trade.ts executes on testnet.
 */
export function Terminal() {
  const { pool, setPool } = useSession()
  const pools = usePoll(() => indexer.pools(), 60_000)
  const ob = usePoll(() => indexer.orderbook(pool, 24), 2_500, [pool])
  const trades = usePoll(() => indexer.trades(pool, 30), 4_000, [pool])
  const candles = usePoll(() => indexer.ohlcv(pool, '1h', 72), 30_000, [pool])

  const [mode, setMode] = useState<'intent' | 'manual'>('intent')
  const [intent, setIntent] = useState<IntentKind>('accumulate')
  const [qty, setQty] = useState(100)
  const [rungs, setRungs] = useState(5)
  const [widthPct, setWidthPct] = useState(1.5)
  const [skew, setSkew] = useState(0.5)
  const [manualPrice, setManualPrice] = useState('')
  const [manualQty, setManualQty] = useState('')
  const [manualSide, setManualSide] = useState<'buy' | 'sell'>('buy')
  const [staged, setStaged] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const m = mid(ob.data)
  const plan = useMemo(
    () =>
      m > 0
        ? buildIntentPlan({ kind: intent, midPrice: m, totalQuantity: qty, rungs, widthPct, skew })
        : null,
    [intent, m, qty, rungs, widthPct, skew],
  )

  const stageIntent = () => {
    if (!plan) return
    const actions = describeLadder(pool, plan.rungs)
    setStaged(
      JSON.stringify(
        { network: 'testnet', atomic: true, pool, strategy: plan.label, actions },
        null,
        2,
      ),
    )
  }

  const manualPriceNum = parseFloat(manualPrice)
  const manualQtyNum = parseFloat(manualQty)
  const manualValid = manualPriceNum > 0 && manualQtyNum > 0 && !!pool

  const stageManual = () => {
    const p = manualPriceNum
    const q = manualQtyNum
    if (!manualValid) return
    setStaged(
      JSON.stringify(
        {
          network: 'testnet',
          pool,
          actions: describeLadder(pool, [
            { price: p, quantity: q, side: manualSide, kind: 'limit', note: 'manual order' },
          ]),
        },
        null,
        2,
      ),
    )
  }

  const poolNames = (pools.data ?? []).map((p) => p.pool_name).sort()

  return (
    <div>
      <div className="screen-head">
        <h2>Smart Execution Terminal</h2>
        <p>Intent in, order-book actions out — every rung is a real DeepBook limit order</p>
        <LiveBadge ok={!ob.error && !!ob.data} />
      </div>

      <div className="form-row" style={{ marginTop: 12 }}>
        <label className="fld">
          pool
          <select value={pool} onChange={(e) => setPool(e.target.value)}>
            {(poolNames.length ? poolNames : [pool]).map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </label>
        <Stat label="Mid" value={fmtPrice(m)} />
        <Stat label="Spread" value={`${spreadBps(ob.data).toFixed(1)} bps`} />
        <Stat
          label="Last trade"
          value={
            trades.data?.[0] ? (
              <span className={trades.data[0].type === 'buy' ? 'tone-up' : 'tone-down'}>
                {fmtPrice(trades.data[0].price)}
              </span>
            ) : (
              '—'
            )
          }
        />
      </div>

      <div className="screen-grid cols-23">
        <Panel title={`${pool} · 1h candles`} sub="Live OHLCV from the indexer">
          {candles.data ? <Candles candles={candles.data.candles} /> : <Empty text="loading…" />}
        </Panel>

        <Panel
          title="Order entry"
          sub="Intent mode decomposes a goal into a ladder; manual mode is a single order"
          right={<Tag tone="info">BalanceManager: MANAGER_1</Tag>}
        >
          <div className="seg" style={{ marginBottom: 10 }}>
            <button className={mode === 'intent' ? 'on' : ''} onClick={() => setMode('intent')}>
              Intent
            </button>
            <button className={mode === 'manual' ? 'on' : ''} onClick={() => setMode('manual')}>
              Manual
            </button>
          </div>

          {mode === 'intent' ? (
            <>
              <div className="pill-row">
                {(
                  [
                    ['accumulate', 'Accumulate'],
                    ['exit', 'Exit gradually'],
                    ['breakout', 'Buy breakout'],
                    ['mean-revert', 'Mean revert'],
                  ] as [IntentKind, string][]
                ).map(([k, label]) => (
                  <button
                    key={k}
                    className={`pill ${intent === k ? 'on' : ''}`}
                    onClick={() => setIntent(k)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="form-row">
                <label className="fld">
                  total qty (base)
                  <input
                    type="number"
                    value={qty}
                    onChange={(e) => setQty(parseFloat(e.target.value) || 0)}
                  />
                </label>
                <label className="fld">
                  rungs
                  <input
                    type="number"
                    min={1}
                    max={20}
                    value={rungs}
                    onChange={(e) => setRungs(parseInt(e.target.value) || 1)}
                  />
                </label>
              </div>
              <div className="form-row">
                <label className="fld">
                  ladder width %
                  <input
                    type="number"
                    step="0.1"
                    value={widthPct}
                    onChange={(e) => setWidthPct(parseFloat(e.target.value) || 0.1)}
                  />
                </label>
                <label className="fld">
                  size skew (0–1)
                  <input
                    type="number"
                    step="0.1"
                    min={0}
                    max={1}
                    value={skew}
                    onChange={(e) => setSkew(parseFloat(e.target.value) || 0)}
                  />
                </label>
              </div>
              {plan && (
                <>
                  <p className="note">{plan.description}</p>
                  <div className="kv">
                    <dt>est. avg price</dt>
                    <dd>{fmtPrice(plan.avgPrice)}</dd>
                    <dt>notional</dt>
                    <dd>{fmt(plan.notional)} quote</dd>
                    {(() => {
                      // Exact alternative: cross the spread now (walk the live book)
                      const mkt = ob.data ? walkBook(ob.data, plan.side, qty) : null
                      if (!mkt) return null
                      const saveBps =
                        plan.side === 'buy'
                          ? ((mkt.avgPrice - plan.avgPrice) / m) * 10_000
                          : ((plan.avgPrice - mkt.avgPrice) / m) * 10_000
                      return (
                        <>
                          <dt>market order now (walked book)</dt>
                          <dd>
                            {fmtPrice(mkt.avgPrice)} · {mkt.slippageBps.toFixed(1)} bps slip
                            {mkt.unfilledQty > 0 && ' · exceeds visible depth'}
                          </dd>
                          <dt>ladder edge if filled</dt>
                          <dd className={saveBps >= 0 ? 'tone-up' : 'tone-down'}>
                            {saveBps >= 0 ? '+' : ''}
                            {saveBps.toFixed(1)} bps vs crossing now
                          </dd>
                        </>
                      )
                    })()}
                  </div>
                  <div style={{ marginTop: 10 }}>
                    <button
                      className={`btn ${plan.side === 'buy' ? 'buy' : 'sell'}`}
                      onClick={stageIntent}
                    >
                      Stage {plan.rungs.length} orders (atomic PTB)
                    </button>
                  </div>
                </>
              )}
            </>
          ) : (
            <>
              <div className="seg" style={{ marginBottom: 10 }}>
                <button
                  className={manualSide === 'buy' ? 'on' : ''}
                  onClick={() => setManualSide('buy')}
                >
                  Buy
                </button>
                <button
                  className={manualSide === 'sell' ? 'on' : ''}
                  onClick={() => setManualSide('sell')}
                >
                  Sell
                </button>
              </div>
              <div className="form-row">
                <label className="fld">
                  price
                  <input
                    value={manualPrice}
                    placeholder={fmtPrice(m)}
                    onChange={(e) => setManualPrice(e.target.value)}
                  />
                </label>
                <label className="fld">
                  quantity
                  <input
                    value={manualQty}
                    placeholder="100"
                    onChange={(e) => setManualQty(e.target.value)}
                  />
                </label>
              </div>
              {(manualPrice !== '' || manualQty !== '') && !manualValid && (
                <p className="note" style={{ color: 'var(--down)', marginBottom: 8 }}>
                  price and quantity must both be greater than 0
                </p>
              )}
              <button
                className={`btn ${manualSide === 'buy' ? 'buy' : 'sell'}`}
                onClick={stageManual}
                disabled={!manualValid}
              >
                Stage limit {manualSide}
              </button>
            </>
          )}
        </Panel>

        <Panel title="Order book" sub="Level-2 depth, polled every 2.5s">
          {ob.data ? <DepthRows ob={ob.data} rows={10} /> : <Empty text="loading book…" />}
        </Panel>

        <Panel title="Recent trades" sub="Taker direction, live from chain events">
          {trades.data?.length ? (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Time</th>
                  <th className="num">Price</th>
                  <th className="num">Size</th>
                  <th>Side</th>
                </tr>
              </thead>
              <tbody>
                {trades.data.slice(0, 12).map((t) => (
                  <tr key={t.trade_id}>
                    <td>{clock(t.timestamp)}</td>
                    <td className={`num ${t.type === 'buy' ? 'tone-up' : 'tone-down'}`}>
                      {fmtPrice(t.price)}
                    </td>
                    <td className="num">{fmt(t.base_volume)}</td>
                    <td>
                      <Tag tone={t.type === 'buy' ? 'live' : 'warn'}>{t.type}</Tag>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty text="no recent trades in this pool" />
          )}
        </Panel>

        {plan && !staged && (
          <Panel
            className="span-all"
            title="Ladder preview"
            sub="Each rung becomes one place_limit_order call inside a single programmable transaction block. Highlighted rung is closest to the live mid."
          >
            <table className="tbl">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Side</th>
                  <th>Type</th>
                  <th className="num">Price</th>
                  <th className="num">Quantity</th>
                  <th className="num">Δ from mid</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const cheapestIdx = plan.rungs.reduce(
                    (best, r, i, arr) =>
                      Math.abs(r.price - m) < Math.abs(arr[best].price - m) ? i : best,
                    0,
                  )
                  return plan.rungs.map((r, i) => (
                    <tr key={i} className={i === cheapestIdx ? 'highlight' : ''}>
                      <td>{i + 1}</td>
                      <td className={r.side === 'buy' ? 'tone-up' : 'tone-down'}>{r.side}</td>
                      <td>{r.kind}</td>
                      <td className="num">{fmtPrice(r.price)}</td>
                      <td className="num">{fmt(r.quantity)}</td>
                      <td className="num">{(((r.price - m) / m) * 100).toFixed(2)}%</td>
                      <td style={{ color: 'var(--muted)' }}>
                        {r.note}
                        {i === cheapestIdx && (
                          <>
                            {' '}
                            <Tag tone="info">closest to mid</Tag>
                          </>
                        )}
                      </td>
                    </tr>
                  ))
                })()}
              </tbody>
            </table>
          </Panel>
        )}

        {staged && (
          <Panel
            className="span-all"
            title="Staged execution plan"
            sub="This is the payload scripts/trade.ts signs and submits via @mysten/deepbook-v3. In the hosted build, a connected wallet signs it instead."
            right={
              <>
                <button
                  className="btn ghost"
                  onClick={() => {
                    navigator.clipboard.writeText(staged)
                    setCopied(true)
                    setTimeout(() => setCopied(false), 1500)
                  }}
                >
                  {copied ? 'copied!' : 'copy'}
                </button>
                <button className="btn ghost" onClick={() => setStaged(null)}>
                  clear
                </button>
              </>
            }
          >
            <pre className="code">{staged}</pre>
          </Panel>
        )}
      </div>
    </div>
  )
}
