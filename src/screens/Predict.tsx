import { useMemo, useState } from 'react'
import { usePoll } from '../lib/hooks'
import { indexer, realizedVol, mid } from '../lib/indexer'
import { volCone, volSkew } from '../lib/microstructure'
import { useSession } from '../lib/session'
import { fmtPrice, fmtPct } from '../lib/format'
import { Panel, Stat, Tag, LiveBadge, Empty } from '../components/ui'
import { VolConeChart, VolSmileChart, type SmilePoint } from '../components/charts'
import { binaryFairValue, binaryDelta } from '../lib/strategy'

// Strike offsets for the empirical vol smile, in % of spot.
const SMILE_STRIKES_PCT = [-10, -7.5, -5, -2.5, 0, 2.5, 5, 7.5, 10]

/**
 * Layer 4 — DeepBook Predict workspace.
 * Predict (testnet, May 2026) brings binary options as the third primitive
 * next to Spot and Margin, priced by a Block Scholes oracle. This workspace
 * prices candidate binary markets off LIVE spot + realized vol from the
 * mainnet indexer; settlement plumbing arrives with Predict mainnet.
 */
export function Predict() {
  const { pool } = useSession()
  const candles = usePoll(() => indexer.ohlcv(pool, '1h', 400), 30_000, [pool])
  const ob = usePoll(() => indexer.orderbook(pool, 4), 5_000, [pool])

  const spot = mid(ob.data)
  const vol = useMemo(
    () => (candles.data ? realizedVol(candles.data.candles, 24 * 365) : 0),
    [candles.data],
  )
  const cone = useMemo(() => (candles.data ? volCone(candles.data.candles) : []), [candles.data])
  const skew = useMemo(() => (candles.data ? volSkew(candles.data.candles) : null), [candles.data])

  // Empirical vol smile: interpolate between the realized down/up semivariance
  // vols across strikes, so OTM strikes price off the empirical skew instead
  // of a single flat ATM vol — the smile comes from this pool's own returns.
  const smile = useMemo<SmilePoint[]>(() => {
    if (!skew) return []
    const lo = SMILE_STRIKES_PCT[0]
    const hi = SMILE_STRIKES_PCT[SMILE_STRIKES_PCT.length - 1]
    return SMILE_STRIKES_PCT.map((k) => ({
      strikePct: k,
      sigma: skew.downVolAnnual + ((k - lo) / (hi - lo)) * (skew.upVolAnnual - skew.downVolAnnual),
    }))
  }, [skew])

  const smileVol = (strikePct: number): number | null => {
    if (!smile.length) return null
    let best = smile[0]
    for (const p of smile) if (Math.abs(p.strikePct - strikePct) < Math.abs(best.strikePct - strikePct)) best = p
    return best.sigma
  }

  /**
   * Horizon-matched pricing vol: pick the realized-vol cone point whose
   * estimation window is closest to the option's time to expiry, so a 1-day
   * binary prices off short-horizon vol and a 30-day binary off the long end.
   */
  const pricingVol = (daysToExpiry: number): number => {
    if (!cone.length) return vol
    const target = daysToExpiry * 24
    let best = cone[0]
    for (const c of cone)
      if (Math.abs(c.windowHours - target) < Math.abs(best.windowHours - target)) best = c
    return best.volAnnual || vol
  }

  const [strikePct, setStrikePct] = useState(5)
  const [days, setDays] = useState(7)
  const [side, setSide] = useState<'call' | 'put'>('call')
  const [positions, setPositions] = useState<
    { market: string; side: string; price: number; size: number; strike: number; days: number; isCall: boolean }[]
  >([])

  const strike = spot * (1 + (side === 'call' ? strikePct : -strikePct) / 100)
  const sigmaAnnual = pricingVol(days)
  const fair = spot > 0 ? binaryFairValue(spot, strike, sigmaAnnual, days, side === 'call') : 0
  const delta = spot > 0 ? binaryDelta(spot, strike, sigmaAnnual, days, side === 'call') : 0

  // Smile-adjusted fair value: same strike, but priced off the empirical
  // up/down skew at this strike's distance instead of one flat ATM sigma.
  const smileSigma = smileVol(side === 'call' ? strikePct : -strikePct)
  const smileFair =
    smileSigma != null && spot > 0 ? binaryFairValue(spot, strike, smileSigma, days, side === 'call') : null

  // d₁ = (ln(S/K) − σ²t/2) / (σ√t) — the lognormal model's standardized
  // distance to strike; N(d₁) is the fair YES price for a call (1 − N(d₁) for
  // a put), exactly the quantity binaryFairValue returns above.
  const t = days / 365
  const sigmaT = sigmaAnnual * Math.sqrt(t)
  const d1 = spot > 0 && sigmaT > 0 ? (Math.log(spot / strike) - 0.5 * sigmaT * sigmaT) / sigmaT : 0

  const presetMarkets = useMemo(() => {
    if (spot <= 0) return []
    const mk = (label: string, k: number, d: number, isCall: boolean) => ({
      label,
      strike: spot * k,
      days: d,
      isCall,
      yes: binaryFairValue(spot, spot * k, pricingVol(d), d, isCall),
    })
    const base = pool.split('_')[0]
    return [
      mk(`${base} +2% in 24h`, 1.02, 1, true),
      mk(`${base} +5% in 7d`, 1.05, 7, true),
      mk(`${base} -5% in 7d`, 0.95, 7, false),
      mk(`${base} +10% in 30d`, 1.1, 30, true),
      mk(`${base} -10% in 30d`, 0.9, 30, false),
    ]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spot, vol, cone, pool])

  return (
    <div>
      <div className="screen-head">
        <h2>Predict / Options Workspace</h2>
        <p>Binary event markets on DeepBook Predict, priced from live spot + realized vol</p>
        <LiveBadge ok={spot > 0} />
        <Tag tone="sim">PRICING MODEL — Predict is on testnet; mainnet later in 2026</Tag>
      </div>

      <div className="stat-row">
        <Stat label={`${pool} spot (live)`} value={fmtPrice(spot)} />
        <Stat
          label="Realized vol (annualized)"
          value={vol > 0 ? fmtPct(vol * 100, 0) : '—'}
          hint="from 96 hourly closes via the live indexer"
        />
        <Stat label="Pricing oracle" value="Block Scholes (prod)" hint="lognormal stand-in here" />
        <Stat label="Settlement" value="DeepBook Predict" />
      </div>

      <div className="screen-grid cols-32">
        <Panel
          title="Market builder"
          sub="Define a binary market; fair YES price comes from the vol model"
        >
          <div className="seg" style={{ marginBottom: 10 }}>
            <button className={side === 'call' ? 'on' : ''} onClick={() => setSide('call')}>
              Above (call)
            </button>
            <button className={side === 'put' ? 'on' : ''} onClick={() => setSide('put')}>
              Below (put)
            </button>
          </div>
          <div className="form-row">
            <label className="fld">
              strike distance %
              <input
                type="number"
                step="0.5"
                value={strikePct}
                onChange={(e) => setStrikePct(+e.target.value || 0.5)}
              />
            </label>
            <label className="fld">
              days to expiry
              <input
                type="number"
                min={1}
                value={days}
                onChange={(e) => setDays(+e.target.value || 1)}
              />
            </label>
          </div>
          <div className="kv">
            <dt>S — live mid</dt>
            <dd>{fmtPrice(spot)}</dd>
            <dt>K — strike</dt>
            <dd>{fmtPrice(strike)}</dd>
            <dt>σ — pricing vol (horizon-matched, ann.)</dt>
            <dd>{fmtPct(sigmaAnnual * 100, 0)}</dd>
            <dt>t — time to expiry</dt>
            <dd>{days}d / 365 = {t.toFixed(4)}</dd>
            <dt>d₁ = (ln(S/K) − σ²t/2) / (σ√t)</dt>
            <dd>{d1.toFixed(3)}</dd>
            <dt>fair YES price = N(d₁) {side === 'put' && '→ 1 − N(d₁)'}</dt>
            <dd>
              <b>{(fair * 100).toFixed(1)}¢</b> per $1 payout
            </dd>
            <dt>implied odds</dt>
            <dd>{(fair * 100).toFixed(1)}%</dd>
            <dt>delta = ∂(fair YES)/∂S</dt>
            <dd>
              {delta.toFixed(4)} per unit of {pool.split('_')[0]}
            </dd>
            <dt>fair YES (smile-adjusted)</dt>
            <dd>
              {smileFair != null ? (
                <>
                  <b>{(smileFair * 100).toFixed(1)}¢</b>{' '}
                  <span style={{ color: 'var(--muted)' }}>
                    (σ {fmtPct((smileSigma ?? 0) * 100, 0)} vs flat {fmtPct(sigmaAnnual * 100, 0)})
                  </span>
                </>
              ) : (
                '—'
              )}
            </dd>
          </div>
          <p style={{ marginTop: 6 }}>
            <Tag tone="sim">SIMULATED (lognormal stand-in for Block Scholes oracle)</Tag>
          </p>

          {cone.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div className="nav-section" style={{ margin: '0 0 6px' }}>
                Realized-vol cone (this pool, live) — one bar per horizon
              </div>
              <VolConeChart cone={cone} />
              <table className="tbl" style={{ marginTop: 4 }}>
                <thead>
                  <tr>
                    <th>Window</th>
                    <th className="num">Ann. vol</th>
                    <th className="num">Samples</th>
                  </tr>
                </thead>
                <tbody>
                  {cone.map((c) => (
                    <tr key={c.label}>
                      <td>{c.label}</td>
                      <td className="num">{fmtPct(c.volAnnual * 100, 0)}</td>
                      <td className="num">{c.samples}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="note" style={{ marginTop: 6 }}>
                Each market prices off the cone point nearest its expiry — short-dated binaries
                use short-horizon vol, long-dated use the long end. In production the Block
                Scholes oracle replaces this entire d₁/N(d₁) block; the formula and inputs above
                stay identical.
              </p>
            </div>
          )}

          {smile.length > 0 && skew && (
            <div style={{ marginTop: 12 }}>
              <div className="nav-section" style={{ margin: '0 0 6px' }}>
                Empirical vol smile (realized semivariance skew, this pool)
              </div>
              <VolSmileChart points={smile} />
              <table className="tbl" style={{ marginTop: 4 }}>
                <thead>
                  <tr>
                    <th className="num">Strike</th>
                    <th className="num">Skew vol</th>
                    <th className="num">Fair YES (skew)</th>
                    <th className="num">Fair YES (flat ATM)</th>
                  </tr>
                </thead>
                <tbody>
                  {smile.map((p) => {
                    const k = spot * (1 + p.strikePct / 100)
                    const isCall = p.strikePct >= 0
                    const skewFair = spot > 0 ? binaryFairValue(spot, k, p.sigma, days, isCall) : 0
                    const flatFair = spot > 0 ? binaryFairValue(spot, k, sigmaAnnual, days, isCall) : 0
                    return (
                      <tr key={p.strikePct}>
                        <td className="num">
                          {p.strikePct > 0 ? '+' : ''}
                          {p.strikePct}% ({fmtPrice(k)})
                        </td>
                        <td className="num">{fmtPct(p.sigma * 100, 0)}</td>
                        <td className="num">{(skewFair * 100).toFixed(1)}¢</td>
                        <td className="num">{(flatFair * 100).toFixed(1)}¢</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              <p className="note" style={{ marginTop: 6 }}>
                Realized semivariance: downside vol {fmtPct(skew.downVolAnnual * 100, 0)} vs upside
                vol {fmtPct(skew.upVolAnnual * 100, 0)} from {skew.samples} hourly returns over this
                pool's full candle window (Barndorff-Nielsen decomposition). The smile linearly
                interpolates sigma between these two across strikes — a real, measured skew in
                place of one flat sigma for every strike. "Fair YES (flat ATM)" repeats the
                single-sigma price from above for comparison.
              </p>
            </div>
          )}
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <button
              className="btn buy"
              disabled={spot <= 0}
              onClick={() =>
                setPositions((p) => [
                  ...p,
                  {
                    market: `${pool.split('_')[0]} ${side === 'call' ? '≥' : '<'} ${fmtPrice(strike)} in ${days}d`,
                    side: 'YES',
                    price: fair,
                    size: 100,
                    strike,
                    days,
                    isCall: side === 'call',
                  },
                ])
              }
            >
              Buy YES @ {(fair * 100).toFixed(1)}¢
            </button>
            <button
              className="btn sell"
              disabled={spot <= 0}
              onClick={() =>
                setPositions((p) => [
                  ...p,
                  {
                    market: `${pool.split('_')[0]} ${side === 'call' ? '≥' : '<'} ${fmtPrice(strike)} in ${days}d`,
                    side: 'NO',
                    price: 1 - fair,
                    size: 100,
                    strike,
                    days,
                    isCall: side === 'call',
                  },
                ])
              }
            >
              Buy NO @ {((1 - fair) * 100).toFixed(1)}¢
            </button>
          </div>
        </Panel>

        <Panel
          title="Candidate event markets"
          sub="Auto-generated from live vol — exactly what the market creation toolkit deploys as Predict pools"
          right={<Tag tone="sim">SIMULATED PRICING</Tag>}
        >
          {presetMarkets.length ? (
            <div className="screen-grid cols-2" style={{ marginTop: 0 }}>
              {presetMarkets.map((m) => (
                <div key={m.label} className="panel" style={{ padding: 12 }}>
                  <div style={{ fontWeight: 650, marginBottom: 6 }}>{m.label}</div>
                  <div className="kv" style={{ fontSize: 12 }}>
                    <dt>strike</dt>
                    <dd>{fmtPrice(m.strike)}</dd>
                    <dt>expiry</dt>
                    <dd>{m.days}d</dd>
                    <dt>fair YES</dt>
                    <dd className="tone-up">{(m.yes * 100).toFixed(1)}¢</dd>
                    <dt>fair NO</dt>
                    <dd className="tone-down">{((1 - m.yes) * 100).toFixed(1)}¢</dd>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Empty text="waiting for live spot…" />
          )}
        </Panel>

        <Panel
          className="span-all"
          title="Workspace positions (paper)"
          sub="Positions accumulate here for the hedging engine on the Portfolio screen"
        >
          {positions.length ? (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Market</th>
                  <th>Side</th>
                  <th className="num">Entry</th>
                  <th className="num">Size ($ payout)</th>
                  <th className="num">Max loss</th>
                  <th className="num">Max gain</th>
                  <th className="num">Delta ($/Δ1 spot)</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p, i) => {
                  const sigma = pricingVol(p.days)
                  const callDelta = spot > 0 ? binaryDelta(spot, p.strike, sigma, p.days, p.isCall) : 0
                  const posDelta = (p.side === 'YES' ? callDelta : -callDelta) * p.size
                  return (
                    <tr key={i}>
                      <td>{p.market}</td>
                      <td>
                        <Tag tone={p.side === 'YES' ? 'live' : 'warn'}>{p.side}</Tag>
                      </td>
                      <td className="num">{(p.price * 100).toFixed(1)}¢</td>
                      <td className="num">${p.size}</td>
                      <td className="num tone-down">-${(p.price * p.size).toFixed(0)}</td>
                      <td className="num tone-up">+${((1 - p.price) * p.size).toFixed(0)}</td>
                      <td className={`num tone-${posDelta >= 0 ? 'up' : 'down'}`}>{posDelta.toFixed(2)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          ) : (
            <Empty text="no positions — buy YES/NO above" />
          )}
        </Panel>
      </div>

      <div className="banner">
        <b>When DeepBook Predict reaches mainnet:</b> this pricing will switch to the Block
        Scholes oracle. The d₁/N(d₁) formula and the S, K, σ, t inputs shown above will be
        identical — only the volatility surface's source changes.
      </div>

      <div className="banner">
        <b>Composability:</b> Predict v1 ships binary options; calls, puts and spreads compose
        next. Because Predict settles on the same infrastructure as Spot and Margin, the OS can
        hedge a leveraged SUI long with "SUI &lt; strike" YES exposure in one atomic transaction —
        the cross-primitive liquidation defense described in the spec.
      </div>
    </div>
  )
}
