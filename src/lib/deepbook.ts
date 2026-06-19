// ---------------------------------------------------------------------------
// Real DeepBookV3 SDK integration (@mysten/deepbook-v3).
//
// The browser app runs in "preview" mode by default: it builds the exact same
// Transaction objects a signer would execute, and renders them as a human-
// readable execution plan. Wire a wallet (e.g. @mysten/dapp-kit) or run
// scripts/trade.ts with a funded testnet key for live execution.
// ---------------------------------------------------------------------------

import { deepbook, type DeepBookClient } from '@mysten/deepbook-v3'
import { SuiGrpcClient } from '@mysten/sui/grpc'
import { Transaction } from '@mysten/sui/transactions'
import type { LadderRung } from './strategy'

export type Network = 'testnet' | 'mainnet'

export interface SessionConfig {
  network: Network
  address: string
  balanceManagerAddress?: string
  balanceManagerTradeCap?: string
}

export const BM_KEY = 'MANAGER_1'

/**
 * Build a DeepBookClient bound to a Sui fullnode for the chosen network,
 * using the official client-extension pattern from the DeepBookV3 SDK docs.
 */
export function makeDeepBookClient(cfg: SessionConfig): DeepBookClient {
  const client = new SuiGrpcClient({
    network: cfg.network,
    baseUrl:
      cfg.network === 'mainnet'
        ? 'https://fullnode.mainnet.sui.io:443'
        : 'https://fullnode.testnet.sui.io:443',
  }).$extend(
    deepbook({
      address: cfg.address,
      balanceManagers: cfg.balanceManagerAddress
        ? {
            [BM_KEY]: {
              address: cfg.balanceManagerAddress,
              tradeCap: cfg.balanceManagerTradeCap,
            },
          }
        : undefined,
    }),
  )
  return client.deepbook
}

/** Tx that creates and shares a new BalanceManager (one-time setup). */
export function buildCreateBalanceManagerTx(db: DeepBookClient): Transaction {
  const tx = new Transaction()
  tx.add(db.balanceManager.createAndShareBalanceManager())
  return tx
}

/** Tx that deposits an asset into the session's BalanceManager. */
export function buildDepositTx(
  db: DeepBookClient,
  coinKey: string,
  amount: number,
): Transaction {
  const tx = new Transaction()
  db.balanceManager.depositIntoManager(BM_KEY, coinKey, amount)(tx)
  return tx
}

/** Single limit order. */
export function buildLimitOrderTx(
  db: DeepBookClient,
  poolKey: string,
  price: number,
  quantity: number,
  isBid: boolean,
  clientOrderId = `${Date.now()}`,
): Transaction {
  const tx = new Transaction()
  db.deepBook.placeLimitOrder({
    poolKey,
    balanceManagerKey: BM_KEY,
    clientOrderId,
    price,
    quantity,
    isBid,
    payWithDeep: true,
  })(tx)
  return tx
}

/** Single market order. */
export function buildMarketOrderTx(
  db: DeepBookClient,
  poolKey: string,
  quantity: number,
  isBid: boolean,
): Transaction {
  const tx = new Transaction()
  db.deepBook.placeMarketOrder({
    poolKey,
    balanceManagerKey: BM_KEY,
    clientOrderId: `${Date.now()}`,
    quantity,
    isBid,
    payWithDeep: true,
  })(tx)
  return tx
}

/**
 * A whole intent ladder as ONE atomic programmable transaction block —
 * every rung lands in the same checkpoint or none do. This is the heart of
 * the Smart Execution Terminal.
 */
export function buildLadderTx(
  db: DeepBookClient,
  poolKey: string,
  rungs: LadderRung[],
): Transaction {
  const tx = new Transaction()
  rungs.forEach((r, i) => {
    db.deepBook.placeLimitOrder({
      poolKey,
      balanceManagerKey: BM_KEY,
      clientOrderId: `${Date.now()}-${i}`,
      price: r.price,
      quantity: r.quantity,
      isBid: r.side === 'buy',
      payWithDeep: true,
    })(tx)
  })
  return tx
}

/** Cancel all open orders for the session manager in a pool. */
export function buildCancelAllTx(db: DeepBookClient, poolKey: string): Transaction {
  const tx = new Transaction()
  db.deepBook.cancelAllOrders(poolKey, BM_KEY)(tx)
  return tx
}

// ------------------------- Plan serialization ------------------------------

export interface PlannedAction {
  module: string
  call: string
  args: Record<string, string | number | boolean>
}

/** Human-readable preview of what a ladder tx will do on-chain. */
export function describeLadder(poolKey: string, rungs: LadderRung[]): PlannedAction[] {
  return rungs.map((r, i) => ({
    module: 'deepbook::pool',
    call: r.kind === 'stop-limit' ? 'place_limit_order (conditional)' : 'place_limit_order',
    args: {
      pool: poolKey,
      balance_manager: BM_KEY,
      client_order_id: `intent-${i}`,
      price: r.price,
      quantity: r.quantity,
      is_bid: r.side === 'buy',
      pay_with_deep: true,
    },
  }))
}

// --------------------------- Delegation builder ----------------------------

export type DelegationRole = 'owner' | 'trader' | 'strategist' | 'viewer'

export interface DelegationPlan {
  role: DelegationRole
  actions: PlannedAction[]
  note: string
}

/** Capability(ies) minted+transferred for each delegated role, per balance_manager module. */
const ROLE_CAPS: Record<DelegationRole, { cap: string; mint: string }[]> = {
  owner: [],
  trader: [{ cap: 'TradeCap', mint: 'mint_trade_cap' }],
  strategist: [
    { cap: 'TradeCap', mint: 'mint_trade_cap' },
    { cap: 'DepositCap', mint: 'mint_deposit_cap' },
  ],
  viewer: [],
}

const ROLE_NOTES: Record<DelegationRole, string> = {
  owner:
    "OwnerCap is fixed at creation and can't be re-minted for an existing manager. " +
    'To give a delegate owner-level control, share a brand-new BalanceManager with them ' +
    'as the custom owner instead of delegating this one.',
  trader: 'TradeCap grants place/cancel rights only — the delegate can never move funds out of the manager.',
  strategist:
    'TradeCap + DepositCap let the strategist deploy ladder templates and top up collateral, ' +
    'but withdrawals still require the owner.',
  viewer:
    'No on-chain capability is minted — viewer access is read-only via the indexer ' +
    '(orders, fills, volume for this manager ID).',
}

/**
 * Builder-mode preview (not executed) of the mint+transfer actions needed to
 * delegate a role on `managerId` to `delegate`. Same JSON-preview pattern as
 * the Terminal's staged PTB.
 */
export function describeDelegation(
  managerId: string,
  role: DelegationRole,
  delegate: string,
): DelegationPlan {
  if (role === 'owner') {
    return {
      role,
      actions: [
        { module: 'balance_manager', call: 'new_with_custom_owner', args: { owner: delegate } },
        { module: 'transfer', call: 'public_share_object', args: { object: '<new BalanceManager>' } },
      ],
      note: ROLE_NOTES.owner,
    }
  }
  const actions: PlannedAction[] = []
  for (const { cap, mint } of ROLE_CAPS[role]) {
    actions.push({ module: 'balance_manager', call: mint, args: { balance_manager: managerId } })
    actions.push({
      module: 'transfer',
      call: 'public_transfer',
      args: { object: `<${cap}>`, recipient: delegate },
    })
  }
  return { role, actions, note: ROLE_NOTES[role] }
}
