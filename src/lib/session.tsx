import { createContext, useContext, useState, type ReactNode } from 'react'

/**
 * App-wide session: selected pool + the (optional) trading identity used by
 * the SDK layer. No wallet is required to explore the OS — transactions are
 * built and previewed; signing is delegated to a wallet or scripts/trade.ts.
 */
export interface Session {
  pool: string
  setPool: (p: string) => void
  address: string
  setAddress: (a: string) => void
  balanceManager: string
  setBalanceManager: (b: string) => void
}

const Ctx = createContext<Session | null>(null)

export function SessionProvider(props: { children: ReactNode }) {
  const [pool, setPool] = useState('SUI_USDC')
  const [address, setAddress] = useState('')
  const [balanceManager, setBalanceManager] = useState('')
  return (
    <Ctx.Provider
      value={{ pool, setPool, address, setAddress, balanceManager, setBalanceManager }}
    >
      {props.children}
    </Ctx.Provider>
  )
}

export function useSession(): Session {
  const s = useContext(Ctx)
  if (!s) throw new Error('SessionProvider missing')
  return s
}
