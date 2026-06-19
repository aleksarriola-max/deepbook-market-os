# Cloud Persistence (Supabase) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist Strategy Builder saved templates and Predict YES/NO positions to a Supabase database, keyed by an opt-in wallet-address field, so they survive a refresh or a different device.

**Architecture:** The frontend stays a static site on GitHub Pages. The browser talks directly to a Supabase project's REST API via `@supabase/supabase-js` — no custom server. Identity is the existing-but-unused `session.address` field, exposed via a new sidebar input and persisted to `localStorage`. When no address is set, both screens behave exactly as today (in-memory only).

**Tech Stack:** Vite + React 19 + TypeScript, `@supabase/supabase-js`, Postgres (via Supabase), GitHub Actions (existing `deploy.yml`).

## Global Constraints

- No backend code is written or hosted by this repo — only Supabase (hosted) and the existing static frontend.
- This project has no test framework (confirmed: no `vitest`/`jest`, no test files, `npm run build` = `tsc -b && vite build`). Every task's verification step uses the build (type-check) plus a manual browser check, consistent with how every other feature in this codebase has been verified this session.
- RLS on the new table is intentionally permissive (`using (true)`) — there is no real wallet signing anywhere in this app, and this is accepted, documented trade-off for paper/simulated data (see spec `docs/superpowers/specs/2026-06-19-cloud-persistence-design.md`).
- Cloud sync is opt-in: every screen that reads/writes `saved_items` must fall back to its current in-memory-only behavior when `session.address` is empty.

---

### Task 1: Provision Supabase project, schema, and env wiring

**Files:**
- Create: `.env.local` (gitignored — never committed)
- Modify: `.env.example`
- Modify: `package.json`, `package-lock.json` (via `npm install`)

**Interfaces:**
- Produces: two env vars, `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`, that Task 2's `src/lib/supabase.ts` consumes via `import.meta.env`.

- [ ] **Step 1: Create the Supabase project (manual, in browser)**

Go to https://supabase.com, sign in (or sign up — free tier), click "New Project". Name it `deepbook-market-os` (or similar), pick any region, set a database password (not needed again unless connecting via raw Postgres), and wait ~2 minutes for provisioning to finish.

- [ ] **Step 2: Run the schema SQL**

In the Supabase dashboard, open the SQL Editor (left sidebar), paste and run:

```sql
create table saved_items (
  id bigint generated always as identity primary key,
  wallet_address text not null,
  kind text not null check (kind in ('template', 'predict_position')),
  data jsonb not null,
  created_at timestamptz not null default now()
);
create index on saved_items (wallet_address, kind);

alter table saved_items enable row level security;
create policy "anon full access" on saved_items
  for all using (true) with check (true);
```

Expected: "Success. No rows returned" in the SQL editor output.

- [ ] **Step 3: Copy the project URL and anon key**

In the dashboard, go to Project Settings → API. Copy the "Project URL" (looks like `https://xxxxxxxxxxxx.supabase.co`) and the "anon public" key (a long JWT-looking string).

- [ ] **Step 4: Create `.env.local`**

Create `C:\Users\aleks\deepbook-market-os\.env.local` with:

```
VITE_SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=paste-the-anon-key-here
```

(Replace with the real values from Step 3. This file is already covered by `.gitignore`'s `*.local` pattern — confirm with `git check-ignore -v .env.local`, expected output: `.gitignore:12:*.local	.env.local`.)

- [ ] **Step 5: Document the vars in `.env.example`**

Read the current file, then add two lines at the end:

```
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
```

- [ ] **Step 6: Install the Supabase client**

Run: `npm install @supabase/supabase-js`

- [ ] **Step 7: Verify the build still passes**

Run: `npm run build`
Expected: `✓ built in <N>ms` with no TypeScript errors (same output shape as every previous build this session).

- [ ] **Step 8: Commit**

```bash
git add .env.example package.json package-lock.json
git commit -m "Add Supabase dependency and env var documentation for cloud persistence"
```

---

### Task 2: Supabase client and cloud-state CRUD helpers

**Files:**
- Create: `src/lib/supabase.ts`
- Create: `src/lib/cloudState.ts`

**Interfaces:**
- Consumes: `import.meta.env.VITE_SUPABASE_URL`, `import.meta.env.VITE_SUPABASE_ANON_KEY` (from Task 1).
- Produces:
  - `supabase: SupabaseClient | null` (exported from `src/lib/supabase.ts`)
  - `type ItemKind = 'template' | 'predict_position'`
  - `interface SavedItem<T> { id: number; data: T; createdAt: number }`
  - `listItems<T>(wallet: string, kind: ItemKind): Promise<SavedItem<T>[]>`
  - `addItem<T>(wallet: string, kind: ItemKind, data: T): Promise<void>`
  - `removeItem(id: number): Promise<void>`
  - All three CRUD functions are consumed by Task 4 (`StrategyBuilder.tsx`) and Task 5 (`Predict.tsx`).

- [ ] **Step 1: Create `src/lib/supabase.ts`**

```typescript
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

// Null when env vars are missing (e.g. local dev before Task 1's .env.local
// is set up) — callers in cloudState.ts treat this the same as "no wallet
// address set": skip the network call, fall back to local-only state.
export const supabase: SupabaseClient | null = url && anonKey ? createClient(url, anonKey) : null
```

- [ ] **Step 2: Create `src/lib/cloudState.ts`**

```typescript
import { supabase } from './supabase'

export type ItemKind = 'template' | 'predict_position'

export interface SavedItem<T> {
  id: number
  data: T
  createdAt: number
}

/** Lists saved items for a wallet/kind, newest first. Returns [] if cloud sync isn't configured. */
export async function listItems<T>(wallet: string, kind: ItemKind): Promise<SavedItem<T>[]> {
  if (!supabase || !wallet) return []
  const { data, error } = await supabase
    .from('saved_items')
    .select('id, data, created_at')
    .eq('wallet_address', wallet)
    .eq('kind', kind)
    .order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  return (data ?? []).map((row) => ({
    id: row.id as number,
    data: row.data as T,
    createdAt: new Date(row.created_at as string).getTime(),
  }))
}

/** Inserts one saved item. No-op if cloud sync isn't configured. */
export async function addItem<T>(wallet: string, kind: ItemKind, data: T): Promise<void> {
  if (!supabase || !wallet) return
  const { error } = await supabase.from('saved_items').insert({ wallet_address: wallet, kind, data })
  if (error) throw new Error(error.message)
}

/** Deletes one saved item by id. No-op if cloud sync isn't configured. */
export async function removeItem(id: number): Promise<void> {
  if (!supabase) return
  const { error } = await supabase.from('saved_items').delete().eq('id', id)
  if (error) throw new Error(error.message)
}
```

- [ ] **Step 3: Verify the build (type-check only)**

Run: `npm run build`
Expected: `✓ built in <N>ms`, no TypeScript errors. (Behavioral verification — actually saving/loading/removing rows — happens in Task 4, the first place these functions are exercised through real UI.)

- [ ] **Step 4: Commit**

```bash
git add src/lib/supabase.ts src/lib/cloudState.ts
git commit -m "Add Supabase client and generic cloud-state CRUD helpers"
```

---

### Task 3: Wallet identity field in the sidebar

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: `useSession()` from `src/lib/session.tsx` (already exports `address: string`, `setAddress: (a: string) => void` — no changes to that file).
- Produces: a visible "wallet (for saved data)" input in the sidebar, wired to `session.address` and `localStorage` key `dbmos:wallet`. Task 4 and Task 5 read `session.address` via `useSession()`.

- [ ] **Step 1: Add the `WalletField` component and wire it in**

In `src/App.tsx`, change the import line:

```typescript
import { SessionProvider } from './lib/session'
```

to:

```typescript
import { SessionProvider, useSession } from './lib/session'
```

Add this constant near the top of the file, after the imports:

```typescript
const WALLET_STORAGE_KEY = 'dbmos:wallet'
```

Add this component definition right before `export default function App()`:

```typescript
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
```

In the JSX inside `<aside className="sidebar">`, insert `<WalletField />` right before the `<div className="sidebar-footer">` line:

```tsx
          ))}
          <WalletField />
          <div className="sidebar-footer">
```

- [ ] **Step 2: Add sidebar CSS so the field matches the existing rhythm**

In `src/styles.css`, after the line `.sidebar-footer { margin-top: auto; padding: 10px; font-size: 10.5px; color: var(--muted); line-height: 1.5; }`, add:

```css
.sidebar-wallet { margin: 14px 10px 0; }
```

And in the existing collapsed-rail media query, change:

```css
  .logo, .nav-section, .sidebar-footer, .nav-item .label { display: none; }
```

to:

```css
  .logo, .nav-section, .sidebar-footer, .sidebar-wallet, .nav-item .label { display: none; }
```

- [ ] **Step 3: Verify the build**

Run: `npm run build`
Expected: `✓ built in <N>ms`, no TypeScript errors.

- [ ] **Step 4: Verify live in the browser**

Run `npm run dev`, open the app, and confirm:
- A "wallet (for saved data)" field appears in the sidebar, below the nav sections.
- Typing an address into it and reloading the page keeps the address (because it's read back from `localStorage`).

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx src/styles.css
git commit -m "Add wallet-address field to sidebar for cloud-saved data identity"
```

---

### Task 4: Wire Strategy Builder's saved templates to cloud state

**Files:**
- Modify: `src/screens/StrategyBuilder.tsx`

**Interfaces:**
- Consumes: `useLoad` from `src/lib/hooks.ts` (already exists, signature `useLoad<T>(loader: () => Promise<T>, deps: unknown[]): PollState<T>` where `PollState<T> = {data: T | null, error: string | null, loading: boolean, lastUpdated: number}`); `listItems`, `addItem`, `removeItem`, `type SavedItem` from Task 2's `src/lib/cloudState.ts`; `address` from `useSession()` (Task 3).
- Produces: no new exports — this is a leaf screen component.

- [ ] **Step 1: Update imports**

Change:

```typescript
import { useMemo, useState } from 'react'
import { usePoll } from '../lib/hooks'
```

to:

```typescript
import { useMemo, useState } from 'react'
import { usePoll, useLoad } from '../lib/hooks'
import { listItems, addItem, removeItem, type SavedItem } from '../lib/cloudState'
```

- [ ] **Step 2: Replace the `SavedStrategy` interface and `saved` state**

Replace:

```typescript
interface SavedStrategy {
  id: number
  pool: string
  plan: IntentPlan
  createdAt: number
}
```

with:

```typescript
interface TemplateData {
  pool: string
  plan: IntentPlan
}
```

Replace:

```typescript
  const { pool } = useSession()
```

with:

```typescript
  const { pool, address } = useSession()
```

Replace:

```typescript
  const [saved, setSaved] = useState<SavedStrategy[]>([])
```

with:

```typescript
  const [localSaved, setLocalSaved] = useState<SavedItem<TemplateData>[]>([])
  const [refreshKey, setRefreshKey] = useState(0)
  const cloudSaved = useLoad(
    () => (address ? listItems<TemplateData>(address, 'template') : Promise.resolve(null)),
    [address, refreshKey],
  )
  // Cloud sync is opt-in: no address set => behave exactly like before (local only).
  const saved = address ? (cloudSaved.data ?? []) : localSaved
```

- [ ] **Step 3: Update the "Save as template" button**

Replace:

```tsx
          {plan && (
            <button
              className="btn"
              onClick={() =>
                setSaved((s) => [{ id: Date.now(), pool, plan, createdAt: Date.now() }, ...s])
              }
            >
              Save as template
            </button>
          )}
```

with:

```tsx
          {plan && (
            <button
              className="btn"
              onClick={async () => {
                if (address) {
                  await addItem<TemplateData>(address, 'template', { pool, plan })
                  setRefreshKey((k) => k + 1)
                } else {
                  setLocalSaved((s) => [{ id: Date.now(), data: { pool, plan }, createdAt: Date.now() }, ...s])
                }
              }}
            >
              Save as template
            </button>
          )}
```

- [ ] **Step 4: Update the "Saved strategy templates" panel to read `s.data.*` and add a remove button**

Replace:

```tsx
        <Panel
          className="span-all"
          title="Saved strategy templates"
          sub="Templates are reusable across pools and deployable through the desk's delegated accounts"
        >
          {saved.length === 0 ? (
            <Empty text="no templates yet — tune a ladder and save it" />
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Created</th>
                  <th>Pool</th>
                  <th>Strategy</th>
                  <th className="num">Rungs</th>
                  <th className="num">Quantity</th>
                  <th className="num">Avg price</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {saved.map((s) => (
                  <tr key={s.id}>
                    <td>{new Date(s.createdAt).toLocaleTimeString()}</td>
                    <td>{s.pool}</td>
                    <td>{s.plan.label}</td>
                    <td className="num">{s.plan.rungs.length}</td>
                    <td className="num">{fmt(s.plan.rungs.reduce((a, r) => a + r.quantity, 0))}</td>
                    <td className="num">{fmtPrice(s.plan.avgPrice)}</td>
                    <td>
                      <Tag tone="info">ready to deploy</Tag>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
```

with:

```tsx
        <Panel
          className="span-all"
          title="Saved strategy templates"
          sub={
            address
              ? "Synced to this wallet address — reusable across pools, devices, and the desk's delegated accounts"
              : "Templates are reusable across pools and deployable through the desk's delegated accounts (enter a wallet address in the sidebar to sync these across devices)"
          }
        >
          {address && cloudSaved.error ? (
            <Empty text={`couldn't reach saved data: ${cloudSaved.error}`} />
          ) : saved.length === 0 ? (
            <Empty text="no templates yet — tune a ladder and save it" />
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Created</th>
                  <th>Pool</th>
                  <th>Strategy</th>
                  <th className="num">Rungs</th>
                  <th className="num">Quantity</th>
                  <th className="num">Avg price</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {saved.map((s) => (
                  <tr key={s.id}>
                    <td>{new Date(s.createdAt).toLocaleTimeString()}</td>
                    <td>{s.data.pool}</td>
                    <td>{s.data.plan.label}</td>
                    <td className="num">{s.data.plan.rungs.length}</td>
                    <td className="num">{fmt(s.data.plan.rungs.reduce((a, r) => a + r.quantity, 0))}</td>
                    <td className="num">{fmtPrice(s.data.plan.avgPrice)}</td>
                    <td>
                      <button
                        className="btn ghost"
                        onClick={async () => {
                          if (address) {
                            await removeItem(s.id)
                            setRefreshKey((k) => k + 1)
                          } else {
                            setLocalSaved((ls) => ls.filter((x) => x.id !== s.id))
                          }
                        }}
                      >
                        remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
```

- [ ] **Step 5: Verify the build**

Run: `npm run build`
Expected: `✓ built in <N>ms`, no TypeScript errors.

- [ ] **Step 6: Verify live in the browser, no-wallet case**

Run `npm run dev`, open Strategy Builder with no wallet address set in the sidebar, tune a ladder, click "Save as template". Confirm: the row appears in "Saved strategy templates" immediately (local-only path), and the sub-text reads the no-address variant.

- [ ] **Step 7: Verify live in the browser, with-wallet case**

Type a test address (e.g. `0xtest123`) into the sidebar wallet field. Save a new template. Confirm:
- The row appears in the table.
- In the Supabase dashboard's Table Editor (`saved_items` table), a new row exists with `wallet_address = '0xtest123'`, `kind = 'template'`, and `data` containing the pool and plan.
- Reloading the page (with the same address still in the sidebar, since it's in `localStorage`) re-shows the saved row, loaded from Supabase.
- Clicking "remove" deletes the row from both the UI and the Supabase table.

- [ ] **Step 8: Commit**

```bash
git add src/screens/StrategyBuilder.tsx
git commit -m "Sync Strategy Builder saved templates to Supabase, keyed by wallet address"
```

---

### Task 5: Wire Predict's positions to cloud state

**Files:**
- Modify: `src/screens/Predict.tsx`

**Interfaces:**
- Consumes: same `useLoad`, `listItems`, `addItem`, `removeItem`, `SavedItem` as Task 4; `address` from `useSession()`.
- Produces: no new exports — leaf screen component.

- [ ] **Step 1: Update imports**

Change:

```typescript
import { useMemo, useState } from 'react'
import { usePoll } from '../lib/hooks'
```

to:

```typescript
import { useMemo, useState } from 'react'
import { usePoll, useLoad } from '../lib/hooks'
import { listItems, addItem, removeItem, type SavedItem } from '../lib/cloudState'
```

- [ ] **Step 2: Replace the `positions` state**

Replace:

```typescript
  const { pool } = useSession()
```

with:

```typescript
  const { pool, address } = useSession()
```

Add this type definition right before the `Predict` component's existing position-state line (i.e. near the other interfaces/types in the file, above `export function Predict()`):

```typescript
interface PositionData {
  market: string
  side: string
  price: number
  size: number
  strike: number
  days: number
  isCall: boolean
}
```

Replace:

```typescript
  const [positions, setPositions] = useState<
    { market: string; side: string; price: number; size: number; strike: number; days: number; isCall: boolean }[]
  >([])
```

with:

```typescript
  const [localPositions, setLocalPositions] = useState<SavedItem<PositionData>[]>([])
  const [refreshKey, setRefreshKey] = useState(0)
  const cloudPositions = useLoad(
    () => (address ? listItems<PositionData>(address, 'predict_position') : Promise.resolve(null)),
    [address, refreshKey],
  )
  // Cloud sync is opt-in: no address set => behave exactly like before (local only).
  const positions = address ? (cloudPositions.data ?? []) : localPositions

  const addPosition = async (data: PositionData) => {
    if (address) {
      await addItem<PositionData>(address, 'predict_position', data)
      setRefreshKey((k) => k + 1)
    } else {
      setLocalPositions((p) => [...p, { id: Date.now(), data, createdAt: Date.now() }])
    }
  }

  const closePosition = async (id: number) => {
    if (address) {
      await removeItem(id)
      setRefreshKey((k) => k + 1)
    } else {
      setLocalPositions((p) => p.filter((x) => x.id !== id))
    }
  }
```

- [ ] **Step 3: Update the "Buy YES" / "Buy NO" buttons**

Replace:

```tsx
            <button
              className="btn buy"
              disabled={spot <= 0}
              onClick={() =>
                setPositions((p) => [
                  ...p,
                  {
                    market: `${pool.split('_')[0]} ${side === 'call' ? '≥' : '<'} ${fmtPrice(strike)} in ${days}d`,
                    side: 'YES',
                    price: fair,
                    size: 100,
                    strike,
                    days,
                    isCall: side === 'call',
                  },
                ])
              }
            >
              Buy YES @ {(fair * 100).toFixed(1)}¢
            </button>
            <button
              className="btn sell"
              disabled={spot <= 0}
              onClick={() =>
                setPositions((p) => [
                  ...p,
                  {
                    market: `${pool.split('_')[0]} ${side === 'call' ? '≥' : '<'} ${fmtPrice(strike)} in ${days}d`,
                    side: 'NO',
                    price: 1 - fair,
                    size: 100,
                    strike,
                    days,
                    isCall: side === 'call',
                  },
                ])
              }
            >
              Buy NO @ {((1 - fair) * 100).toFixed(1)}¢
            </button>
```

with:

```tsx
            <button
              className="btn buy"
              disabled={spot <= 0}
              onClick={() =>
                addPosition({
                  market: `${pool.split('_')[0]} ${side === 'call' ? '≥' : '<'} ${fmtPrice(strike)} in ${days}d`,
                  side: 'YES',
                  price: fair,
                  size: 100,
                  strike,
                  days,
                  isCall: side === 'call',
                })
              }
            >
              Buy YES @ {(fair * 100).toFixed(1)}¢
            </button>
            <button
              className="btn sell"
              disabled={spot <= 0}
              onClick={() =>
                addPosition({
                  market: `${pool.split('_')[0]} ${side === 'call' ? '≥' : '<'} ${fmtPrice(strike)} in ${days}d`,
                  side: 'NO',
                  price: 1 - fair,
                  size: 100,
                  strike,
                  days,
                  isCall: side === 'call',
                })
              }
            >
              Buy NO @ {((1 - fair) * 100).toFixed(1)}¢
            </button>
```

- [ ] **Step 4: Update the "Workspace positions (paper)" panel to read `p.data.*` and add a close button**

Replace:

```tsx
        <Panel
          className="span-all"
          title="Workspace positions (paper)"
          sub="Positions accumulate here for the hedging engine on the Portfolio screen"
        >
          {positions.length ? (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Market</th>
                  <th>Side</th>
                  <th className="num">Entry</th>
                  <th className="num">Size ($ payout)</th>
                  <th className="num">Max loss</th>
                  <th className="num">Max gain</th>
                  <th className="num">Delta ($/Δ1 spot)</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p, i) => {
                  const sigma = pricingVol(p.days)
                  const callDelta = spot > 0 ? binaryDelta(spot, p.strike, sigma, p.days, p.isCall) : 0
                  const posDelta = (p.side === 'YES' ? callDelta : -callDelta) * p.size
                  return (
                    <tr key={i}>
                      <td>{p.market}</td>
                      <td>
                        <Tag tone={p.side === 'YES' ? 'live' : 'warn'}>{p.side}</Tag>
                      </td>
                      <td className="num">{(p.price * 100).toFixed(1)}¢</td>
                      <td className="num">${p.size}</td>
                      <td className="num tone-down">-${(p.price * p.size).toFixed(0)}</td>
                      <td className="num tone-up">+${((1 - p.price) * p.size).toFixed(0)}</td>
                      <td className={`num tone-${posDelta >= 0 ? 'up' : 'down'}`}>{posDelta.toFixed(2)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          ) : (
            <Empty text="no positions — buy YES/NO above" />
          )}
        </Panel>
```

with:

```tsx
        <Panel
          className="span-all"
          title="Workspace positions (paper)"
          sub={
            address
              ? 'Synced to this wallet address — feeds the hedging engine on the Portfolio screen'
              : 'Positions accumulate here for the hedging engine on the Portfolio screen (enter a wallet address in the sidebar to sync these across devices)'
          }
        >
          {address && cloudPositions.error ? (
            <Empty text={`couldn't reach saved data: ${cloudPositions.error}`} />
          ) : positions.length ? (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Market</th>
                  <th>Side</th>
                  <th className="num">Entry</th>
                  <th className="num">Size ($ payout)</th>
                  <th className="num">Max loss</th>
                  <th className="num">Max gain</th>
                  <th className="num">Delta ($/Δ1 spot)</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {positions.map((item) => {
                  const p = item.data
                  const sigma = pricingVol(p.days)
                  const callDelta = spot > 0 ? binaryDelta(spot, p.strike, sigma, p.days, p.isCall) : 0
                  const posDelta = (p.side === 'YES' ? callDelta : -callDelta) * p.size
                  return (
                    <tr key={item.id}>
                      <td>{p.market}</td>
                      <td>
                        <Tag tone={p.side === 'YES' ? 'live' : 'warn'}>{p.side}</Tag>
                      </td>
                      <td className="num">{(p.price * 100).toFixed(1)}¢</td>
                      <td className="num">${p.size}</td>
                      <td className="num tone-down">-${(p.price * p.size).toFixed(0)}</td>
                      <td className="num tone-up">+${((1 - p.price) * p.size).toFixed(0)}</td>
                      <td className={`num tone-${posDelta >= 0 ? 'up' : 'down'}`}>{posDelta.toFixed(2)}</td>
                      <td>
                        <button className="btn ghost" onClick={() => closePosition(item.id)}>
                          close
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          ) : (
            <Empty text="no positions — buy YES/NO above" />
          )}
        </Panel>
```

- [ ] **Step 5: Verify the build**

Run: `npm run build`
Expected: `✓ built in <N>ms`, no TypeScript errors.

- [ ] **Step 6: Verify live in the browser, no-wallet case**

With no wallet address set, buy a YES position. Confirm it appears immediately in "Workspace positions (paper)" (local-only path).

- [ ] **Step 7: Verify live in the browser, with-wallet case**

With a test address in the sidebar (e.g. `0xtest123`), buy a NO position. Confirm:
- It appears in the table.
- A new row exists in Supabase's `saved_items` table with `kind = 'predict_position'`.
- Reloading the page re-shows it.
- Clicking "close" removes it from both the UI and the Supabase table.

- [ ] **Step 8: Commit**

```bash
git add src/screens/Predict.tsx
git commit -m "Sync Predict positions to Supabase, keyed by wallet address"
```

---

### Task 6: Wire Supabase secrets into the GitHub Actions deploy and verify production

**Files:**
- Modify: `.github/workflows/deploy.yml`

**Interfaces:**
- Consumes: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` GitHub repo secrets (created in Step 1 below).

- [ ] **Step 1: Add the two values as GitHub repo secrets**

Run (replace the placeholder values with the same ones from Task 1's `.env.local`):

```bash
gh secret set VITE_SUPABASE_URL --repo aleksarriola-max/deepbook-market-os --body "https://xxxxxxxxxxxx.supabase.co"
gh secret set VITE_SUPABASE_ANON_KEY --repo aleksarriola-max/deepbook-market-os --body "paste-the-anon-key-here"
```

Verify: `gh secret list --repo aleksarriola-max/deepbook-market-os` shows both `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.

- [ ] **Step 2: Add the env vars to the build step**

In `.github/workflows/deploy.yml`, change:

```yaml
      - run: npm run build
        env:
          GITHUB_PAGES: true
```

to:

```yaml
      - run: npm run build
        env:
          GITHUB_PAGES: true
          VITE_SUPABASE_URL: ${{ secrets.VITE_SUPABASE_URL }}
          VITE_SUPABASE_ANON_KEY: ${{ secrets.VITE_SUPABASE_ANON_KEY }}
```

- [ ] **Step 3: Commit and push**

```bash
git add .github/workflows/deploy.yml
git commit -m "Inject Supabase env vars into the production build"
git push
```

- [ ] **Step 4: Watch the deploy**

Run: `gh run list --limit 1` to get the new run's ID, then `gh run watch <id> --exit-status`
Expected: both `build` and `deploy` jobs succeed (same shape as the original Pages deploy run).

- [ ] **Step 5: Verify live on the production URL**

Navigate to `https://aleksarriola-max.github.io/deepbook-market-os/` in a browser (use chrome-devtools `navigate_page` + `take_snapshot`, or just open it manually). Enter the same test wallet address (`0xtest123`) used in Tasks 4–5's manual checks in the sidebar, go to Strategy Builder and Predict, and confirm the same templates/positions saved during local testing now appear here too (proving the production build is reading from the same Supabase project, not a stale or misconfigured one).

---

## Self-Review Notes

- **Spec coverage:** Identity (Task 3) ✓, data model (Task 1) ✓, `supabase.ts`/`cloudState.ts` (Task 2) ✓, Strategy Builder integration (Task 4) ✓, Predict integration (Task 5) ✓, error handling via `Empty` (Tasks 4–5) ✓, build/deploy env wiring (Task 6) ✓, opt-in no-address fallback (Tasks 4–5, explicitly tested) ✓.
- **Type consistency:** `SavedItem<T>` (Task 2) is the one shape threaded through Task 4 (`SavedItem<TemplateData>`) and Task 5 (`SavedItem<PositionData>`) — field names (`id`, `data`, `createdAt`) match everywhere they're read. `listItems`/`addItem`/`removeItem` signatures match their call sites in both screens.
- **No placeholders:** every step has literal code or an exact command; the only inherently manual steps (Supabase account/project creation, pasting credentials) are explicit interactive instructions, not deferred TODOs.
