/**
 * Real DeepBookV3 testnet execution — the signing complement to the Smart Terminal.
 * Builds the exact same transactions (`buildCreateBalanceManagerTx`, `buildDepositTx`,
 * `buildLadderTx`, `buildCancelAllTx` from src/lib/deepbook.ts, `buildIntentPlan` from
 * src/lib/strategy.ts) the browser app previews, then signs and submits them.
 *
 * Usage:
 *   1. Get a testnet key + SUI from the faucet (https://faucet.sui.io)
 *   2. cp .env.example .env  and set SUI_PRIVATE_KEY (suiprivkey...)
 *   3. npx tsx scripts/trade.ts setup                       -> creates a BalanceManager
 *   4. set BALANCE_MANAGER_ADDRESS in .env
 *   5. npx tsx scripts/trade.ts deposit <COIN_KEY> <AMOUNT>
 *   6. npx tsx scripts/trade.ts ladder SUI_DBUSDC buy 3 1.5 1
 *      (pool, side, rungs, widthPct, skew[, totalQty]) -> places a real intent ladder
 *   7. npx tsx scripts/trade.ts status SUI_DBUSDC           -> lists open orders
 *   8. npx tsx scripts/trade.ts cancel-all SUI_DBUSDC
 */
import { deepbook, type BalanceManager } from '@mysten/deepbook-v3'
import { SuiGrpcClient } from '@mysten/sui/grpc'
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import {
  BM_KEY,
  buildCreateBalanceManagerTx,
  buildDepositTx,
  buildLadderTx,
  buildCancelAllTx,
} from '../src/lib/deepbook'
import { buildIntentPlan } from '../src/lib/strategy'
import type { ManagerOrder } from '../src/lib/indexer'

const INDEXER = 'https://deepbook-indexer.testnet.mystenlabs.com'

function getKeypair(): Ed25519Keypair {
  const pk = process.env.SUI_PRIVATE_KEY
  if (!pk) throw new Error('Set SUI_PRIVATE_KEY in .env (suiprivkey...)')
  const { scheme, secretKey } = decodeSuiPrivateKey(pk)
  if (scheme !== 'ED25519') throw new Error(`Unsupported scheme: ${scheme}`)
  return Ed25519Keypair.fromSecretKey(secretKey)
}

function makeClient(address: string, balanceManagers?: Record<string, BalanceManager>) {
  return new SuiGrpcClient({
    network: 'testnet',
    baseUrl: 'https://fullnode.testnet.sui.io:443',
  }).$extend(deepbook({ address, balanceManagers }))
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2)
  const keypair = getKeypair()
  const address = keypair.toSuiAddress()
  console.log(`signer: ${address}`)

  if (cmd === 'setup') {
    const client = makeClient(address)
    const tx = buildCreateBalanceManagerTx(client.deepbook)
    const result = await client.core.signAndExecuteTransaction({
      transaction: tx,
      signer: keypair,
      include: { effects: true, objectTypes: true },
    })
    if (result.$kind === 'FailedTransaction') throw new Error('Transaction failed')
    const objectTypes = result.Transaction?.objectTypes ?? {}
    const bm = result.Transaction?.effects?.changedObjects?.find(
      (o) => o.idOperation === 'Created' && objectTypes[o.objectId]?.includes('BalanceManager'),
    )?.objectId
    console.log(`BalanceManager created: ${bm}`)
    console.log(`digest: ${result.Transaction?.digest}`)
    console.log('Add BALANCE_MANAGER_ADDRESS to .env, deposit assets, then run the ladder command.')
    return
  }

  const bmAddress = process.env.BALANCE_MANAGER_ADDRESS
  if (!bmAddress) throw new Error('Run `setup` first and set BALANCE_MANAGER_ADDRESS')
  const client = makeClient(address, { [BM_KEY]: { address: bmAddress } })

  if (cmd === 'deposit') {
    // deposit <COIN_KEY> <AMOUNT>, e.g. deposit DBUSDC 100
    const [coinKey, amount] = args
    const tx = buildDepositTx(client.deepbook, coinKey, Number(amount))
    const res = await client.core.signAndExecuteTransaction({ transaction: tx, signer: keypair })
    if (res.$kind === 'FailedTransaction') throw new Error('Transaction failed')
    console.log(`deposited ${amount} ${coinKey}`)
    console.log(`digest: ${res.Transaction?.digest}`)
    return
  }

  if (cmd === 'ladder') {
    // ladder <POOL_KEY> <buy|sell> <RUNGS> <WIDTH_PCT> <SKEW> [TOTAL_QTY]
    const [
      poolKey = 'SUI_DBUSDC',
      side = 'buy',
      rungsStr = '3',
      widthStr = '1.5',
      skewStr = '0',
      qtyStr = '10',
    ] = args
    const rungs = Number(rungsStr)
    const widthPct = Number(widthStr)
    const skew = Number(skewStr)
    const totalQuantity = Number(qtyStr)

    // live mid from the testnet indexer
    const ob = (await (await fetch(`${INDEXER}/orderbook/${poolKey}?level=1`)).json()) as {
      bids: [string, string][]
      asks: [string, string][]
    }
    const midPrice = (parseFloat(ob.bids[0][0]) + parseFloat(ob.asks[0][0])) / 2
    console.log(`${poolKey} mid: ${midPrice}`)

    const plan = buildIntentPlan({
      kind: side === 'buy' ? 'accumulate' : 'exit',
      midPrice,
      totalQuantity,
      rungs,
      widthPct,
      skew,
    })
    plan.rungs.forEach((r, i) => console.log(`  rung ${i + 1}: ${r.side} ${r.quantity} @ ${r.price}`))

    // one atomic PTB = whole intent ladder
    const tx = buildLadderTx(client.deepbook, poolKey, plan.rungs)
    const res = await client.core.signAndExecuteTransaction({ transaction: tx, signer: keypair })
    if (res.$kind === 'FailedTransaction') throw new Error('Transaction failed')
    console.log(`ladder placed atomically (${plan.rungs.length} rungs)`)
    console.log(`digest: ${res.Transaction?.digest}`)
    return
  }

  if (cmd === 'cancel-all') {
    const [poolKey = 'SUI_DBUSDC'] = args
    const tx = buildCancelAllTx(client.deepbook, poolKey)
    const res = await client.core.signAndExecuteTransaction({ transaction: tx, signer: keypair })
    if (res.$kind === 'FailedTransaction') throw new Error('Transaction failed')
    console.log('all orders canceled')
    console.log(`digest: ${res.Transaction?.digest}`)
    return
  }

  if (cmd === 'status') {
    const [poolKey = 'SUI_DBUSDC'] = args
    const orders = (await (
      await fetch(`${INDEXER}/orders/${poolKey}/${bmAddress}?limit=50`)
    ).json()) as ManagerOrder[]
    if (!orders.length) {
      console.log(`no open orders for ${bmAddress} on ${poolKey}`)
      return
    }
    console.log(`open orders for ${bmAddress} on ${poolKey}:`)
    for (const o of orders) {
      console.log(
        `  ${o.order_id}  ${o.type.padEnd(4)} ${o.current_status.padEnd(10)} ` +
          `price ${o.price}  qty ${o.remaining_quantity}/${o.original_quantity} ` +
          `(filled ${o.filled_quantity})`,
      )
    }
    return
  }

  console.log(
    'commands: setup | deposit <COIN> <AMT> | ladder <POOL> <buy|sell> <RUNGS> <WIDTH%> <SKEW> [QTY] | status <POOL> | cancel-all <POOL>',
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
