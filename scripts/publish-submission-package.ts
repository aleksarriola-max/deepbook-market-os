import { readFileSync } from 'node:fs'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography'
import { SuiGrpcClient } from '@mysten/sui/grpc'
import { Transaction } from '@mysten/sui/transactions'

const raw = process.env.SUI_DEPLOY_PRIVATE_KEY
if (!raw) throw new Error('SUI_DEPLOY_PRIVATE_KEY not set in .env.local')

const network = (process.argv[2] as 'mainnet' | 'testnet') ?? 'testnet'
const baseUrl =
  network === 'mainnet' ? 'https://fullnode.mainnet.sui.io:443' : 'https://fullnode.testnet.sui.io:443'

const { scheme, secretKey } = decodeSuiPrivateKey(raw)
if (scheme !== 'ED25519') throw new Error(`Unsupported scheme: ${scheme}`)
const keypair = Ed25519Keypair.fromSecretKey(secretKey)
const address = keypair.toSuiAddress()

const build = JSON.parse(readFileSync('move/deepbook_market_os/build-output.json', 'utf8')) as {
  modules: string[]
  dependencies: string[]
}

const client = new SuiGrpcClient({ network, baseUrl })

const tx = new Transaction()
const [upgradeCap] = tx.publish({
  modules: build.modules,
  dependencies: build.dependencies,
})
tx.transferObjects([upgradeCap], address)

console.log(`Publishing on ${network} as ${address}...`)
const result = await client.signAndExecuteTransaction({
  transaction: tx,
  signer: keypair,
  include: { effects: true, objectTypes: true },
})

if (result.$kind === 'FailedTransaction') {
  console.error(result)
  throw new Error('Publish transaction failed')
}

const objectTypes = result.Transaction?.objectTypes ?? {}
const published = result.Transaction?.effects?.changedObjects?.find(
  (o) => o.idOperation === 'Created' && objectTypes[o.objectId]?.includes('package'),
)

console.log('digest:', result.Transaction?.digest)
console.log('Changed objects:')
for (const o of result.Transaction?.effects?.changedObjects ?? []) {
  console.log(' ', o.idOperation, o.objectId, objectTypes[o.objectId])
}
console.log('Likely package object:', published?.objectId)
