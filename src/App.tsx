import { useEffect, useRef, useState, Component, type ErrorInfo, type JSX, type ReactNode } from 'react'
import { SessionProvider, useSession } from './lib/session'
import { Dashboard } from './screens/Dashboard'
import { Terminal } from './screens/Terminal'
import { StrategyBuilder } from './screens/StrategyBuilder'
import { Analytics } from './screens/Analytics'
import { DeskManager } from './screens/DeskManager'
import { Vault } from './screens/Vault'
import { Predict } from './screens/Predict'
import { Structured } from './screens/Structured'
import { Portfolio } from './screens/Portfolio'
import { BuilderConsole } from './screens/BuilderConsole'

const WALLET_STORAGE_KEY = 'dbmos:wallet'

type ScreenId =
  | 'dashboard'
  | 'terminal'
  | 'strategy'
  | 'analytics'
  | 'desk'
  | 'vault'
  | 'predict'
  | 'structured'
  | 'portfolio'
  | 'builder'

const NAV: { section: string; items: { id: ScreenId; label: string; ico: string }[] }[] = [
  {
    section: 'Execution',
    items: [
      { id: 'dashboard', label: 'Market Dashboard', ico: '▦' },
      { id: 'terminal', label: 'Smart Terminal', ico: '▶' },
      { id: 'strategy', label: 'Strategy Builder', ico: '♟' },
      { id: 'analytics', label: 'Execution Analytics', ico: '∑' },
    ],
  },
  {
    section: 'Accounts & Liquidity',
    items: [
      { id: 'desk', label: 'Desk Manager', ico: '▣' },
      { id: 'vault', label: 'Liquidity Vaults', ico: '◈' },
    ],
  },
  {
    section: 'Advanced Products',
    items: [
      { id: 'predict', label: 'Predict Workspace', ico: '◐' },
      { id: 'structured', label: 'Structured Products', ico: '⬡' },
      { id: 'portfolio', label: 'Portfolio Command', ico: '◎' },
    ],
  },
  {
    section: 'Builder Infra',
    items: [{ id: 'builder', label: 'Market Creation', ico: '✦' }],
  },
]

// Vim-style "g" then a letter jumps to a screen (G D / G T / G S / G A / G P).
const GOTO_KEYS: Record<string, ScreenId> = {
  d: 'dashboard',
  t: 'terminal',
  s: 'strategy',
  a: 'analytics',
  p: 'portfolio',
}

class ScreenErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Screen crashed:', error, info)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="banner" style={{ borderColor: 'var(--down)' }}>
          <b>This screen hit an error:</b> {this.state.error.message}
        </div>
      )
    }
    return this.props.children
  }
}

const SCREENS: Record<ScreenId, () => JSX.Element> = {
  dashboard: Dashboard,
  terminal: Terminal,
  strategy: StrategyBuilder,
  analytics: Analytics,
  desk: DeskManager,
  vault: Vault,
  predict: Predict,
  structured: Structured,
  portfolio: Portfolio,
  builder: BuilderConsole,
}

function WalletField() {
  const { address, setAddress } = useSession()

  useEffect(() => {
    const saved = localStorage.getItem(WALLET_STORAGE_KEY)
    if (saved) setAddress(saved)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="sidebar-wallet">
      <label className="fld">
        wallet (for saved data)
        <input
          type="text"
          placeholder="0x…"
          value={address}
          onChange={(e) => {
            setAddress(e.target.value)
            localStorage.setItem(WALLET_STORAGE_KEY, e.target.value)
          }}
        />
      </label>
    </div>
  )
}

export default function App() {
  const [screen, setScreen] = useState<ScreenId>('dashboard')
  const awaitingGoto = useRef(false)
  const gotoTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && /^(input|textarea|select)$/i.test(target.tagName)) return
      const key = e.key.toLowerCase()
      if (awaitingGoto.current) {
        awaitingGoto.current = false
        clearTimeout(gotoTimer.current)
        const dest = GOTO_KEYS[key]
        if (dest) {
          e.preventDefault()
          setScreen(dest)
        }
        return
      }
      if (key === 'g') {
        awaitingGoto.current = true
        clearTimeout(gotoTimer.current)
        gotoTimer.current = setTimeout(() => {
          awaitingGoto.current = false
        }, 1500)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      clearTimeout(gotoTimer.current)
    }
  }, [])

  const Active = SCREENS[screen]
  return (
    <SessionProvider>
      <div className="app">
        <aside className="sidebar">
          <div className="logo">
            <h1>
              DeepBook <b>Market OS</b>
            </h1>
            <p>execution · accounts · liquidity · products · markets</p>
          </div>
          {NAV.map((g) => (
            <div key={g.section}>
              <div className="nav-section">{g.section}</div>
              {g.items.map((it) => (
                <button
                  key={it.id}
                  className={`nav-item ${screen === it.id ? 'active' : ''}`}
                  onClick={() => setScreen(it.id)}
                  title={it.label}
                >
                  <span className="ico">{it.ico}</span>
                  <span className="label">{it.label}</span>
                </button>
              ))}
            </div>
          ))}
          <WalletField />
          <div className="sidebar-footer">
            Built on DeepBookV3 · Spot + Margin + Predict
            <br />
            Live data: Mysten public indexer (mainnet)
          </div>
        </aside>
        <main className="main">
          <ScreenErrorBoundary key={screen}>
            <Active />
          </ScreenErrorBoundary>
        </main>
      </div>
    </SessionProvider>
  )
}
