import { useMemo, useState } from 'react'
import { usePoll, useLoad } from '../lib/hooks'
import { indexer, spreadBps } from '../lib/indexer'
import { makerLeaderboard } from '../lib/microstructure'
import { useSession } from '../lib/session'
import { fmt, fmtPrice, fmtUsd, shortAddr } from '../lib/format'
import { Panel, Stat, Tag, ScoreBar, LiveBadge, Empty, Modal } from '../components/ui'

interface VaultDef {
  name: string
  pool: string
  style: string
  apr: number
  tvlUsd: number
  util: number
  risk: 'low' | 'medium' | 'high'
}

const VAULTS: VaultDef[] = [
  {
    name: 'Tight-Spread Quoter',
    pool: 'SUI_USDC',
    style: 'symmetric quoting ±2 ticks, inventory-capped',
    apr: 11.2,
    tvlUsd: 1_840_000,
    util: 74,
    risk: 'medium',
  },
  {
    name: 'Stable Pair Harvester',
    pool: 'USDT_USDC',
    style: 'wide passive grid, fee + DEEP incentive capture',
    apr: 5.8,
    tvlUsd: 4_120_000,
    util: 91,
    risk: 'low',
  },
  {
    name: 'Volatility Quoter',
    pool: 'DEEP_USDC',
    style: 'spread widens with realized vol, hedges tail with Predict puts',
    apr: 19.4,
    tvlUsd: 612_000,
    util: 52,
    risk: 'high',
  },
]

/**
 * Layer 3 — Liquidity Infrastructure.
 * Live maker analytics from the tape (who actually provides liquidity, and how
 * well), plus the shared market-making vault and margin-pool supply view.
 */
export function Vault() {
  const { pool } = useSession()
  const trades = usePoll(() => indexer.trades(pool, 100), 6_000, [pool])
  const orderUpdates = usePoll(() => indexer.orderUpdates(pool, 200), 8_000, [pool])
  const ob = usePoll(() => indexer.orderbook(pool, 20), 5_000, [pool])
  const marginSupply = useLoad(() => indexer.marginSupply())

  // Liquidity reputation leaderboard (spec 8.8): depth share, fill persistence
  // and volume-weighted realized spread (maker edge) from the TCA decomposition.
  const makers = useMemo(
    () => makerLeaderboard(trades.data ?? [], orderUpdates.data ?? []).slice(0, 8),
    [trades.data, orderUpdates.data],
  )
  const avgReputation = makers.length
    ? makers.reduce((a, m) => a + m.reputation, 0) / makers.length
    : null

  const [depositVault, setDepositVault] = useState<VaultDef | null>(null)

  const bookDepth = useMemo(() => {
    if (!ob.data) return { bid: 0, ask: 0 }
    const bid = ob.data.bids.reduce((a, [p, q]) => a + parseFloat(p) * parseFloat(q), 0)
    const ask = ob.data.asks.reduce((a, [p, q]) => a + parseFloat(p) * parseFloat(q), 0)
    return { bid, ask }
  }, [ob.data])

  return (
    <div>
      <div className="screen-head">
        <h2>Liquidity Vault Dashboard</h2>
        <p>Maker analytics from the live tape · vault strategies that quote on DeepBook</p>
        <LiveBadge ok={!trades.error && !!trades.data} />
      </div>

      <div className="stat-row">
        <Stat label={`${pool} bid depth (quote)`} value={fmt(bookDepth.bid)} tone="up" />
        <Stat label={`${pool} ask depth (quote)`} value={fmt(bookDepth.ask)} tone="down" />
        <Stat label="Spread" value={`${spreadBps(ob.data).toFixed(1)} bps`} />
        <Stat
          label="Active makers (recent tape)"
          value={makers.length}
          hint="distinct maker BalanceManagers in the last ~100 fills"
        />
      </div>

      <div className="screen-grid cols-2">
        <Panel
          title="Maker leaderboard — liquidity reputation"
          sub={`Real maker BalanceManagers in recent ${pool} fills. Maker edge = volume-weighted realized spread (TCA). Reputation = 40% depth share + 35% persistence + 25% edge.`}
        >
          {makers.length ? (
            <table className="tbl">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Maker</th>
                  <th className="num">Vol (quote)</th>
                  <th className="num">Depth share</th>
                  <th className="num">Edge</th>
                  <th className="num">Persistence</th>
                  <th>Reputation</th>
                </tr>
              </thead>
              <tbody>
                {makers.map((m, i) => (
                  <tr key={m.id}>
                    <td className="num">{i + 1}</td>
                    <td title={m.id}>{shortAddr(m.id)}</td>
                    <td className="num">{fmt(m.quoteVol)}</td>
                    <td className="num">{(m.share * 100).toFixed(1)}%</td>
                    <td
                      className={`num ${m.edgeBps == null ? '' : m.edgeBps >= 0 ? 'tone-up' : 'tone-down'}`}
                      title="volume-weighted realized spread — the maker's net capture after adverse selection"
                    >
                      {m.edgeBps == null ? '—' : `${m.edgeBps.toFixed(2)} bps`}
                    </td>
                    <td className="num" title="fraction of this maker's orders that stayed in the book > 30s">
                      {(m.persistence * 100).toFixed(0)}%
                    </td>
                    <td style={{ width: 110 }}>
                      <ScoreBar score={m.reputation} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty text="building leaderboard from live fills…" />
          )}
        </Panel>

        <Panel
          title="Margin pool supply (live)"
          sub="On-chain lending capacity behind DeepBook Margin — capital the allocator can route between quoting, leverage and hedging"
        >
          {marginSupply.data ? (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Asset</th>
                  <th className="num">Total supplied (raw units)</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(marginSupply.data).map(([asset, amt]) => (
                  <tr key={asset}>
                    <td>{asset.split('::').pop()}</td>
                    <td className="num">{fmt(amt, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty
              text={
                marginSupply.error
                  ? `margin endpoint: ${marginSupply.error}`
                  : 'loading margin pools…'
              }
              tone={marginSupply.error ? 'error' : undefined}
            />
          )}
        </Panel>

        <Panel
          className="span-all"
          title="Shared market-making vaults"
          sub="Deposit once; the vault quotes on DeepBook under its own BalanceManager with a revocable TradeCap. Illustrative strategies — APRs are simulated targets, not live returns."
          right={<Tag tone="sim">SIMULATED</Tag>}
        >
          <table className="tbl">
            <thead>
              <tr>
                <th>Vault</th>
                <th>Pool</th>
                <th>Strategy</th>
                <th className="num">Target APR</th>
                <th className="num">TVL</th>
                <th className="num">Utilization</th>
                <th>Maker efficiency</th>
                <th>Risk</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {VAULTS.map((v) => (
                <tr key={v.name}>
                  <td>
                    <b>{v.name}</b>
                  </td>
                  <td>{v.pool}</td>
                  <td style={{ color: 'var(--muted)' }}>{v.style}</td>
                  <td className="num tone-up">
                    {v.apr.toFixed(1)}% <Tag tone="sim">SIM</Tag>
                  </td>
                  <td className="num">
                    {fmtUsd(v.tvlUsd)} <Tag tone="sim">SIM</Tag>
                  </td>
                  <td className="num">
                    {v.util}% <Tag tone="sim">SIM</Tag>
                  </td>
                  <td style={{ width: 110 }}>
                    {v.pool === pool && avgReputation != null ? (
                      <ScoreBar score={avgReputation} />
                    ) : (
                      <span className="note">switch pool to {v.pool}</span>
                    )}
                  </td>
                  <td>
                    <Tag tone={v.risk === 'low' ? 'live' : v.risk === 'medium' ? 'info' : 'warn'}>
                      {v.risk}
                    </Tag>
                  </td>
                  <td>
                    <button className="btn ghost" onClick={() => setDepositVault(v)}>
                      Deposit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="note" style={{ marginTop: 8 }}>
            Last vault price reference: {fmtPrice(trades.data?.[0]?.price ?? null)} ({pool}).
            APR and TVL above are illustrative placeholders only — maker efficiency is the only
            live number in this table, drawn from the leaderboard's average reputation for
            BalanceManagers active in the vault's pool. The risk-aware capital allocator
            rebalances deposits across quoting, margin lending and Predict hedges as realized
            vol shifts — see the product spec for the policy loop.
          </p>
        </Panel>
      </div>

      {depositVault && (
        <Modal title={`Deposit — ${depositVault.name}`} onClose={() => setDepositVault(null)}>
          <p>
            This is a <b>simulated</b> vault — no funds move. It illustrates how Layer 3 shared
            market-making vaults work on top of the same BalanceManager primitives shown in the
            Desk Manager screen.
          </p>
          <p>
            <b>Shared BalanceManager.</b> Depositors' funds are pooled into a single
            BalanceManager owned by the vault contract. Your deposit mints a share token
            representing your claim on that manager's balance.
          </p>
          <p>
            <b>Revocable TradeCap.</b> The vault's strategy engine holds a TradeCap on that
            BalanceManager — it can place and cancel orders on DeepBook, but it can never
            withdraw funds. Governance can revoke the TradeCap at any time, instantly halting
            trading without touching custody.
          </p>
          <p>
            <b>Governance revocation.</b> If the strategy underperforms or risk limits are
            breached, a governance vote (or risk-engine trigger) revokes the active TradeCap and
            mints a fresh one for a replacement strategy or for wind-down, while deposits remain
            safe in the BalanceManager throughout.
          </p>
          <p>
            <b>Maker efficiency</b> for {depositVault.pool} is computed live from the maker
            leaderboard above ({depositVault.pool === pool ? `${avgReputation?.toFixed(0) ?? '—'} / 100` : 'switch to that pool to see it'}) — it is the only non-simulated
            number in this card.
          </p>
        </Modal>
      )}
    </div>
  )
}
