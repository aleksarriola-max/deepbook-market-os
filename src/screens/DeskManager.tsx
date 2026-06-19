import { useMemo, useState } from 'react'
import { useLoad, usePoll } from '../lib/hooks'
import { indexer, type ManagerOrder } from '../lib/indexer'
import { useSession } from '../lib/session'
import { fmt, fmtPrice, shortAddr, ago, clock } from '../lib/format'
import { Panel, Stat, Tag, Empty, LiveBadge } from '../components/ui'
import { describeDelegation, type DelegationRole } from '../lib/deepbook'

function isOpenStatus(status: string): boolean {
  const s = status.toLowerCase()
  return !s.includes('cancel') && !s.includes('fill') && !s.includes('expir')
}

function StatusTag(props: { status: string }) {
  const s = props.status.toLowerCase()
  if (s.includes('fill')) return <Tag tone="live">{props.status}</Tag>
  if (s.includes('cancel') || s.includes('expir'))
    return <span style={{ color: 'var(--muted)' }}>{props.status}</span>
  return <Tag tone="info">{props.status}</Tag>
}

/**
 * Layer 2 — Trading Desk / Account Infrastructure.
 * Built on DeepBookV3's BalanceManager account abstraction: one owned object
 * holds funds; TradeCaps delegate place/cancel rights without custody.
 * Paste any mainnet BalanceManager ID to inspect its real activity.
 */
export function DeskManager() {
  const { pool, balanceManager, setBalanceManager } = useSession()
  const [input, setInput] = useState(balanceManager)
  const [queryId, setQueryId] = useState(balanceManager)

  const pools = usePoll(() => indexer.pools(), 120_000)

  const orders = usePoll(
    () => (queryId ? indexer.ordersByManager(pool, queryId, 40) : Promise.resolve(null)),
    10_000,
    [queryId, pool],
  )

  const volume = useLoad(() => {
    if (!queryId || !pools.data) return Promise.resolve(null)
    return indexer.volumeByManager(pools.data.map((p) => p.pool_name).join(','), queryId)
  }, [queryId, pools.data])

  const auditLog = usePoll(() => indexer.orderUpdates(pool, 100), 15_000, [pool])

  // ----------------------------- multi-pool scanner ------------------------
  const [scanning, setScanning] = useState(false)
  const [scan, setScan] = useState<{ pool: string; orders: ManagerOrder[] }[] | null>(null)

  const scanAllPools = async () => {
    if (!queryId || !pools.data) return
    setScanning(true)
    try {
      const results = await Promise.all(
        pools.data.map(async (p) => ({
          pool: p.pool_name,
          orders: await indexer.ordersByManager(p.pool_name, queryId, 100).catch(() => []),
        })),
      )
      setScan(results)
    } finally {
      setScanning(false)
    }
  }

  const scanSummary = useMemo(() => {
    if (!scan) return null
    const rows = scan
      .map((r) => {
        const open = r.orders.filter((o) => isOpenStatus(o.current_status))
        return {
          pool: r.pool,
          quote: r.pool.split('_').slice(1).join('_'),
          openCount: open.length,
          notional: open.reduce((a, o) => a + o.price * o.remaining_quantity, 0),
        }
      })
      .filter((r) => r.openCount > 0)
    return { rows, totalOrders: rows.reduce((a, r) => a + r.openCount, 0) }
  }, [scan])

  // ----------------------------- delegation builder -------------------------
  const [delegate, setDelegate] = useState('')
  const [role, setRole] = useState<DelegationRole>('trader')
  const [copied, setCopied] = useState(false)
  const delegationValid = queryId.startsWith('0x') && delegate.startsWith('0x')
  const delegation = delegationValid ? describeDelegation(queryId, role, delegate) : null
  const stagedDelegation = delegation
    ? JSON.stringify(
        {
          network: 'testnet',
          balance_manager: queryId,
          delegate,
          role: delegation.role,
          actions: delegation.actions,
          note: delegation.note,
        },
        null,
        2,
      )
    : null

  // ----------------------------- audit log ----------------------------------
  const auditRows = (auditLog.data ?? []).filter(
    (o) => !queryId || o.balance_manager_id === queryId,
  )

  const roles = [
    {
      role: 'Owner',
      cap: 'OwnerCap',
      rights: 'deposit · withdraw · mint/revoke TradeCaps · set referrals',
      tone: 'live' as const,
      who: 'treasury multisig',
    },
    {
      role: 'Trader',
      cap: 'TradeCap',
      rights: 'place orders · cancel orders (no withdrawals)',
      tone: 'info' as const,
      who: 'execution bot #1',
    },
    {
      role: 'Strategist',
      cap: 'TradeCap',
      rights: 'deploy saved strategy templates within risk limits',
      tone: 'info' as const,
      who: 'quant analyst',
    },
    {
      role: 'Viewer',
      cap: '— (indexer only)',
      rights: 'read fills, volumes, exposure — zero on-chain authority',
      tone: 'warn' as const,
      who: 'risk / compliance',
    },
  ]

  return (
    <div>
      <div className="screen-head">
        <h2>Trading Account / Desk Manager</h2>
        <p>
          Shared trading accounts on BalanceManager — owner keeps custody, traders get revocable
          TradeCaps
        </p>
        <LiveBadge ok={!orders.error} />
      </div>

      <div className="screen-grid cols-32" style={{ marginTop: 14 }}>
        <Panel
          title="Desk roles"
          sub="The capability model DeepBookV3 ships natively — the OS just gives it an operating surface"
        >
          <table className="tbl">
            <thead>
              <tr>
                <th>Role</th>
                <th>Capability object</th>
                <th>Rights</th>
                <th>Assigned to</th>
              </tr>
            </thead>
            <tbody>
              {roles.map((r) => (
                <tr key={r.role}>
                  <td>
                    <b>{r.role}</b>
                  </td>
                  <td>
                    <Tag tone={r.tone}>{r.cap}</Tag>
                  </td>
                  <td style={{ color: 'var(--muted)' }}>{r.rights}</td>
                  <td>{r.who}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="note" style={{ marginTop: 10 }}>
            Every action lands on-chain under the manager's ID, so the audit log below is not a
            database — it is Sui itself, read back through the indexer.
          </p>
        </Panel>

        <Panel
          title="Inspect a live BalanceManager"
          sub="Paste any mainnet BalanceManager object ID (find them on the Analytics screen's order stream)"
        >
          <div className="form-row">
            <label className="fld" style={{ flex: 3 }}>
              balance manager object id
              <input
                value={input}
                placeholder="0x…"
                onChange={(e) => setInput(e.target.value.trim())}
              />
            </label>
            <button
              className="btn"
              onClick={() => {
                setQueryId(input)
                setBalanceManager(input)
                setScan(null)
              }}
              disabled={!input.startsWith('0x')}
            >
              Inspect
            </button>
          </div>
          {queryId ? (
            volume.data && Object.keys(volume.data).length ? (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Pool</th>
                    <th className="num">Maker volume</th>
                    <th className="num">Taker volume</th>
                    <th className="num">Maker / taker</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(volume.data).map(([p, [maker, taker]]) => (
                    <tr key={p}>
                      <td>{p}</td>
                      <td className="num">{fmt(maker)}</td>
                      <td className="num">{fmt(taker)}</td>
                      <td className="num">{taker > 0 ? (maker / taker).toFixed(2) : '∞'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <Empty text="no historical volume for this manager yet" />
            )
          ) : (
            <Empty text="inspect a BalanceManager to see its volume breakdown" />
          )}
        </Panel>
      </div>

      <div className="screen-grid cols-2">
        <Panel
          title="Multi-pool scanner"
          sub="Walks every live pool's order book for this manager and aggregates open exposure"
        >
          <button
            className="btn"
            onClick={scanAllPools}
            disabled={!queryId || scanning || !pools.data}
          >
            {scanning ? `scanning ${pools.data?.length ?? 0} pools…` : 'Scan all pools'}
          </button>
          {scanSummary ? (
            scanSummary.rows.length ? (
              <>
                <div className="stat-row" style={{ marginTop: 10 }}>
                  <Stat label="Total open orders" value={scanSummary.totalOrders} />
                  <Stat label="Pools with open orders" value={scanSummary.rows.length} />
                </div>
                <table className="tbl" style={{ marginTop: 10 }}>
                  <thead>
                    <tr>
                      <th>Pool</th>
                      <th className="num">Open orders</th>
                      <th className="num">Open notional</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scanSummary.rows.map((r) => (
                      <tr key={r.pool}>
                        <td>{r.pool}</td>
                        <td className="num">{r.openCount}</td>
                        <td className="num">
                          {fmt(r.notional)} {r.quote}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="note" style={{ marginTop: 8 }}>
                  Notional is price × remaining quantity, in each pool's own quote asset — not
                  summed across pools since quote currencies differ.
                </p>
              </>
            ) : (
              <Empty text="no open orders for this manager in any pool" />
            )
          ) : (
            <Empty text="inspect a BalanceManager, then scan to aggregate open orders across pools" />
          )}
        </Panel>

        <Panel
          title="TradeCap delegation builder"
          sub="Preview the mint + transfer calls to delegate a role — generates the SDK payload, doesn't execute it"
          right={
            stagedDelegation && (
              <button
                className="btn ghost"
                onClick={() => {
                  navigator.clipboard.writeText(stagedDelegation)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                }}
              >
                {copied ? 'copied!' : 'copy'}
              </button>
            )
          }
        >
          <div className="pill-row">
            {(
              [
                ['owner', 'Owner'],
                ['trader', 'Trader'],
                ['strategist', 'Strategist'],
                ['viewer', 'Viewer'],
              ] as [DelegationRole, string][]
            ).map(([r, label]) => (
              <button key={r} className={`pill ${role === r ? 'on' : ''}`} onClick={() => setRole(r)}>
                {label}
              </button>
            ))}
          </div>
          <label className="fld">
            delegate address
            <input
              value={delegate}
              placeholder="0x…"
              onChange={(e) => setDelegate(e.target.value.trim())}
            />
          </label>
          {!queryId && (
            <p className="note" style={{ marginTop: 8 }}>
              Inspect a BalanceManager above first — that's the manager the delegate would gain
              access to.
            </p>
          )}
          {stagedDelegation ? (
            <pre className="code" style={{ marginTop: 10 }}>
              {stagedDelegation}
            </pre>
          ) : (
            queryId && <Empty text="enter a delegate address to preview the delegation payload" />
          )}
        </Panel>
      </div>

      <div className="screen-grid cols-2">
        <Panel
          className="span-all"
          title={`Live orders ${queryId ? `· ${shortAddr(queryId)}` : ''}`}
          sub={`Open and recent orders for this manager in ${pool}, polled every 10s`}
        >
          {!queryId ? (
            <Empty text="inspect a BalanceManager to see its orders" />
          ) : orders.loading && !orders.data ? (
            <Empty text="loading orders…" />
          ) : orders.data?.length ? (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Placed</th>
                  <th>Order</th>
                  <th>Side</th>
                  <th>Status</th>
                  <th className="num">Price</th>
                  <th className="num">Qty</th>
                  <th className="num">Filled</th>
                  <th className="num">Remaining</th>
                </tr>
              </thead>
              <tbody>
                {orders.data.slice(0, 20).map((o) => (
                  <tr key={o.order_id}>
                    <td>{ago(o.placed_at)}</td>
                    <td title={o.order_id}>{shortAddr(o.order_id, 8, 0)}</td>
                    <td className={o.type === 'buy' ? 'tone-up' : 'tone-down'}>{o.type}</td>
                    <td>
                      <StatusTag status={o.current_status} />
                    </td>
                    <td className="num">{fmt(o.price, 4)}</td>
                    <td className="num">{fmt(o.original_quantity)}</td>
                    <td className="num">{fmt(o.filled_quantity)}</td>
                    <td className="num">{fmt(o.remaining_quantity)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty
              text={
                orders.error
                  ? `indexer error: ${orders.error}`
                  : 'no orders found for this manager in this pool'
              }
              tone={orders.error ? 'error' : undefined}
            />
          )}
        </Panel>

        <Panel
          className="span-all"
          title="On-chain audit log"
          sub={
            queryId
              ? `Order events for ${shortAddr(queryId)} in ${pool}, polled every 15s`
              : `Order events for all managers in ${pool}, polled every 15s — inspect a BalanceManager to filter`
          }
        >
          {auditRows.length ? (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Event</th>
                  <th>Side</th>
                  <th className="num">Price</th>
                  <th className="num">Qty</th>
                  <th className="num">Filled</th>
                  {!queryId && <th>Manager</th>}
                </tr>
              </thead>
              <tbody>
                {auditRows.slice(0, 20).map((o) => (
                  <tr key={`${o.order_id}-${o.timestamp}-${o.status}`}>
                    <td>{clock(o.timestamp)}</td>
                    <td>
                      <StatusTag status={o.status} />
                    </td>
                    <td className={o.type === 'buy' ? 'tone-up' : 'tone-down'}>{o.type}</td>
                    <td className="num">{fmtPrice(o.price)}</td>
                    <td className="num">{fmt(o.original_quantity)}</td>
                    <td className="num">{fmt(o.filled_quantity)}</td>
                    {!queryId && <td title={o.balance_manager_id}>{shortAddr(o.balance_manager_id)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty
              text={
                queryId
                  ? 'no recent order events for this manager in this pool'
                  : 'no recent order events in this pool'
              }
            />
          )}
        </Panel>
      </div>

      <div className="banner">
        <b>Prime brokerage direction:</b> because one BalanceManager works across all pools and
        all three primitives, the desk model scales from "one trader, one bot" to a full
        operating desk: unified balances, delegated execution, per-role risk policies, and
        portfolio-level reporting — without funds ever leaving the owner's object.
      </div>
    </div>
  )
}
