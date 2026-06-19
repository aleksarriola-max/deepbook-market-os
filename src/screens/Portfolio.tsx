import { useMemo, useState } from 'react'
import { useLoad, usePoll } from '../lib/hooks'
import { indexer, mid } from '../lib/indexer'
import { exploreRoutes, type RouteQuote } from '../lib/microstructure'
import { buildIntentPlan } from '../lib/strategy'
import { describeLadder, BM_KEY } from '../lib/deepbook'
import { fmt, fmtUsd, fmtPrice, shortAddr } from '../lib/format'
import { Panel, Stat, Tag, Empty, LiveBadge } from '../components/ui'

// DeepBook Margin's risk_ratio = collateral value / debt value: it falls as
// leverage/losses grow and a position is liquidated once it drops below the
// pool's liquidation threshold. So LOWER is riskier — the opposite of how
// the name reads.
function riskTone(ratio: number): 'up' | 'warn' | 'down' {
  if (ratio >= 2) return 'up'
  if (ratio >= 1.5) return 'warn'
  return 'down'
}

function assetSymbol(asset: string): string {
  return asset.includes('::') ? (asset.split('::').pop() as string) : asset
}

/**
 * Layer 4/5 — Portfolio Command Center.
 * Live: the indexer /portfolio endpoint returns real margin positions,
 * collateral and LP supply for any wallet. On top sits the portfolio intent
 * engine — objectives decomposed into coordinated Spot/Margin/Predict actions,
 * staged as PTB previews against this wallet's actual positions.
 */
export function Portfolio() {
  const [wallet, setWallet] = useState('')
  const [queried, setQueried] = useState('')
  const pf = useLoad(async () => (queried ? indexer.portfolio(queried) : null), [queried])
  const pools = usePoll(() => indexer.pools(), 120_000)

  // ------------------------- Risk stress test -------------------------------
  const [shockPct, setShockPct] = useState(0)
  const stressPrices = useLoad(async () => {
    const positions = pf.data?.margin_positions ?? []
    const uniquePools = [...new Set(positions.map((p) => p.pool))]
    const out: Record<string, number> = {}
    await Promise.all(
      uniquePools.map(async (pl) => {
        try {
          out[pl] = mid(await indexer.orderbook(pl, 4))
        } catch {
          out[pl] = 0
        }
      }),
    )
    return out
  }, [pf.data])

  // risk_ratio = (base_asset*P + quote_asset) / (base_debt*P + quote_debt) at
  // pool price P — exact from this position's own balances, independent of
  // the indexer's USD pricing.
  const riskRatioAt = (p: NonNullable<typeof pf.data>['margin_positions'][number], price: number): number => {
    const debt = p.base_debt * price + p.quote_debt
    return debt > 0 ? (p.base_asset * price + p.quote_asset) / debt : Infinity
  }

  // Solve riskRatioAt(p, price) == target for price (linear in P).
  const breakevenPrice = (
    p: NonNullable<typeof pf.data>['margin_positions'][number],
    target: number,
  ): number | null => {
    const denom = p.base_asset - target * p.base_debt
    if (Math.abs(denom) < 1e-12) return null
    const price = (target * p.quote_debt - p.quote_asset) / denom
    return price > 0 ? price : null
  }

  // ------------------------- Defend my leverage -----------------------------
  const riskiest = useMemo(() => {
    const positions = pf.data?.margin_positions ?? []
    if (!positions.length) return null
    return positions.reduce((a, b) => (a.risk_ratio < b.risk_ratio ? a : b))
  }, [pf.data])

  const defendOb = usePoll(
    () => (riskiest ? indexer.orderbook(riskiest.pool, 4) : Promise.resolve(null)),
    8_000,
    [riskiest?.pool],
  )
  const defendMid = mid(defendOb.data)

  const defendPlan = useMemo(() => {
    if (!riskiest || riskiest.risk_ratio >= 2 || riskiest.base_asset <= 0 || defendMid <= 0)
      return null
    return buildIntentPlan({
      kind: 'exit',
      midPrice: defendMid,
      totalQuantity: riskiest.base_asset * 0.25,
      rungs: 4,
      widthPct: 1.5,
      skew: 0.3,
    })
  }, [riskiest, defendMid])

  const defendStaged = useMemo(
    () => (defendPlan && riskiest ? describeLadder(riskiest.pool, defendPlan.rungs) : null),
    [defendPlan, riskiest],
  )

  // ------------------------- Rotate allocation ------------------------------
  const [fromAsset, setFromAsset] = useState('')
  const [toAsset, setToAsset] = useState('')
  const [rotatePct, setRotatePct] = useState(25)
  const [routes, setRoutes] = useState<RouteQuote[] | null>(null)
  const [routing, setRouting] = useState(false)

  const collateralOptions = (pf.data?.collateral_balances ?? []).map((c) => ({
    symbol: assetSymbol(c.asset),
    balance: c.balance,
    balanceUsd: c.balance_usd,
  }))
  const fromBalance = collateralOptions.find((c) => c.symbol === fromAsset)
  const rotateQty = fromBalance ? fromBalance.balance * (rotatePct / 100) : 0

  const toOptions = useMemo(() => {
    const syms = new Set<string>()
    for (const p of pools.data ?? []) {
      syms.add(p.base_asset_symbol)
      syms.add(p.quote_asset_symbol)
    }
    syms.delete(fromAsset)
    return [...syms].sort()
  }, [pools.data, fromAsset])

  const findRoute = async () => {
    if (!pools.data || !fromAsset || !toAsset || rotateQty <= 0) return
    setRouting(true)
    try {
      setRoutes(await exploreRoutes(pools.data, fromAsset, toAsset, 'sell', rotateQty))
    } finally {
      setRouting(false)
    }
  }

  const rotateStaged = useMemo(() => {
    const best = routes?.[0]
    if (!best) return null
    return best.legs.map((l, i) => ({
      module: 'deepbook::pool',
      call: 'place_market_order',
      args: {
        step: i + 1,
        pool: l.pool,
        balance_manager: BM_KEY,
        is_bid: l.side === 'buy',
        est_avg_price: l.avgPrice,
      },
    }))
  }, [routes])

  return (
    <div>
      <div className="screen-head">
        <h2>Portfolio Command Center</h2>
        <p>Unified equity, debt and exposure across every DeepBook primitive</p>
      </div>

      <div className="screen-grid" style={{ marginTop: 14 }}>
        <Panel
          className="span-all"
          title="Load a live portfolio"
          sub="The indexer /portfolio endpoint aggregates real margin managers, collateral and LP positions for any Sui wallet"
          right={pf.data && <LiveBadge ok={true} />}
        >
          <div className="form-row">
            <label className="fld" style={{ flex: 3 }}>
              wallet address
              <input
                value={wallet}
                placeholder="0x…"
                onChange={(e) => setWallet(e.target.value.trim())}
              />
            </label>
            <button
              className="btn"
              disabled={!wallet.startsWith('0x')}
              onClick={() => setQueried(wallet)}
            >
              Load
            </button>
          </div>

          {queried &&
            (pf.loading ? (
              <Empty text="loading portfolio…" />
            ) : pf.data ? (
              <>
                <div className="stat-row" style={{ marginTop: 4 }}>
                  <Stat label="Total equity" value={fmtUsd(pf.data.summary.total_equity_usd)} tone="up" />
                  <Stat label="Total debt" value={fmtUsd(pf.data.summary.total_debt_usd)} tone="down" />
                  <Stat label="Net value" value={fmtUsd(pf.data.summary.net_value_usd)} />
                  <Stat label="Margin positions" value={pf.data.margin_positions.length} />
                </div>

                {pf.data.margin_positions.length > 0 ? (
                  <table className="tbl" style={{ marginTop: 10 }}>
                    <thead>
                      <tr>
                        <th>Pool</th>
                        <th>Base</th>
                        <th>Quote</th>
                        <th className="num">Base amt</th>
                        <th className="num">Quote amt</th>
                        <th className="num">Base debt</th>
                        <th className="num">Quote debt</th>
                        <th className="num">Net value</th>
                        <th className="num">Total debt</th>
                        <th className="num">Risk ratio</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pf.data.margin_positions.map((p) => (
                        <tr key={p.margin_manager_id}>
                          <td title={p.margin_manager_id}>{p.pool}</td>
                          <td>{p.base_asset_symbol}</td>
                          <td>{p.quote_asset_symbol}</td>
                          <td className="num">{fmt(p.base_asset)}</td>
                          <td className="num">{fmt(p.quote_asset)}</td>
                          <td className="num">{fmt(p.base_debt)}</td>
                          <td className="num">{fmt(p.quote_debt)}</td>
                          <td className="num">{fmtUsd(p.net_value_usd)}</td>
                          <td className="num">{fmtUsd(p.total_debt_usd)}</td>
                          <td className={`num tone-${riskTone(p.risk_ratio)}`}>
                            {p.risk_ratio.toFixed(2)}
                            {p.risk_ratio < 1.25 && (
                              <span
                                className="tag"
                                style={{
                                  marginLeft: 6,
                                  background: 'rgba(248, 81, 73, 0.16)',
                                  color: 'var(--down)',
                                }}
                              >
                                Liquidation risk
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <Empty text="no margin positions for this wallet" />
                )}

                <div className="screen-grid cols-2" style={{ marginTop: 10 }}>
                  <div>
                    <div className="nav-section" style={{ margin: '0 0 6px' }}>
                      Collateral balances
                    </div>
                    {pf.data.collateral_balances.length ? (
                      <table className="tbl">
                        <thead>
                          <tr>
                            <th>Asset</th>
                            <th className="num">Balance</th>
                            <th className="num">Balance (USD)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {pf.data.collateral_balances.map((c) => (
                            <tr key={c.asset}>
                              <td>{assetSymbol(c.asset)}</td>
                              <td className="num">{fmt(c.balance)}</td>
                              <td className="num">{fmtUsd(c.balance_usd)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <Empty text="no collateral deposited" />
                    )}
                  </div>

                  <div>
                    <div className="nav-section" style={{ margin: '0 0 6px' }}>
                      LP / margin-pool supply positions
                    </div>
                    {pf.data.lp_positions.length ? (
                      <table className="tbl">
                        <thead>
                          <tr>
                            <th>Margin pool</th>
                            <th>Asset</th>
                            <th className="num">Supplied</th>
                            <th className="num">Supplied (USD)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {pf.data.lp_positions.map((l) => (
                            <tr key={`${l.margin_pool_id}-${l.asset}`}>
                              <td title={l.margin_pool_id}>{shortAddr(l.margin_pool_id)}</td>
                              <td>{assetSymbol(l.asset)}</td>
                              <td className="num">{fmt(l.supplied)}</td>
                              <td className="num">{fmtUsd(l.supplied_usd)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <Empty text="no margin-pool supply positions" />
                    )}
                  </div>
                </div>
              </>
            ) : (
              <Empty
                text={
                  pf.error
                    ? `no portfolio found / ${pf.error}`
                    : 'no margin activity for this wallet'
                }
                tone={pf.error ? 'error' : undefined}
              />
            ))}
          {!queried && (
            <Empty text="paste a wallet address — margin traders on mainnet will show live positions" />
          )}
        </Panel>

        <Panel
          className="span-all"
          title="Risk stress test"
          sub="Recompute each position's risk ratio under a hypothetical move in its own pool's live price"
        >
          {!pf.data ? (
            <Empty text="load a portfolio to stress-test its margin positions" />
          ) : !pf.data.margin_positions.length ? (
            <Empty text="no margin positions to stress-test" />
          ) : !stressPrices.data ? (
            <Empty text="loading live prices…" />
          ) : (
            <>
              <label className="fld">
                hypothetical price move: {shockPct > 0 ? '+' : ''}
                {shockPct}%
                <input
                  type="range"
                  min={-50}
                  max={50}
                  step={1}
                  value={shockPct}
                  onChange={(e) => setShockPct(+e.target.value)}
                />
              </label>
              <table className="tbl" style={{ marginTop: 10 }}>
                <thead>
                  <tr>
                    <th>Pool</th>
                    <th className="num">Live price</th>
                    <th className="num">Risk ratio (now)</th>
                    <th className="num">
                      Risk ratio ({shockPct > 0 ? '+' : ''}
                      {shockPct}%)
                    </th>
                    <th className="num">Move to liquidation (ratio = 1.0)</th>
                    <th className="num">Move to warning (ratio = 1.25)</th>
                  </tr>
                </thead>
                <tbody>
                  {pf.data.margin_positions.map((p) => {
                    const p0 = stressPrices.data?.[p.pool] ?? 0
                    const ratioNow = riskRatioAt(p, p0)
                    const ratioShock = p0 > 0 ? riskRatioAt(p, p0 * (1 + shockPct / 100)) : null
                    const liqPrice = breakevenPrice(p, 1.0)
                    const warnPrice = breakevenPrice(p, 1.25)
                    const liqMove = liqPrice != null && p0 > 0 ? ((liqPrice - p0) / p0) * 100 : null
                    const warnMove = warnPrice != null && p0 > 0 ? ((warnPrice - p0) / p0) * 100 : null
                    return (
                      <tr key={p.margin_manager_id}>
                        <td title={p.margin_manager_id}>{p.pool}</td>
                        <td className="num">{p0 > 0 ? fmtPrice(p0) : '—'}</td>
                        <td className={`num tone-${Number.isFinite(ratioNow) ? riskTone(ratioNow) : 'up'}`}>
                          {Number.isFinite(ratioNow) ? ratioNow.toFixed(2) : '∞'}
                        </td>
                        <td
                          className={`num ${ratioShock != null ? `tone-${Number.isFinite(ratioShock) ? riskTone(ratioShock) : 'up'}` : ''}`}
                        >
                          {ratioShock == null ? '—' : Number.isFinite(ratioShock) ? ratioShock.toFixed(2) : '∞'}
                        </td>
                        <td className="num">
                          {liqMove != null ? `${liqMove > 0 ? '+' : ''}${liqMove.toFixed(1)}%` : '—'}
                        </td>
                        <td className="num">
                          {warnMove != null ? `${warnMove > 0 ? '+' : ''}${warnMove.toFixed(1)}%` : '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              <p className="note" style={{ marginTop: 8 }}>
                Risk ratio = (base_asset·P + quote_asset) / (base_debt·P + quote_debt) at this
                pool's live mid P — exact from the position's own balances, independent of the
                indexer's USD pricing. "Move to liquidation/warning" solves the same formula for
                the price at which the ratio would cross 1.0 / 1.25, shown as a % move in P from
                here; "—" means that threshold isn't reachable by a price move in either direction
                (the position's exposure happens to be flat in P at that ratio).
              </p>
            </>
          )}
        </Panel>

        <Panel
          title="Defend my leverage"
          sub="Finds this wallet's riskiest margin position and stages a passive exit ladder sized to repay debt and lift its risk ratio"
        >
          {!pf.data ? (
            <Empty text="load a portfolio to scan for at-risk positions" />
          ) : !riskiest ? (
            <Empty text="no margin positions to defend" />
          ) : riskiest.risk_ratio >= 2 ? (
            <Empty
              text={`healthiest action needed: lowest risk ratio is ${riskiest.risk_ratio.toFixed(2)} (${riskiest.pool}) — above the 2.0 comfort line`}
            />
          ) : (
            <>
              <div className="kv">
                <dt>position</dt>
                <dd>
                  {riskiest.pool} · {shortAddr(riskiest.margin_manager_id)}
                </dd>
                <dt>risk ratio</dt>
                <dd className={`tone-${riskTone(riskiest.risk_ratio)}`}>
                  {riskiest.risk_ratio.toFixed(2)}
                </dd>
                <dt>live mid ({riskiest.pool})</dt>
                <dd>{fmtPrice(defendMid)}</dd>
              </div>
              {defendPlan && defendStaged ? (
                <>
                  <p className="note" style={{ marginTop: 8 }}>
                    Sell 25% of the {riskiest.base_asset_symbol} collateral (
                    {fmt(riskiest.base_asset * 0.25)} {riskiest.base_asset_symbol}) via a passive
                    {' '}{defendPlan.rungs.length}-rung ask ladder near mid, then repay{' '}
                    {riskiest.quote_asset_symbol} debt with the proceeds to lift the risk ratio
                    above 2.0.
                  </p>
                  <pre className="code" style={{ marginTop: 8 }}>
                    {JSON.stringify(defendStaged, null, 2)}
                  </pre>
                </>
              ) : (
                <Empty text="waiting for this pool's live mid to size the exit ladder…" />
              )}
            </>
          )}
        </Panel>

        <Panel
          title="Rotate allocation"
          sub="Move a % of one collateral asset into another via the best ≤2-hop DeepBook route, staged as a PTB preview"
        >
          {!pf.data ? (
            <Empty text="load a portfolio to rotate collateral" />
          ) : !collateralOptions.length ? (
            <Empty text="no collateral balances to rotate" />
          ) : (
            <>
              <div className="form-row">
                <label className="fld">
                  from
                  <select value={fromAsset} onChange={(e) => { setFromAsset(e.target.value); setRoutes(null) }}>
                    <option value="">select…</option>
                    {collateralOptions.map((c) => (
                      <option key={c.symbol} value={c.symbol}>
                        {c.symbol} ({fmt(c.balance)})
                      </option>
                    ))}
                  </select>
                </label>
                <label className="fld">
                  to
                  <select value={toAsset} onChange={(e) => { setToAsset(e.target.value); setRoutes(null) }}>
                    <option value="">select…</option>
                    {toOptions.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="fld">
                  % of balance
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={rotatePct}
                    onChange={(e) => { setRotatePct(+e.target.value || 0); setRoutes(null) }}
                  />
                </label>
              </div>
              <button
                className="btn"
                onClick={findRoute}
                disabled={routing || !fromAsset || !toAsset || rotateQty <= 0 || !pools.data}
              >
                {routing ? 'walking books…' : `Find route for ${fmt(rotateQty)} ${fromAsset || '…'}`}
              </button>

              {routes && (
                routes.length ? (
                  <>
                    <table className="tbl" style={{ marginTop: 10 }}>
                      <thead>
                        <tr>
                          <th>Route</th>
                          <th className="num">Legs</th>
                          <th className="num">Effective price</th>
                          <th className="num">Slippage</th>
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
                            <td>
                              <Tag tone={r.fillable ? 'live' : 'warn'}>
                                {r.fillable ? 'fully fillable' : 'partial depth'}
                              </Tag>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {rotateStaged && (
                      <pre className="code" style={{ marginTop: 8 }}>
                        {JSON.stringify(rotateStaged, null, 2)}
                      </pre>
                    )}
                  </>
                ) : (
                  <Empty text="no quotable route between these assets right now" />
                )
              )}
            </>
          )}
        </Panel>
      </div>

      <div className="banner">
        <b>Cross-primitive liquidation defense:</b> the same risk-ratio scan that powers "Defend my
        leverage" runs continuously in production, automatically staging spot-reduction, debt-repay
        or Predict tail-insurance actions the moment a monitored position's risk ratio crosses its
        threshold — all in one PTB, before the position is eligible for liquidation.
      </div>
    </div>
  )
}
