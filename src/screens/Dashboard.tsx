import { usePoll, useLoad } from '../lib/hooks'
import { indexer } from '../lib/indexer'
import { useSession } from '../lib/session'
import { fmt, fmtPrice, fmtUsd, fmtPct } from '../lib/format'
import { Panel, Stat, LiveBadge, Empty } from '../components/ui'
import { Sparkline } from '../components/charts'

/**
 * Layer 1 — Market Dashboard.
 * Every number on this screen is live from the public DeepBookV3 indexer.
 */
export function Dashboard() {
  const { setPool } = useSession()
  const summary = usePoll(() => indexer.summary(), 10_000)
  const sparks = useLoad(async () => {
    const top = ['SUI_USDC', 'DEEP_USDC', 'WAL_USDC', 'DEEP_SUI', 'USDT_USDC', 'XBTC_USDC']
    const out: Record<string, number[]> = {}
    await Promise.all(
      top.map(async (p) => {
        try {
          const { candles } = await indexer.ohlcv(p, '1h', 48)
          out[p] = candles.map((c) => c[4]).filter((c) => c > 0)
        } catch {
          out[p] = []
        }
      }),
    )
    return out
  })
  const dayAgo = Math.floor(Date.now() / 1000) - 86400
  const tradeCount = useLoad(() => indexer.tradeCount(dayAgo, Math.floor(Date.now() / 1000)))

  const rows = (summary.data ?? [])
    .filter((s) => s.quote_volume > 0 || s.last_price > 0)
    .sort((a, b) => b.quote_volume - a.quote_volume)

  const totalQuoteVol = rows
    .filter((r) => r.quote_currency.includes('USD'))
    .reduce((a, r) => a + r.quote_volume, 0)
  const activePairs = rows.filter((r) => r.quote_volume > 0).length

  return (
    <div>
      <div className="screen-head">
        <h2>Market Dashboard</h2>
        <p>Shared liquidity across every DeepBookV3 pool on Sui mainnet</p>
        <LiveBadge ok={!summary.error && !!summary.data} />
      </div>

      <div className="stat-row">
        <Stat label="24h volume (USD pairs)" value={fmtUsd(totalQuoteVol)} tone="up" />
        <Stat label="Active pairs (24h)" value={activePairs} />
        <Stat label="Listed pairs" value={summary.data?.length ?? '—'} />
        <Stat label="Trades (24h, all pools)" value={fmt(tradeCount.data ?? null, 0)} />
      </div>

      <div className="screen-grid">
        <Panel
          title="All markets"
          sub="Click a row to load it in the Smart Terminal. Sorted by 24h quote volume."
        >
          {rows.length === 0 ? (
            <Empty
              text={summary.error ? `indexer error: ${summary.error}` : 'loading live markets…'}
              tone={summary.error ? 'error' : undefined}
            />
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Pair</th>
                  <th className="num">Last</th>
                  <th className="num">24h %</th>
                  <th className="num">Bid / Ask</th>
                  <th className="num">24h volume</th>
                  <th className="num">Trend (48h)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.trading_pairs}
                    className="clickable"
                    onClick={() => setPool(r.trading_pairs)}
                    title="Open in Smart Terminal"
                  >
                    <td>
                      <b>{r.base_currency}</b>
                      <span style={{ color: 'var(--muted)' }}>/{r.quote_currency}</span>
                    </td>
                    <td className="num">{fmtPrice(r.last_price)}</td>
                    <td
                      className={`num ${r.price_change_percent_24h >= 0 ? 'tone-up' : 'tone-down'}`}
                    >
                      {fmtPct(r.price_change_percent_24h)}
                    </td>
                    <td className="num">
                      {fmtPrice(r.highest_bid)} / {fmtPrice(r.lowest_ask)}
                    </td>
                    <td className="num">
                      {fmt(r.quote_volume)} {r.quote_currency}
                    </td>
                    <td className="num">
                      <Sparkline values={sparks.data?.[r.trading_pairs] ?? []} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>

      <div className="banner">
        <b>Why this matters:</b> DeepBookV3 is a builder-facing CLOB — one shared order book
        serving every app on Sui. The Market OS treats it as an operating layer: the screens to
        the left compose its Spot, Margin and Predict primitives into execution, account,
        liquidity and market-creation tooling.
      </div>
    </div>
  )
}
