# Demo Video Narration Script

For a silent screen recording with voiceover added afterward. Timestamps are
approximate targets (~140 words/minute) — record the screen actions to match
the pacing of each section, then read the narration over it. Total runtime:
~6 minutes.

Live app: https://aleksarriola-max.github.io/deepbook-market-os/

---

## 0:00–0:35 — Opening / why this fits the DeepBook track

**[Screen: Market Dashboard, freshly loaded]**

> DeepBookV3 is Sui's shared, builder-facing central limit order book — one
> order book that every app on Sui can build on top of. It's not a product
> by itself, it's infrastructure. This is DeepBook Market OS: an operating
> layer on top of that infrastructure, turning DeepBook's Spot, Margin, and
> Predict primitives into execution tools, account management, liquidity
> analytics, structured products, and market creation — all in one console.
>
> Everything you're about to see is reading live data, right now, from
> DeepBook's public mainnet indexer. There's no backend serving this data —
> it's a static site, and every number on screen is either pulled straight
> from the chain or computed client-side from chain data, using the same
> market-microstructure formulas a real trading desk would use.

---

## 0:35–1:40 — Layer 1: Smart Execution Terminal (the flagship)

**[Screen: navigate to Smart Terminal, show order book + candles, then build a ladder intent]**

> Let's start with the flagship: the Smart Execution Terminal. This is a
> live order book and price chart for any DeepBook pool. But instead of
> placing one order at a time, you express an intent — accumulate, exit,
> breakout, or mean-revert — and the terminal turns that intent into a
> ladder of limit orders spread around the live mid price.
>
> [click through ladder generation]
>
> Every rung in this ladder is a real limit order, staged as one atomic
> programmable transaction block — so the whole ladder either lands
> on-chain together, or not at all. And before you commit to it, the
> terminal shows you exactly how this ladder would have performed against
> simply crossing the spread right now — so you can see the trade-off
> between patience and certainty before you take it.

---

## 1:40–2:35 — Strategy Builder + the ladder sweep

**[Screen: Strategy Builder, show parameters, ladder visualization, then click "Run sweep"]**

> Strategy Builder takes that same ladder concept and makes it
> systematic. Tune the rungs, the width around mid, and the size skew, and
> the screen shows you an empirical fill probability for every rung — not
> a theoretical model, but the actual distribution of how far this pool's
> price has moved in rolling windows of its own history.
>
> Then there's the backtest: this exact ladder shape, replayed over the
> pool's real OHLC history, compared against just crossing the spread
> immediately every time. And if you want to go further —
>
> [click "Run sweep", show results table]
>
> — the ladder sweep grid-searches forty-eight combinations of rungs,
> width, and skew, backtests every single one against this pool's own
> history, and ranks them by expected edge: fill rate times entry
> improvement. One click applies the best-performing shape directly to
> your live ladder.

---

## 2:35–3:30 — Execution Analytics

**[Screen: Analytics — TCA table, impact curve, route explorer, TCA time series chart]**

> Execution Analytics is where the quant methodology lives. Every trade on
> the live tape gets decomposed into effective spread, price impact, and
> realized spread — the same framework used in academic market
> microstructure research and in SEC Rule 605 execution-quality reporting.
> Kyle's lambda — the price-impact coefficient — is estimated live from the
> tape, with its regression R-squared shown right next to it, so you know
> exactly how much to trust the number on a thin tape versus a busy one.
>
> [scroll to impact curve, then route explorer]
>
> This impact curve isn't a model — it's the exact result of walking the
> visible order book at increasing trade sizes. And the smart route
> explorer simulates every path up to three hops between two assets across
> DeepBook's shared liquidity, walking each leg's real book and compounding
> taker fees, so you can see exactly why one route beats another.
>
> [scroll to TCA time series chart]
>
> And this chart tracks effective spread and price impact per trade, oldest
> to newest, so you can watch execution quality evolve over the session
> instead of only seeing a single averaged number.

---

## 3:30–4:00 — Desk Manager + Liquidity Vaults (Layer 2)

**[Screen: Desk Manager — paste a BalanceManager address; then Vault — leaderboard]**

> Layer two is accounts and liquidity. Desk Manager is built around
> DeepBook's BalanceManager — the shared account abstraction that lets
> multiple strategies and delegated traders operate from the same capital
> pool. Paste any real mainnet BalanceManager address and see its open
> orders, trading volume, and full on-chain audit trail.
>
> Liquidity Vaults computes a maker leaderboard directly from live order
> and trade data — ranking makers by depth share, quoting persistence, and
> realized edge — real numbers from the chain, sitting alongside
> illustrative vault strategies that are clearly tagged SIMULATED wherever
> the number isn't derived from live data.

---

## 4:00–4:55 — Predict Workspace + Structured Products (Layer 3)

**[Screen: Predict — market builder, vol smile chart, positions table with delta]**

> Layer three is advanced products. DeepBook Predict brings binary options
> on-chain, priced by a Block Scholes oracle — it's testnet-only today, so
> this workspace prices candidate markets from live spot price and realized
> volatility using the same d-one, N-of-d-one formula the production oracle
> uses, with every simulated number clearly tagged.
>
> [point to vol smile chart and table]
>
> Instead of pricing every strike off one flat volatility number, this
> screen computes an empirical volatility smile — splitting realized
> volatility into its downside and upside components using a real
> statistical decomposition, so out-of-the-money strikes get a more honest
> price. And every position you open shows its delta — the analytic
> sensitivity of that position's value to a one-unit move in the underlying
> spot price.
>
> [switch to Structured Products]
>
> Structured Products composes payoffs from spot, margin, and Predict legs
> into one combined position, with the payoff curve recomputing live
> against the current market price as you add legs.

---

## 4:55–5:30 — Portfolio Command + risk stress test (Layer 4)

**[Screen: Portfolio — load a wallet, scroll to risk stress test slider]**

> Layer four is portfolio command. Paste a real wallet address and the
> indexer's portfolio endpoint returns that wallet's actual margin
> positions, collateral, and lending-pool supply.
>
> [drag the stress-test slider]
>
> This risk stress-test slider lets you ask "what if this pool's price
> moved twenty percent against me right now" — and recomputes every margin
> position's risk ratio at that hypothetical price, live, along with the
> exact percentage move that would put each position at its liquidation or
> warning threshold. It's derived purely from the position's own on-chain
> balances, not from any external price assumption.

---

## 5:30–5:55 — Market Creation Console (Layer 5) + closing

**[Screen: Builder Console — live PoolCreated feed, SDK snippet]**

> And layer five is for builders themselves: a live feed of every pool
> created on DeepBookV3, plus generated SDK code for launching a new
> permissionless pool and seeding both sides of the book with a flash loan
> — DeepBook helping you build the next thing on DeepBook.

**[Screen: back to Dashboard, or a quick montage]**

> Every screen you've seen reads live chain data through the public
> indexer, computes its analytics with documented, citable formulas, and
> clearly tags the handful of numbers that are illustrative rather than
> live. The whole thing runs as a static site with no backend of its own —
> the only server-side piece is an optional, opt-in sync for saved
> strategies and paper positions, so your work follows you across devices
> if you choose to use it.
>
> This is DeepBook Market OS — thank you for watching.

---

## Notes for recording

- Record each section's screen actions in a single continuous take where
  possible, matching the bracketed `[Screen: ...]` cues above — easier to
  re-sync narration afterward than many short clips.
- The live mainnet indexer means numbers (prices, volumes, vol estimates)
  will differ from any example values discussed during planning — that's
  expected and is itself part of the pitch ("this is live, not a fixture").
- If any screen needs a specific wallet/BalanceManager address to look
  populated (Desk Manager, Portfolio), grab a real, currently-active one
  from the Market Dashboard's order activity stream shortly before
  recording, since address activity changes over time.
