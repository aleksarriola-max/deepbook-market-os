// ---------------------------------------------------------------------------
// DeepBookV3 Indexer client (live mainnet data)
// Docs: https://docs.sui.io/standards/deepbookv3-indexer
// ---------------------------------------------------------------------------

const DIRECT = 'https://deepbook-indexer.mainnet.mystenlabs.com'
const PROXY = '/dbapi' // vite dev proxy fallback (CORS-safe)

let base: string | null = null

async function get<T>(path: string): Promise<T> {
  const tryFetch = async (b: string) => {
    const res = await fetch(`${b}${path}`)
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    return (await res.json()) as T
  }
  if (base) {
    try {
      return await tryFetch(base)
    } catch {
      // Some endpoints lack CORS headers on the direct host even when others
      // succeed (and vice versa for the dev proxy) — retry the other base for
      // this call without re-pinning `base` globally.
      return tryFetch(base === DIRECT ? PROXY : DIRECT)
    }
  }
  try {
    const out = await tryFetch(DIRECT)
    base = DIRECT
    return out
  } catch {
    const out = await tryFetch(PROXY)
    base = PROXY
    return out
  }
}

// ----------------------------- Types --------------------------------------

export interface PoolInfo {
  pool_id: string
  pool_name: string
  base_asset_id: string
  base_asset_decimals: number
  base_asset_symbol: string
  base_asset_name: string
  quote_asset_id: string
  quote_asset_decimals: number
  quote_asset_symbol: string
  quote_asset_name: string
  min_size: number
  lot_size: number
  tick_size: number
}

export interface TickerEntry {
  base_volume: number
  quote_volume: number
  last_price: number
  isFrozen: 0 | 1
}
export type Ticker = Record<string, TickerEntry>

export interface SummaryEntry {
  trading_pairs: string
  quote_currency: string
  base_currency: string
  last_price: number
  lowest_price_24h: number
  highest_price_24h: number
  highest_bid: number
  lowest_ask: number
  base_volume: number
  quote_volume: number
  price_change_percent_24h: number
}

export interface OrderbookSnapshot {
  timestamp: string
  bids: [string, string][]
  asks: [string, string][]
}

export interface Trade {
  trade_id: string
  maker_order_id: string
  taker_order_id: string
  maker_balance_manager_id: string
  taker_balance_manager_id: string
  price: number
  base_volume: number
  quote_volume: number
  timestamp: number // unix ms
  type: 'buy' | 'sell'
  taker_is_bid: boolean
  taker_fee: number
  maker_fee: number
}

export interface OrderUpdate {
  order_id: string
  balance_manager_id: string
  timestamp: number
  original_quantity: number
  remaining_quantity: number
  filled_quantity: number
  price: number
  status: string
  type: string
}

export interface ManagerOrder {
  order_id: string
  balance_manager_id: string
  type: string
  current_status: string
  price: number
  placed_at: number
  last_updated_at: number
  original_quantity: number
  filled_quantity: number
  remaining_quantity: number
}

export type Candle = [number, number, number, number, number, number] // t,o,h,l,c,v

export interface PoolCreatedEvent {
  event_digest: string
  digest: string
  sender: string
  checkpoint: number
  checkpoint_timestamp_ms: number
  pool_id: string
  taker_fee: number
  maker_fee: number
  tick_size: number
  lot_size: number
  min_size: number
  whitelisted_pool: boolean
}

export interface PortfolioView {
  margin_positions: {
    margin_manager_id: string
    pool: string
    base_asset_symbol: string
    quote_asset_symbol: string
    base_asset: number
    quote_asset: number
    base_debt: number
    quote_debt: number
    net_value_usd: number
    total_debt_usd: number
    risk_ratio: number
  }[]
  collateral_balances: { asset: string; balance: number; balance_usd: number }[]
  lp_positions: {
    margin_pool_id: string
    asset: string
    supplied: number
    supplied_usd: number
  }[]
  summary: {
    total_equity_usd: number
    total_debt_usd: number
    net_value_usd: number
  }
}

// --------------------------- Endpoints -------------------------------------

export const indexer = {
  pools: () => get<PoolInfo[]>('/get_pools'),
  ticker: () => get<Ticker>('/ticker'),
  summary: () => get<SummaryEntry[]>('/summary'),
  orderbook: (pool: string, depth = 20) =>
    get<OrderbookSnapshot>(`/orderbook/${pool}?level=2&depth=${depth}`),
  trades: (pool: string, limit = 60) =>
    get<Trade[]>(`/trades/${pool}?limit=${limit}`),
  orderUpdates: (pool: string, limit = 50, status?: 'Placed' | 'Canceled') =>
    get<OrderUpdate[]>(
      `/order_updates/${pool}?limit=${limit}${status ? `&status=${status}` : ''}`,
    ),
  ordersByManager: (pool: string, managerId: string, limit = 50) =>
    get<ManagerOrder[]>(`/orders/${pool}/${managerId}?limit=${limit}`),
  ohlcv: (pool: string, interval = '1h', limit = 96) =>
    get<{ candles: Candle[] }>(`/ohclv/${pool}?interval=${interval}&limit=${limit}`),
  allHistoricalVolume: (startTime?: number, endTime?: number) =>
    get<Record<string, number>>(
      `/all_historical_volume${startTime ? `?start_time=${startTime}&end_time=${endTime}` : ''}`,
    ),
  volumeByManager: (pools: string, managerId: string) =>
    get<Record<string, [number, number]>>(
      `/historical_volume_by_balance_manager_id/${pools}/${managerId}`,
    ),
  poolCreated: () => get<PoolCreatedEvent[]>('/pool_created'),
  marginSupply: () => get<Record<string, number>>('/margin_supply'),
  portfolio: (wallet: string) => get<PortfolioView>(`/portfolio/${wallet}`),
  deepSupply: () => get<{ total_supply: string }>('/deep_supply'),
  tradeCount: (startTime: number, endTime: number) =>
    get<number>(`/trade_count?start_time=${startTime}&end_time=${endTime}`),
}

// ----------------------- Derived analytics helpers -------------------------

/** Annualized volatility estimate from close-to-close log returns. */
export function realizedVol(candles: Candle[], periodsPerYear: number): number {
  const closes = candles.map((c) => c[4]).filter((c) => c > 0)
  if (closes.length < 3) return 0
  const rets: number[] = []
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]))
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length
  const variance = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1)
  return Math.sqrt(variance) * Math.sqrt(periodsPerYear)
}

/** Mid price from an orderbook snapshot. */
export function mid(ob: OrderbookSnapshot | null): number {
  if (!ob || !ob.bids.length || !ob.asks.length) return 0
  return (parseFloat(ob.bids[0][0]) + parseFloat(ob.asks[0][0])) / 2
}

/** Spread in basis points. */
export function spreadBps(ob: OrderbookSnapshot | null): number {
  if (!ob || !ob.bids.length || !ob.asks.length) return 0
  const bid = parseFloat(ob.bids[0][0])
  const ask = parseFloat(ob.asks[0][0])
  const m = (bid + ask) / 2
  return m > 0 ? ((ask - bid) / m) * 10_000 : 0
}

/**
 * Execution-quality score (0-100) for a trade against the book mid at scoring
 * time: penalizes deviation from mid and taker-fee burden. This is the same
 * scoring used by the Execution Analytics screen.
 */
export function executionScore(trade: Trade, refMid: number): number {
  if (refMid <= 0) return 50
  const devBps = (Math.abs(trade.price - refMid) / refMid) * 10_000
  const feeBps = trade.taker_fee * 10_000
  const raw = 100 - devBps * 1.5 - feeBps * 0.5
  return Math.max(0, Math.min(100, raw))
}
