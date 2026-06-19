// ---------------------------------------------------------------------------
// Market-microstructure analytics, computed entirely from live DeepBook data.
//
// Everything here is a standard, citable method from the market-microstructure
// literature, applied to DeepBook's transparent on-chain order book:
//
//  - Walk-the-book execution simulation (exact, not modeled)
//  - Price impact curves and resilience
//  - Effective spread / realized spread / price impact decomposition
//    (Hasbrouck; SEC Rule 605 definitions)
//  - Kyle's lambda (price impact coefficient) from the tape
//  - Empirical limit-order touch probabilities from OHLC excursions
//  - Historical ladder backtest vs market-order benchmark
//  - Realized-volatility cone across horizons
//  - Multi-hop route comparison across shared-liquidity pools
// ---------------------------------------------------------------------------

import type { OrderbookSnapshot, Trade, Candle, PoolInfo, OrderUpdate } from './indexer'
import { indexer } from './indexer'
import type { LadderRung } from './strategy'

// ------------------------- Walk-the-book simulation -------------------------

export interface BookWalkResult {
  /** average execution price across consumed levels */
  avgPrice: number
  /** worst (marginal) price touched */
  worstPrice: number
  /** quantity actually fillable from visible depth */
  filledQty: number
  /** requested - filled */
  unfilledQty: number
  /** signed slippage vs mid, in basis points (positive = cost) */
  slippageBps: number
  /** number of price levels consumed */
  levelsConsumed: number
}

/**
 * Exact execution simulation: consume visible L2 depth level by level.
 * This is not a model — it is the deterministic outcome of a marketable
 * order against the current book (ignoring queue changes in flight).
 */
export function walkBook(
  ob: OrderbookSnapshot,
  side: 'buy' | 'sell',
  qty: number,
): BookWalkResult | null {
  const levels = (side === 'buy' ? ob.asks : ob.bids).map(
    ([p, q]) => [parseFloat(p), parseFloat(q)] as [number, number],
  )
  if (!levels.length || !ob.bids.length || !ob.asks.length) return null
  const mid = (parseFloat(ob.bids[0][0]) + parseFloat(ob.asks[0][0])) / 2

  let remaining = qty
  let cost = 0
  let filled = 0
  let worst = levels[0][0]
  let used = 0
  for (const [p, q] of levels) {
    if (remaining <= 0) break
    const take = Math.min(remaining, q)
    cost += take * p
    filled += take
    remaining -= take
    worst = p
    used++
  }
  if (filled === 0) return null
  const avg = cost / filled
  const slip = side === 'buy' ? ((avg - mid) / mid) * 10_000 : ((mid - avg) / mid) * 10_000
  return {
    avgPrice: avg,
    worstPrice: worst,
    filledQty: filled,
    unfilledQty: Math.max(0, remaining),
    slippageBps: slip,
    levelsConsumed: used,
  }
}

/**
 * Walk the ask side with a QUOTE budget (exact, for inverted route hops):
 * consume asks level by level, spending quote until the budget is exhausted.
 */
export function walkBookQuote(
  ob: OrderbookSnapshot,
  quoteBudget: number,
): { baseOut: number; avgPrice: number; quoteSpent: number; exhausted: boolean } | null {
  const asks = ob.asks.map(([p, q]) => [parseFloat(p), parseFloat(q)] as [number, number])
  if (!asks.length) return null
  let remaining = quoteBudget
  let base = 0
  let spent = 0
  for (const [p, q] of asks) {
    if (remaining <= 0) break
    const affordable = remaining / p
    const take = Math.min(affordable, q)
    base += take
    spent += take * p
    remaining -= take * p
  }
  if (base === 0) return null
  return { baseOut: base, avgPrice: spent / base, quoteSpent: spent, exhausted: remaining > 1e-12 }
}

/** Price-impact curve: slippage (bps) as a function of order size. */
export function impactCurve(
  ob: OrderbookSnapshot,
  side: 'buy' | 'sell',
  sizes: number[],
): { size: number; slippageBps: number; fillable: boolean }[] {
  return sizes.map((size) => {
    const r = walkBook(ob, side, size)
    return {
      size,
      slippageBps: r ? r.slippageBps : NaN,
      fillable: !!r && r.unfilledQty === 0,
    }
  })
}

// --------------- Effective / realized spread decomposition ------------------
//
// Standard TCA decomposition (per trade k, mid m_k at trade time, direction
// q_k = +1 taker buy / -1 taker sell, horizon mid m_{k+tau}):
//
//   effective spread_k = 2 * q_k * (p_k - m_k)            (what taker paid)
//   price impact_k     = 2 * q_k * (m_{k+tau} - m_k)      (information content)
//   realized spread_k  = effective - impact               (maker's net edge)
//
// The on-chain tape has no historical book snapshots, so m_k is estimated by
// the midpoint convention used when quote data is unavailable: the median
// trade price inside a +/-window around k (Lee-Ready style local reference).

export interface TradeCostRow {
  trade: Trade
  refMid: number
  effectiveBps: number
  impactBps: number
  realizedBps: number
}

export interface TcaSummary {
  rows: TradeCostRow[]
  avgEffectiveBps: number
  avgImpactBps: number
  avgRealizedBps: number
}

export function tradeCostAnalysis(trades: Trade[], windowMs = 90_000, horizon = 5): TcaSummary | null {
  // tape arrives newest-first; work oldest-first
  const ts = [...trades].sort((a, b) => a.timestamp - b.timestamp)
  if (ts.length < horizon + 4) return null

  const localMid = (i: number): number => {
    const t0 = ts[i].timestamp
    const win = ts.filter((t) => Math.abs(t.timestamp - t0) <= windowMs)
    const prices = win.map((t) => t.price).sort((a, b) => a - b)
    return prices[Math.floor(prices.length / 2)]
  }

  const rows: TradeCostRow[] = []
  for (let i = 0; i < ts.length - horizon; i++) {
    const t = ts[i]
    const m0 = localMid(i)
    const m1 = localMid(i + horizon)
    if (m0 <= 0 || m1 <= 0) continue
    const q = t.taker_is_bid ? 1 : -1
    const eff = ((2 * q * (t.price - m0)) / m0) * 10_000
    const imp = ((2 * q * (m1 - m0)) / m0) * 10_000
    rows.push({ trade: t, refMid: m0, effectiveBps: eff, impactBps: imp, realizedBps: eff - imp })
  }
  if (!rows.length) return null
  const avg = (f: (r: TradeCostRow) => number) => rows.reduce((a, r) => a + f(r), 0) / rows.length
  return {
    rows: rows.reverse(), // newest first for display
    avgEffectiveBps: avg((r) => r.effectiveBps),
    avgImpactBps: avg((r) => r.impactBps),
    avgRealizedBps: avg((r) => r.realizedBps),
  }
}

/**
 * Execution-quality score (0-100) from the TCA decomposition:
 * 100 at zero effective spread, scaled by the pool's own quoted spread so the
 * score is comparable across pools of different liquidity.
 */
export function tcaScore(effectiveBps: number, quotedSpreadBps: number): number {
  const denom = Math.max(quotedSpreadBps, 1)
  return Math.max(0, Math.min(100, 100 - (effectiveBps / denom) * 50))
}

// --------------------------- Maker leaderboard ------------------------------
//
// Liquidity reputation (spec 8.8): for each maker BalanceManager on the recent
// tape, combine depth share, fill persistence and volume-weighted realized
// spread (maker edge) into a single 0-100 reputation score:
//   reputation = 0.4 * depth_share + 0.35 * persistence + 0.25 * logistic(edge / 5)

export interface MakerStat {
  id: string
  fills: number
  baseVol: number
  quoteVol: number
  share: number // 0-1, fraction of tape quote volume
  edgeBps: number | null // volume-weighted realized spread (maker's net capture)
  persistence: number // 0-1, fraction of orders that stayed in the book > 30s
  reputation: number // 0-100
}

export function makerLeaderboard(trades: Trade[], orderUpdates: OrderUpdate[]): MakerStat[] {
  const tca = trades.length ? tradeCostAnalysis(trades) : null
  const edgeByMaker = new Map<string, { w: number; sum: number }>()
  for (const row of tca?.rows ?? []) {
    const k = row.trade.maker_balance_manager_id
    const cur = edgeByMaker.get(k) ?? { w: 0, sum: 0 }
    cur.w += row.trade.quote_volume
    cur.sum += row.realizedBps * row.trade.quote_volume
    edgeByMaker.set(k, cur)
  }

  const byMaker = new Map<string, { fills: number; baseVol: number; quoteVol: number }>()
  for (const t of trades) {
    const k = t.maker_balance_manager_id
    const cur = byMaker.get(k) ?? { fills: 0, baseVol: 0, quoteVol: 0 }
    cur.fills += 1
    cur.baseVol += t.base_volume
    cur.quoteVol += t.quote_volume
    byMaker.set(k, cur)
  }

  // Persistence: group order_updates by order_id, span = last seen timestamp
  // minus first seen timestamp (the "Placed" event is always the earliest for
  // a well-formed order). An order whose span exceeds 30s counts as
  // "persistent" (approx: ignores orders still resting past the polled window).
  const orders = new Map<string, { managerId: string; minTs: number; maxTs: number; hasPlaced: boolean }>()
  for (const u of orderUpdates) {
    const cur = orders.get(u.order_id) ?? {
      managerId: u.balance_manager_id,
      minTs: u.timestamp,
      maxTs: u.timestamp,
      hasPlaced: false,
    }
    cur.minTs = Math.min(cur.minTs, u.timestamp)
    cur.maxTs = Math.max(cur.maxTs, u.timestamp)
    if (u.status === 'Placed') cur.hasPlaced = true
    orders.set(u.order_id, cur)
  }
  const persistByMaker = new Map<string, { total: number; long: number }>()
  for (const o of orders.values()) {
    if (!o.hasPlaced) continue
    const cur = persistByMaker.get(o.managerId) ?? { total: 0, long: 0 }
    cur.total += 1
    if (o.maxTs - o.minTs > 30_000) cur.long += 1
    persistByMaker.set(o.managerId, cur)
  }

  const total = [...byMaker.values()].reduce((a, m) => a + m.quoteVol, 0) || 1
  return [...byMaker.entries()]
    .map(([id, m]) => {
      const e = edgeByMaker.get(id)
      const edgeBps = e && e.w > 0 ? e.sum / e.w : null
      const share = m.quoteVol / total
      const p = persistByMaker.get(id)
      const persistence = p && p.total > 0 ? p.long / p.total : 0
      const edgeScore = edgeBps == null ? 0.5 : 1 / (1 + Math.exp(-edgeBps / 5))
      return {
        id,
        ...m,
        share,
        edgeBps,
        persistence,
        reputation: 100 * (0.4 * share + 0.35 * persistence + 0.25 * edgeScore),
      }
    })
    .sort((a, b) => b.quoteVol - a.quoteVol)
}

// ----------------------------- Kyle's lambda --------------------------------
//
// Lambda from the canonical regression dp_k = lambda * (q_k * v_k) + e over
// consecutive tape prints, where v is base volume and q the taker direction.
// Reported as bps of price move per 1% of observed tape volume, plus R^2.

export function kyleLambda(trades: Trade[]): { lambdaBpsPerPct: number; r2: number; n: number } | null {
  const ts = [...trades].sort((a, b) => a.timestamp - b.timestamp)
  if (ts.length < 10) return null
  const totalVol = ts.reduce((a, t) => a + t.base_volume, 0)
  if (totalVol <= 0) return null

  const xs: number[] = []
  const ys: number[] = []
  for (let i = 1; i < ts.length; i++) {
    const dp = (ts[i].price - ts[i - 1].price) / ts[i - 1].price // relative move
    const sv = ((ts[i].taker_is_bid ? 1 : -1) * ts[i].base_volume) / totalVol // signed, normalized
    xs.push(sv)
    ys.push(dp)
  }
  const n = xs.length
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my)
    sxx += (xs[i] - mx) ** 2
    syy += (ys[i] - my) ** 2
  }
  if (sxx === 0 || syy === 0) return null
  const beta = sxy / sxx
  const r2 = (sxy * sxy) / (sxx * syy)
  // beta: relative move per unit (signed vol / total vol). Convert:
  // per 1% of tape volume -> beta * 0.01; in bps -> * 10000.
  return { lambdaBpsPerPct: beta * 0.01 * 10_000, r2, n }
}

// ------------------- Empirical touch probabilities --------------------------
//
// P(limit order at distance d is touched within T hours), estimated from the
// empirical distribution of forward extreme excursions in hourly OHLC data:
// for each rolling window of T candles, the max adverse/favorable excursion
// relative to the window's opening price. No distributional assumption.

export interface TouchModel {
  horizonHours: number
  samples: number
  /** P(price trades at or below open*(1-d)) for d in distancesPct */
  pTouchBelow: (distPct: number) => number
  /** P(price trades at or above open*(1+d)) */
  pTouchAbove: (distPct: number) => number
}

export function buildTouchModel(candles: Candle[], horizonHours: number): TouchModel | null {
  const cs = candles.filter((c) => c[4] > 0 && c[1] > 0)
  if (cs.length < horizonHours + 8) return null
  const downEx: number[] = [] // max % drop below window open
  const upEx: number[] = [] // max % rise above window open
  for (let i = 0; i + horizonHours <= cs.length; i++) {
    const open = cs[i][1]
    let lo = Infinity
    let hi = -Infinity
    for (let j = i; j < i + horizonHours; j++) {
      lo = Math.min(lo, cs[j][3])
      hi = Math.max(hi, cs[j][2])
    }
    downEx.push((open - lo) / open)
    upEx.push((hi - open) / open)
  }
  const frac = (arr: number[], d: number) => arr.filter((x) => x >= d).length / arr.length
  return {
    horizonHours,
    samples: downEx.length,
    pTouchBelow: (distPct) => frac(downEx, distPct / 100),
    pTouchAbove: (distPct) => frac(upEx, distPct / 100),
  }
}

export interface ExpectedFillStats {
  expectedQty: number
  avgFillPrice: number
  fillRate: number
  probs: number[]
  distPcts: number[]
  samples: number
}

/**
 * Expected-value summary of a ladder against a touch model: per-rung touch
 * probability and distance from mid, expected filled quantity/notional, and
 * the overall fill rate relative to the ladder's total quantity.
 */
export function expectedFillStats(
  rungs: LadderRung[],
  touchModel: TouchModel,
  midPrice: number,
  totalQuantity: number,
): ExpectedFillStats {
  let expectedQty = 0
  let expectedNotional = 0
  const probs: number[] = []
  const distPcts: number[] = []
  for (const r of rungs) {
    const distPct = (Math.abs(r.price - midPrice) / midPrice) * 100
    const pTouch =
      r.side === 'buy' ? touchModel.pTouchBelow(distPct) : touchModel.pTouchAbove(distPct)
    probs.push(pTouch)
    distPcts.push(distPct)
    expectedQty += r.quantity * pTouch
    expectedNotional += r.quantity * pTouch * r.price
  }
  return {
    expectedQty,
    avgFillPrice: expectedQty > 0 ? expectedNotional / expectedQty : 0,
    fillRate: totalQuantity > 0 ? expectedQty / totalQuantity : 0,
    probs,
    distPcts,
    samples: touchModel.samples,
  }
}

// ------------------------ Historical ladder backtest -------------------------
//
// Backtests the EXACT ladder shape (per-rung % offsets + size weights) over
// rolling OHLC windows of the pool's own history, against the benchmark of
// crossing the spread immediately at window open (half quoted spread + taker
// fee). A rung fills in a window iff the window's extreme excursion reaches
// its offset — the same touch criterion as the fill model, so the backtest
// and the forward estimate are mutually consistent.

export interface LadderBacktest {
  windows: number
  /** mean fraction of ladder quantity filled per window */
  fillRateAvg: number
  /** fraction of windows where at least one rung filled */
  anyFillRate: number
  /** entry improvement vs benchmark (bps), conditional on >=1 fill */
  improvementBpsAvg: number
  improvementBpsMedian: number
  improvementBpsP10: number
  improvementBpsP90: number
  /** fraction of filled windows where the ladder beat the benchmark */
  winRate: number
}

export function backtestLadder(
  candles: Candle[],
  offsetsPct: number[],
  weights: number[],
  side: 'buy' | 'sell',
  rungsAboveRef: boolean, // breakout ladders sit on the far side of the reference
  horizonHours: number,
  benchCostBps: number,
): LadderBacktest | null {
  const cs = candles.filter((c) => c[4] > 0 && c[1] > 0)
  if (cs.length < horizonHours + 12 || !offsetsPct.length) return null
  const step = Math.max(1, Math.floor(horizonHours / 4)) // reduce window overlap

  let windows = 0
  let fillRateSum = 0
  let anyFill = 0
  const improvements: number[] = []

  for (let i = 0; i + horizonHours <= cs.length; i += step) {
    const ref = cs[i][1] // window open
    let lo = Infinity
    let hi = -Infinity
    for (let j = i; j < i + horizonHours; j++) {
      lo = Math.min(lo, cs[j][3])
      hi = Math.max(hi, cs[j][2])
    }
    windows++

    let filledW = 0
    let costW = 0
    for (let k = 0; k < offsetsPct.length; k++) {
      const d = offsetsPct[k] / 100
      // rung price relative to reference open
      const rungPrice =
        side === 'buy'
          ? rungsAboveRef
            ? ref * (1 + d) // stop-style entry above reference
            : ref * (1 - d) // resting bid below reference
          : ref * (1 + d) // resting ask above reference
      const touched =
        side === 'buy' ? (rungsAboveRef ? hi >= rungPrice : lo <= rungPrice) : hi >= rungPrice
      if (touched) {
        filledW += weights[k]
        costW += weights[k] * rungPrice
      }
    }
    fillRateSum += filledW
    if (filledW > 0) {
      anyFill++
      const ladderAvg = costW / filledW
      const bench =
        side === 'buy' ? ref * (1 + benchCostBps / 10_000) : ref * (1 - benchCostBps / 10_000)
      const imp =
        side === 'buy' ? ((bench - ladderAvg) / ref) * 10_000 : ((ladderAvg - bench) / ref) * 10_000
      improvements.push(imp)
    }
  }
  if (!windows || !improvements.length) return null
  const sorted = [...improvements].sort((a, b) => a - b)
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
  return {
    windows,
    fillRateAvg: fillRateSum / windows,
    anyFillRate: anyFill / windows,
    improvementBpsAvg: improvements.reduce((a, b) => a + b, 0) / improvements.length,
    improvementBpsMedian: q(0.5),
    improvementBpsP10: q(0.1),
    improvementBpsP90: q(0.9),
    winRate: improvements.filter((x) => x > 0).length / improvements.length,
  }
}

// --------------------------- Volatility cone ---------------------------------

export interface VolPoint {
  label: string
  windowHours: number
  volAnnual: number
  samples: number
}

/** Realized-vol cone from hourly closes at several horizons. */
export function volCone(candles: Candle[]): VolPoint[] {
  const closes = candles.filter((c) => c[4] > 0).map((c) => c[4])
  const out: VolPoint[] = []
  const horizons: [string, number][] = [
    ['6h', 6],
    ['24h', 24],
    ['3d', 72],
    ['full window', closes.length - 1],
  ]
  for (const [label, h] of horizons) {
    if (closes.length < h + 2) continue
    const slice = closes.slice(-(h + 1))
    const rets: number[] = []
    for (let i = 1; i < slice.length; i++) rets.push(Math.log(slice[i] / slice[i - 1]))
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length
    const v = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / Math.max(1, rets.length - 1)
    out.push({ label, windowHours: h, volAnnual: Math.sqrt(v) * Math.sqrt(24 * 365), samples: rets.length })
  }
  return out
}

export interface VolSkew {
  downVolAnnual: number
  upVolAnnual: number
  samples: number
}

/**
 * Realized semivariance skew (Barndorff-Nielsen et al.): split squared
 * log-return deviations by sign and annualize each half separately, using the
 * same hourly-candle convention as volCone. A persistent gap between the two
 * halves is the empirical analogue of a volatility skew — no option market
 * needed, since it comes straight from the pool's own price history.
 */
export function volSkew(candles: Candle[]): VolSkew | null {
  const closes = candles.filter((c) => c[4] > 0).map((c) => c[4])
  if (closes.length < 10) return null
  const rets: number[] = []
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]))
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length
  let downSq = 0
  let upSq = 0
  for (const r of rets) {
    const d = r - mean
    if (d < 0) downSq += d * d
    else upSq += d * d
  }
  const n = Math.max(1, rets.length - 1)
  const annualize = 24 * 365
  return {
    downVolAnnual: Math.sqrt((downSq / n) * annualize),
    upVolAnnual: Math.sqrt((upSq / n) * annualize),
    samples: rets.length,
  }
}

// ------------------------- Multi-hop route explorer --------------------------
//
// DeepBook's pools share one venue, so any asset pair connected through one or
// two intermediate assets defines an executable route. For a target trade we
// simulate every route <= 3 hops by walking each leg's real book and
// compounding fees.

export interface RouteLeg {
  pool: string
  side: 'buy' | 'sell'
  avgPrice: number
  slippageBps: number
}

export interface RouteQuote {
  path: string[] // asset symbols, e.g. ['SUI','USDC'] or ['SUI','DEEP','USDC']
  legs: RouteLeg[]
  /** quote received per base unit, after slippage and taker fees */
  effectivePrice: number
  totalSlippageBps: number
  totalFeeBps: number
  fillable: boolean
}

const TAKER_FEE_BPS = 10 // 0.10% standard taker fee; DEEP-paid fees are lower

export async function exploreRoutes(
  pools: PoolInfo[],
  baseSymbol: string,
  quoteSymbol: string,
  side: 'buy' | 'sell',
  qty: number,
): Promise<RouteQuote[]> {
  const bySymbols = new Map<string, PoolInfo>()
  for (const p of pools) bySymbols.set(`${p.base_asset_symbol}/${p.quote_asset_symbol}`, p)

  const findPool = (a: string, b: string): { pool: PoolInfo; inverted: boolean } | null => {
    const direct = bySymbols.get(`${a}/${b}`)
    if (direct) return { pool: direct, inverted: false }
    const inv = bySymbols.get(`${b}/${a}`)
    if (inv) return { pool: inv, inverted: true }
    return null
  }

  // candidate intermediate assets: anything that has pools with both legs
  const symbols = new Set<string>()
  for (const p of pools) {
    symbols.add(p.base_asset_symbol)
    symbols.add(p.quote_asset_symbol)
  }
  const paths: string[][] = []
  if (findPool(baseSymbol, quoteSymbol)) paths.push([baseSymbol, quoteSymbol])
  for (const mid of symbols) {
    if (mid === baseSymbol || mid === quoteSymbol) continue
    if (findPool(baseSymbol, mid) && findPool(mid, quoteSymbol))
      paths.push([baseSymbol, mid, quoteSymbol])
  }
  // 3-hop paths: base -> mid1 -> mid2 -> quote, via two distinct intermediates.
  for (const mid1 of symbols) {
    if (mid1 === baseSymbol || mid1 === quoteSymbol) continue
    if (!findPool(baseSymbol, mid1)) continue
    for (const mid2 of symbols) {
      if (mid2 === baseSymbol || mid2 === quoteSymbol || mid2 === mid1) continue
      if (findPool(mid1, mid2) && findPool(mid2, quoteSymbol))
        paths.push([baseSymbol, mid1, mid2, quoteSymbol])
    }
  }

  const quotes: RouteQuote[] = []
  for (const path of paths.slice(0, 8)) {
    try {
      const legs: RouteLeg[] = []
      let amount = qty // amount of current asset flowing through the route
      let fillable = true
      let feeBps = 0
      for (let i = 0; i < path.length - 1; i++) {
        const hop = findPool(path[i], path[i + 1])
        if (!hop) throw new Error('no pool')
        const ob = await indexer.orderbook(hop.pool.pool_name, 40)
        // selling path[i] for path[i+1]:
        //  - if pool is BASE=path[i]/QUOTE=path[i+1]: sell base (hit bids)
        //  - if inverted (BASE=path[i+1]/QUOTE=path[i]): buy base with quote
        if (!hop.inverted) {
          const r = walkBook(ob, 'sell', amount)
          if (!r) throw new Error('empty book')
          if (r.unfilledQty > 0) fillable = false
          legs.push({
            pool: hop.pool.pool_name,
            side: 'sell',
            avgPrice: r.avgPrice,
            slippageBps: r.slippageBps,
          })
          amount = r.filledQty * r.avgPrice
        } else {
          // we hold quote of this pool; buy base with the exact quote budget
          const r = walkBookQuote(ob, amount)
          if (!r) throw new Error('empty book')
          if (r.exhausted) fillable = false
          const bb = parseFloat(ob.bids[0]?.[0] ?? '0')
          const ba = parseFloat(ob.asks[0]?.[0] ?? '0')
          const midHop = bb > 0 && ba > 0 ? (bb + ba) / 2 : r.avgPrice
          legs.push({
            pool: hop.pool.pool_name,
            side: 'buy',
            avgPrice: r.avgPrice,
            slippageBps: midHop > 0 ? ((r.avgPrice - midHop) / midHop) * 10_000 : 0,
          })
          amount = r.baseOut
        }
        feeBps += TAKER_FEE_BPS
        amount *= 1 - TAKER_FEE_BPS / 10_000
      }
      const effectivePrice = amount / qty
      quotes.push({
        path,
        legs,
        effectivePrice,
        totalSlippageBps: legs.reduce((a, l) => a + Math.max(0, l.slippageBps), 0),
        totalFeeBps: feeBps,
        fillable,
      })
    } catch {
      // route not quotable right now — skip silently
    }
  }
  // side: for a sell of base, higher effective price is better (more quote out)
  return quotes.sort((a, b) =>
    side === 'sell' ? b.effectivePrice - a.effectivePrice : a.effectivePrice - b.effectivePrice,
  )
}

// --------------------------- Book shape metrics ------------------------------

export interface BookShape {
  /** (bidDepth - askDepth) / (bidDepth + askDepth) within +/-50bps of mid */
  imbalance: number
  bidDepthQuote: number
  askDepthQuote: number
  quotedSpreadBps: number
}

export function bookShape(ob: OrderbookSnapshot, bandBps = 50): BookShape | null {
  if (!ob.bids.length || !ob.asks.length) return null
  const bb = parseFloat(ob.bids[0][0])
  const ba = parseFloat(ob.asks[0][0])
  const mid = (bb + ba) / 2
  const lo = mid * (1 - bandBps / 10_000)
  const hi = mid * (1 + bandBps / 10_000)
  const bid = ob.bids
    .map(([p, q]) => [parseFloat(p), parseFloat(q)])
    .filter(([p]) => p >= lo)
    .reduce((a, [p, q]) => a + p * q, 0)
  const ask = ob.asks
    .map(([p, q]) => [parseFloat(p), parseFloat(q)])
    .filter(([p]) => p <= hi)
    .reduce((a, [p, q]) => a + p * q, 0)
  return {
    imbalance: bid + ask > 0 ? (bid - ask) / (bid + ask) : 0,
    bidDepthQuote: bid,
    askDepthQuote: ask,
    quotedSpreadBps: ((ba - bb) / mid) * 10_000,
  }
}
