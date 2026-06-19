// ---------------------------------------------------------------------------
// Intent engine: turns high-level trading intents into concrete ladders of
// DeepBook limit/market orders. Pure functions — the Terminal and Strategy
// Builder screens render previews, and lib/deepbook.ts turns rungs into
// on-chain transactions via the official SDK.
// ---------------------------------------------------------------------------

export type IntentKind = 'accumulate' | 'exit' | 'breakout' | 'mean-revert'
export type Side = 'buy' | 'sell'

export interface LadderRung {
  price: number
  quantity: number
  side: Side
  kind: 'limit' | 'stop-limit'
  note: string
}

export interface IntentParams {
  kind: IntentKind
  midPrice: number
  totalQuantity: number
  rungs: number
  /** total width of the ladder, in % of mid */
  widthPct: number
  /** 0 = equal sizing, 1 = heavily weighted to far rungs */
  skew: number
  tickSize?: number
}

export interface IntentPlan {
  label: string
  description: string
  side: Side
  rungs: LadderRung[]
  avgPrice: number
  notional: number
}

function roundToTick(price: number, tick?: number): number {
  if (!tick || tick <= 0) return Number(price.toPrecision(8))
  return Number((Math.round(price / tick) * tick).toPrecision(10))
}

/** Geometric-ish size weights: w_i ∝ (1 + skew * i). */
function weights(n: number, skew: number): number[] {
  const ws = Array.from({ length: n }, (_, i) => 1 + skew * i)
  const sum = ws.reduce((a, b) => a + b, 0)
  return ws.map((w) => w / sum)
}

export function buildIntentPlan(p: IntentParams): IntentPlan {
  const { kind, midPrice, totalQuantity, rungs, widthPct, skew } = p
  const n = Math.max(1, Math.min(20, Math.floor(rungs)))
  const ws = weights(n, skew)
  const width = (widthPct / 100) * midPrice
  const out: LadderRung[] = []

  const make = (
    side: Side,
    priceAt: (i: number) => number,
    kindAt: 'limit' | 'stop-limit',
    noteAt: (i: number) => string,
  ) => {
    for (let i = 0; i < n; i++) {
      out.push({
        price: roundToTick(priceAt(i), p.tickSize),
        quantity: Number((totalQuantity * ws[i]).toPrecision(6)),
        side,
        kind: kindAt,
        note: noteAt(i),
      })
    }
  }

  let side: Side = 'buy'
  let label = ''
  let description = ''

  switch (kind) {
    case 'accumulate':
      side = 'buy'
      label = 'Staged accumulation'
      description =
        'Resting bids laddered below mid; deeper rungs sized larger to reward patience. Fills improve the average entry without crossing the spread.'
      make(
        'buy',
        (i) => midPrice - (width * (i + 1)) / n,
        'limit',
        (i) => `bid rung ${i + 1}/${n}`,
      )
      break
    case 'exit':
      side = 'sell'
      label = 'Gradual exit'
      description =
        'Resting asks laddered above mid to unwind a position passively, capturing maker rebates instead of paying taker fees.'
      make(
        'sell',
        (i) => midPrice + (width * (i + 1)) / n,
        'limit',
        (i) => `ask rung ${i + 1}/${n}`,
      )
      break
    case 'breakout':
      side = 'buy'
      label = 'Buy breakout'
      description =
        'Stop-limit ladder above resistance: orders arm only when price trades through the trigger, then cap slippage with a limit.'
      make(
        'buy',
        (i) => midPrice + (width * (i + 1)) / n,
        'stop-limit',
        (i) => `trigger ${i + 1}/${n} above mid`,
      )
      break
    case 'mean-revert':
      side = 'buy'
      label = 'Mean reversion grid'
      description =
        'Symmetric grid: bids below and asks above mid. Profits from oscillation; inventory risk grows if price trends.'
      for (let i = 0; i < n; i++) {
        const half = Math.ceil(n / 2)
        const j = i % half
        const isBid = i < half
        out.push({
          price: roundToTick(
            isBid ? midPrice - (width * (j + 1)) / half : midPrice + (width * (j + 1)) / half,
            p.tickSize,
          ),
          quantity: Number((totalQuantity / n).toPrecision(6)),
          side: isBid ? 'buy' : 'sell',
          kind: 'limit',
          note: isBid ? `grid bid ${j + 1}` : `grid ask ${j + 1}`,
        })
      }
      break
  }

  const notional = out.reduce((a, r) => a + r.price * r.quantity, 0)
  const qty = out.reduce((a, r) => a + r.quantity, 0)
  return {
    label,
    description,
    side,
    rungs: out,
    avgPrice: qty > 0 ? notional / qty : 0,
    notional,
  }
}

// --------------------- Structured product payoffs ---------------------------

export type LegType = 'spot' | 'margin-long' | 'margin-short' | 'binary-call' | 'binary-put'

export interface ProductLeg {
  type: LegType
  /** strike for binaries; entry price for spot/margin */
  ref: number
  size: number // units of base (spot/margin) or payout units (binary)
  leverage?: number
  premium?: number // cost per unit for binary legs
}

/** Payoff of one leg at settlement price s. */
export function legPayoff(leg: ProductLeg, s: number): number {
  switch (leg.type) {
    case 'spot':
      return (s - leg.ref) * leg.size
    case 'margin-long':
      return (s - leg.ref) * leg.size * (leg.leverage ?? 1)
    case 'margin-short':
      return (leg.ref - s) * leg.size * (leg.leverage ?? 1)
    case 'binary-call':
      return (s >= leg.ref ? leg.size : 0) - (leg.premium ?? 0) * leg.size
    case 'binary-put':
      return (s < leg.ref ? leg.size : 0) - (leg.premium ?? 0) * leg.size
  }
}

export function productPayoff(legs: ProductLeg[], s: number): number {
  return legs.reduce((a, l) => a + legPayoff(l, s), 0)
}

/**
 * Toy binary-option fair value under a lognormal model — stand-in for the
 * Block Scholes oracle that prices DeepBook Predict markets in production.
 */
export function binaryFairValue(
  spot: number,
  strike: number,
  volAnnual: number,
  daysToExpiry: number,
  isCall: boolean,
): number {
  if (spot <= 0 || strike <= 0 || volAnnual <= 0 || daysToExpiry <= 0)
    return isCall ? (spot >= strike ? 1 : 0) : (spot < strike ? 1 : 0)
  const t = daysToExpiry / 365
  const sigma = volAnnual * Math.sqrt(t)
  const d2 = (Math.log(spot / strike) - 0.5 * sigma * sigma) / sigma
  const nd2 = cdf(d2)
  return isCall ? nd2 : 1 - nd2
}

/**
 * Analytic delta of a binary (cash-or-nothing) option under the same
 * lognormal model as binaryFairValue: d/dS[N(d2)] = phi(d2) / (S * sigma * sqrt(t)).
 * A put's fair value is 1 - N(d2), so its delta is the negative of the call's.
 */
export function binaryDelta(
  spot: number,
  strike: number,
  volAnnual: number,
  daysToExpiry: number,
  isCall: boolean,
): number {
  if (spot <= 0 || strike <= 0 || volAnnual <= 0 || daysToExpiry <= 0) return 0
  const t = daysToExpiry / 365
  const sigma = volAnnual * Math.sqrt(t)
  const d2 = (Math.log(spot / strike) - 0.5 * sigma * sigma) / sigma
  const pdf = Math.exp((-d2 * d2) / 2) / Math.sqrt(2 * Math.PI)
  const callDelta = pdf / (spot * sigma)
  return isCall ? callDelta : -callDelta
}

function cdf(x: number): number {
  // Abramowitz & Stegun approximation of the standard normal CDF
  const t = 1 / (1 + 0.2316419 * Math.abs(x))
  const d = 0.3989423 * Math.exp((-x * x) / 2)
  let p =
    d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))))
  if (x > 0) p = 1 - p
  return p
}
