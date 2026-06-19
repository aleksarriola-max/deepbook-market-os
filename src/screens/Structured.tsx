import { useMemo, useState } from 'react'
import { usePoll } from '../lib/hooks'
import { indexer, mid, realizedVol } from '../lib/indexer'
import { useSession } from '../lib/session'
import { fmtPrice, fmtPct } from '../lib/format'
import { Panel, Stat, Tag, Empty, LiveBadge } from '../components/ui'
import { PayoffChart } from '../components/charts'
import {
  productPayoff,
  binaryFairValue,
  type ProductLeg,
  type LegType,
} from '../lib/strategy'

const LEG_LABEL: Record<LegType, string> = {
  spot: 'Spot position',
  'margin-long': 'Margin Long',
  'margin-short': 'Margin Short',
  'binary-call': 'Binary Call (Predict)',
  'binary-put': 'Binary Put (Predict)',
}

/** UI-level leg choices — "Spot Long"/"Spot Short" both map to the `spot`
 *  LegType, distinguished by the sign of `size`. */
type UiLegType = 'spot-long' | 'spot-short' | LegType

const UI_LEG_LABEL: Record<UiLegType, string> = {
  'spot-long': 'Spot Long',
  'spot-short': 'Spot Short',
  spot: 'Spot position',
  'margin-long': 'Margin Long',
  'margin-short': 'Margin Short',
  'binary-call': 'Binary Call (Predict)',
  'binary-put': 'Binary Put (Predict)',
}

const TEMPLATES: { name: string; desc: string; make: (spot: number, vol: number) => ProductLeg[] }[] = [
  {
    name: 'Protected spot',
    desc: 'Spot + binary put: keeps upside, pays out if price settles below the floor.',
    make: (s, v) => [
      { type: 'spot', ref: s, size: 100 },
      {
        type: 'binary-put',
        ref: s * 0.93,
        size: 100 * s * 0.07,
        premium: binaryFairValue(s, s * 0.93, v, 14, false),
      },
    ],
  },
  {
    name: 'Leveraged breakout',
    desc: '2x margin long financed by selling the downside binary — convex above, capped below.',
    make: (s, v) => [
      { type: 'margin-long', ref: s, size: 50, leverage: 2 },
      {
        type: 'binary-call',
        ref: s * 1.05,
        size: 50 * s * 0.05,
        premium: binaryFairValue(s, s * 1.05, v, 14, true),
      },
    ],
  },
  {
    name: 'Range income',
    desc: 'Short both wings with binaries: collects premium while price stays inside the band.',
    make: (s, v) => [
      {
        type: 'binary-call',
        ref: s * 1.08,
        size: -100,
        premium: binaryFairValue(s, s * 1.08, v, 14, true),
      },
      {
        type: 'binary-put',
        ref: s * 0.92,
        size: -100,
        premium: binaryFairValue(s, s * 0.92, v, 14, false),
      },
    ],
  },
]

/**
 * Layer 4 — Structured Product Builder.
 * Assemble custom payoffs from Spot + Margin + Predict legs. The payoff curve
 * is computed against the live mid; binary premia come from the vol model.
 */
export function Structured() {
  const { pool } = useSession()
  const ob = usePoll(() => indexer.orderbook(pool, 4), 5_000, [pool])
  const candles = usePoll(() => indexer.ohlcv(pool, '1h', 96), 60_000, [pool])
  const spot = mid(ob.data)
  const vol = useMemo(
    () => (candles.data ? realizedVol(candles.data.candles, 24 * 365) : 0.6),
    [candles.data],
  )

  const [legs, setLegs] = useState<ProductLeg[]>([])
  const [legType, setLegType] = useState<UiLegType>('spot-long')
  const [refPct, setRefPct] = useState(0)
  const [size, setSize] = useState(100)
  const [lev, setLev] = useState(2)

  const addLeg = () => {
    if (spot <= 0) return
    const ref = spot * (1 + refPct / 100)
    const type: LegType = legType === 'spot-long' || legType === 'spot-short' ? 'spot' : legType
    const signedSize = legType === 'spot-short' ? -Math.abs(size) : Math.abs(size)
    const leg: ProductLeg = { type, ref, size: signedSize }
    if (type.startsWith('margin')) leg.leverage = lev
    if (type.startsWith('binary'))
      leg.premium = binaryFairValue(spot, ref, vol, 14, type === 'binary-call')
    setLegs((l) => [...l, leg])
  }

  return (
    <div>
      <div className="screen-head">
        <h2>Structured Product Builder</h2>
        <p>Compose payoffs across Spot, Margin and Predict — the design space Predict unlocked</p>
        <LiveBadge ok={spot > 0} />
      </div>

      <div className="stat-row">
        <Stat label={`${pool} spot`} value={fmtPrice(spot)} />
        <Stat label="Vol input" value={fmtPct(vol * 100, 0)} />
        <Stat label="Legs" value={legs.length} />
        <Stat
          label="Settlement"
          value="atomic PTB"
          hint="all legs execute in one programmable transaction block"
        />
      </div>

      <div className="screen-grid cols-32">
        <Panel title="Add a leg" sub="Strike/entry expressed as % distance from live spot">
          <div className="form-row">
            <label className="fld" style={{ flex: 2 }}>
              leg type
              <select value={legType} onChange={(e) => setLegType(e.target.value as UiLegType)}>
                {(['spot-long', 'spot-short', 'margin-long', 'margin-short', 'binary-call', 'binary-put'] as UiLegType[]).map((k) => (
                  <option key={k} value={k}>
                    {UI_LEG_LABEL[k]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="form-row">
            <label className="fld">
              ref % from spot
              <input
                type="number"
                step="1"
                value={refPct}
                onChange={(e) => setRefPct(+e.target.value || 0)}
              />
            </label>
            <label className="fld">
              size {legType.startsWith('binary') ? '($ payout)' : '(base units)'}
              <input type="number" value={size} onChange={(e) => setSize(+e.target.value || 0)} />
            </label>
            {legType.startsWith('margin') && (
              <label className="fld">
                leverage
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={lev}
                  onChange={(e) => setLev(+e.target.value || 1)}
                />
              </label>
            )}
          </div>
          <button className="btn" onClick={addLeg} disabled={spot <= 0}>
            Add leg
          </button>

          <div style={{ marginTop: 14 }}>
            <div className="nav-section" style={{ margin: '0 0 6px' }}>
              Templates
            </div>
            <div className="pill-row">
              {TEMPLATES.map((t) => (
                <button
                  key={t.name}
                  className="pill"
                  title={t.desc}
                  onClick={() => spot > 0 && setLegs(t.make(spot, vol))}
                >
                  {t.name}
                </button>
              ))}
            </div>
          </div>
        </Panel>

        <Panel
          title="Payoff at settlement"
          sub="P&L (quote units) vs settlement price, ±30% around live spot"
          right={
            legs.length > 0 && (
              <button className="btn ghost" onClick={() => setLegs([])}>
                clear
              </button>
            )
          }
        >
          {legs.length && spot > 0 ? (
            <PayoffChart spot={spot} payoff={(s) => productPayoff(legs, s)} widthPct={30} />
          ) : (
            <Empty text="add legs or pick a template to see the payoff curve" />
          )}
        </Panel>

        <Panel
          className="span-all"
          title="Product legs"
          sub="Each leg maps 1:1 to a DeepBook primitive call at deployment"
        >
          {legs.length ? (
            <table className="tbl">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Leg</th>
                  <th className="num">Ref / strike</th>
                  <th className="num">Size</th>
                  <th className="num">Leverage</th>
                  <th className="num">Premium</th>
                  <th>Deploys via</th>
                </tr>
              </thead>
              <tbody>
                {legs.map((l, i) => (
                  <tr key={i}>
                    <td>{i + 1}</td>
                    <td>
                      {l.type === 'spot'
                        ? l.size >= 0
                          ? 'Spot Long'
                          : 'Spot Short'
                        : LEG_LABEL[l.type]}
                    </td>
                    <td className="num">{fmtPrice(l.ref)}</td>
                    <td className="num">{l.size}</td>
                    <td className="num">{l.leverage ?? '—'}</td>
                    <td className="num">
                      {l.premium != null ? (
                        <>
                          {(l.premium * 100).toFixed(1)}¢ <Tag tone="sim">SIM</Tag>
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      <Tag
                        tone={
                          l.type === 'spot' ? 'live' : l.type.startsWith('margin') ? 'info' : 'sim'
                        }
                      >
                        {l.type === 'spot'
                          ? 'deepbook::pool'
                          : l.type.startsWith('margin')
                            ? 'deepbook_margin'
                            : 'deepbook_predict'}
                      </Tag>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty text="no legs yet" />
          )}
        </Panel>
      </div>
    </div>
  )
}
