DeepBook Market OS — a market operating system built on DeepBookV3 (Sui), composing Spot, Margin, and Predict into one console: execution, accounts, liquidity, structured products, and market creation.

🔗 Live app: https://aleksarriola-max.github.io/deepbook-market-os/
💻 Source: https://github.com/aleksarriola-max/deepbook-market-os

Everything in this demo is reading LIVE data from DeepBookV3's public mainnet indexer — no backend, no mock data. Every analytic (transaction-cost analysis, Kyle's lambda, walk-the-book impact curves, empirical fill probabilities, historical backtests, volatility cones and smiles) is computed client-side from real chain data, with full formulas documented in the repo. The handful of numbers that aren't live (Predict pricing, since Predict is still testnet-only; Vault target APRs) are clearly tagged SIMULATED on screen.

WHAT'S INSIDE
⚡ Smart Execution Terminal — turn a trading intent into an atomic ladder of limit orders, staged as one PTB, with live fill-probability and backtest comparisons against just crossing the spread
♟ Strategy Builder — tunable ladders with empirical touch-probability fills, historical backtesting, and a 48-combination parameter sweep that ranks ladder shapes by expected edge
∑ Execution Analytics — live TCA decomposition, Kyle's lambda with R², exact impact curves, a ≤3-hop smart-route explorer, and a per-trade cost time series
▣ Desk Manager — BalanceManager account model with live orders, volume, and on-chain audit log for any address
◈ Liquidity Vaults — a maker leaderboard computed from live order/trade data
◐ Predict Workspace — binary event market pricing via the d₁/N(d₁) formula, plus an empirical volatility smile and position delta
⬡ Structured Products — compose payoffs across Spot/Margin/Predict legs with a live-updating payoff curve
◎ Portfolio Command — load any wallet's real margin positions and stress-test them against a hypothetical price move
✦ Market Creation Console — live PoolCreated feed and generated SDK code for launching new DeepBook pools

TECH STACK
Vite + React 19 + TypeScript · DeepBookV3 SDK (@mysten/deepbook-v3) · @mysten/sui · hand-rolled SVG charts, no chart library · static frontend deployed on GitHub Pages · optional Supabase sync for saved strategies/positions (opt-in, not required to use the app)

TIMESTAMPS
0:00 Why DeepBook Market OS
0:35 Smart Execution Terminal
1:40 Strategy Builder + ladder sweep
2:35 Execution Analytics
3:30 Desk Manager + Liquidity Vaults
4:00 Predict Workspace + Structured Products
4:55 Portfolio Command + risk stress test
5:30 Market Creation Console + closing

#Sui #DeepBook #DeFi #Web3 #OnChainTrading #Blockchain #Hackathon
