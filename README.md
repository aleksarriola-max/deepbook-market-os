# DeepBook Market OS

**Live: https://aleksarriola-max.github.io/deepbook-market-os/**

A builder console for DeepBookV3 on Sui — one operating layer over Spot, Margin
and Predict. Every screen reads **live data from the public DeepBookV3 mainnet
indexer** (`https://deepbook-indexer.mainnet.mystenlabs.com`) and runs the same
quant analytics that drive the strategy, execution and risk tooling.

The app itself has no backend: it's a static Vite/React/TypeScript bundle
hosted on GitHub Pages, auto-deployed on every push to `main` via
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml). All analytics
(TCA, Kyle's lambda, impact curves, touch-probability models, backtests, vol
cones/smiles, route exploration) run client-side in
[`src/lib/microstructure.ts`](src/lib/microstructure.ts) and
[`src/lib/strategy.ts`](src/lib/strategy.ts) against indexer responses. The
one piece of optional server-side state — saved strategy templates and
Predict positions — is a single Supabase table the browser talks to directly
(see [Cloud persistence](#cloud-persistence-optional) below); nothing else in
the app depends on it.

## Quick start

```bash
npm install
npm run dev       # http://localhost:5173
```

Other commands:

```bash
npm run build     # tsc -b && vite build — must exit 0
npm run lint      # eslint
npm run preview   # serve the production build
```

In dev, requests to `/dbapi/*` are proxied to the mainnet indexer (see
[`vite.config.ts`](vite.config.ts)) so the app keeps working even if the
indexer's CORS policy changes. The client tries the direct indexer URL first
and falls back to the proxy automatically (`src/lib/indexer.ts`).

## Cloud persistence (optional)

Strategy Builder's saved templates and Predict's YES/NO positions sync to a
Supabase table when you type a wallet address into the sidebar field. With no
address entered, both screens behave exactly as a pure client-side app
(in-memory only, nothing leaves the browser) — cloud sync is opt-in, never
required.

This is **not** real wallet authentication — the address is typed, not
signed, and the table's Row Level Security policy is intentionally permissive
(everything stored is paper/simulated trading data, not real funds). See
[`docs/superpowers/specs/2026-06-19-cloud-persistence-design.md`](docs/superpowers/specs/2026-06-19-cloud-persistence-design.md)
for the full design rationale.

To run this locally, copy `.env.example` to `.env.local` and set
`VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` from a Supabase project where
you've run the schema in that spec doc. Without these set, the app silently
falls back to local-only behavior (see `src/lib/supabase.ts`).

## Screens

| Screen | File | What it does |
| --- | --- | --- |
| Market Dashboard | `src/screens/Dashboard.tsx` | Live ticker across every DeepBookV3 pool: 24h volume, active pairs, trade count, 48h sparklines. |
| Smart Execution Terminal | `src/screens/Terminal.tsx` | Live order book + candles; turns an intent ("accumulate", "exit", "breakout", "mean-revert") into a ladder of limit orders, staged as one atomic PTB, with a walk-the-book comparison vs crossing the spread now. |
| Strategy Builder | `src/screens/StrategyBuilder.tsx` | Tunable ladder strategies against the live mid; expected fill rates from an empirical touch-probability model, a backtest of the exact ladder shape over the pool's own OHLC history, and a **ladder sweep** that grid-searches 48 (rungs × width% × skew) combinations and ranks them by expected edge. Templates optionally sync to the cloud (see below). |
| Execution Analytics | `src/screens/Analytics.tsx` | Transaction-cost analysis on the live tape — effective/realized spread, price impact decomposition, Kyle's lambda, exact impact curves, a **≤3-hop smart-route explorer**, and a **TCA time-series chart** plotting effective spread / price impact per trade. |
| Desk Manager | `src/screens/DeskManager.tsx` | BalanceManager account model — paste any mainnet BalanceManager ID to see its open orders, volume and on-chain audit log; TradeCap delegation preview. |
| Liquidity Vaults | `src/screens/Vault.tsx` | Maker leaderboard computed from live order/trade data, alongside illustrative vault strategies (target APR/TVL/utilization marked **SIMULATED**). |
| Predict Workspace | `src/screens/Predict.tsx` | Prices binary event markets from live spot + realized vol via a lognormal stand-in for the Block Scholes oracle (Predict is testnet-only) — all values marked **SIMULATED**, with the d₁/N(d₁) formula shown inline, plus an **empirical vol smile** (realized semivariance skew) and **binary option delta** shown per position. Positions optionally sync to the cloud (see below). |
| Structured Products | `src/screens/Structured.tsx` | Compose payoffs from Spot/Margin/Predict legs; payoff curve recomputes live against the current mid, binary-leg premia marked **SIMULATED**. |
| Portfolio Command | `src/screens/Portfolio.tsx` | Paste a wallet address to load real margin positions, collateral and LP supply from the indexer's `/portfolio` endpoint; stages leverage-defense and allocation-rotation actions; a **risk stress-test slider** recomputes each position's risk ratio under a hypothetical pool-price move and shows the exact % move to liquidation/warning thresholds. |
| Market Creation Console | `src/screens/BuilderConsole.tsx` | Live `PoolCreated` feed from mainnet; generates the SDK snippet for permissionless pool creation and previews a flash-loan PTB to seed both sides of a new book. |

## Quant methodology

All formulas live in [`src/lib/microstructure.ts`](src/lib/microstructure.ts)
(market-microstructure analytics) and [`src/lib/strategy.ts`](src/lib/strategy.ts)
(intent → ladder engine + payoff math). Screens never compute these numbers
themselves — they call these functions with inputs from the polled indexer.

- **`walkBook` / `walkBookQuote` / `impactCurve`** — exact walk-the-book
  execution simulation and slippage curves from visible depth (deterministic,
  not modeled).
- **`tradeCostAnalysis` (TCA)** — effective / realized spread / price-impact
  decomposition per trade (Hasbrouck; SEC Rule 605 definitions), using the
  median tape price within ±90s as the local reference mid. Needs
  `trades.length >= horizon + 4` (horizon defaults to 5); returns `null` on
  thinner tapes.
- **`tcaScore`** — maps effective spread vs the pool's quoted spread to a 0–100
  execution-quality score.
- **`kyleLambda`** — price-impact coefficient (slope of Δmid on signed
  normalized volume) with its regression R².
- **`bookShape`** — quoted spread and depth imbalance near mid.
- **`buildTouchModel` / `expectedFillStats`** — empirical P(touch within a
  horizon) from the distribution of forward OHLC excursions in the pool's own
  history (no distributional assumption), and the resulting expected fill
  quantity/price/rate for a ladder.
- **`backtestLadder`** — replays an exact ladder shape over rolling OHLC
  windows vs the benchmark of crossing the spread immediately.
- **`volCone`** — realized-volatility cone across horizons, from OHLC closes.
- **`volSkew`** — realized semivariance (Barndorff-Nielsen) decomposition of
  squared log-return deviations into downside/upside vol, used to build an
  empirical vol smile instead of one flat ATM sigma per strike.
- **`exploreRoutes`** — simulates every ≤3-hop path (up to two intermediate
  assets) between two assets across DeepBook's shared-liquidity pools,
  walking each leg's real book with taker fees compounded per hop.
- **`buildIntentPlan`** — turns a high-level intent + ladder shape (rungs,
  width %, size skew) into concrete limit-order rungs.
- **`binaryFairValue` / `binaryDelta` / `legPayoff` / `productPayoff`** —
  lognormal d₁/N(d₁) binary pricing and its analytic delta (stand-in for
  Predict's Block Scholes oracle) and structured-product payoff curves.

Numbers that aren't derived this way — Vault target APR/TVL/utilization and
Predict/Structured binary fair values and premia — are estimates and always
carry a visible `SIMULATED`/`SIM` tag next to the number.

## Scripts — testnet execution

[`scripts/trade.ts`](scripts/trade.ts) is the signing complement to the Smart
Terminal: it builds the *same* transactions the browser previews
(`buildCreateBalanceManagerTx`, `buildDepositTx`, `buildLadderTx`,
`buildCancelAllTx` from `src/lib/deepbook.ts`, `buildIntentPlan` from
`src/lib/strategy.ts`) and signs/submits them on Sui testnet.

```bash
cp .env.example .env             # set SUI_PRIVATE_KEY (suiprivkey...)

npx tsx scripts/trade.ts setup                          # creates a BalanceManager
# set BALANCE_MANAGER_ADDRESS in .env to the printed address

npx tsx scripts/trade.ts deposit <COIN_KEY> <AMOUNT>
npx tsx scripts/trade.ts ladder SUI_DBUSDC buy 3 1.5 1  # pool, side, rungs, width%, skew[, qty]
npx tsx scripts/trade.ts status SUI_DBUSDC              # list open orders for the BalanceManager
npx tsx scripts/trade.ts cancel-all SUI_DBUSDC
```

Every command prints the transaction digest and throws if the transaction
fails on-chain.
