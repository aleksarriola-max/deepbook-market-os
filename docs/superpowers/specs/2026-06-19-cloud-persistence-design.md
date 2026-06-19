# Cloud persistence for saved templates & Predict positions

## Problem

Strategy Builder's saved templates and Predict's YES/NO positions currently
live only in React `useState` — both vanish on refresh and never follow a
user to a different browser or device. This adds a backend so that data
survives.

## Decision: Supabase, no custom server

The frontend keeps shipping as a static site on GitHub Pages. The only new
piece is a Supabase project (hosted Postgres + auto-generated REST API) that
the browser talks to directly via `@supabase/supabase-js`. No server code is
written or hosted by this project.

Rejected alternatives:
- **Cloudflare Workers + D1** — a real custom backend, but more to build and
  maintain than the problem warrants; Supabase gets the same outcome (durable
  storage behind an API) with far less code.
- **Custom Node API on Render/Fly.io** — free tiers on these platforms spin
  down after inactivity, reintroducing the cold-start "sleep" problem this
  project's GitHub Pages deploy was specifically chosen to avoid.

## Identity: wallet address, not real auth

`src/lib/session.tsx` already has an unused `address`/`setAddress` field on
the session context. A new sidebar input (in `App.tsx`) binds to it and
persists the value to `localStorage` so it survives refresh without a
network round-trip.

This address is **not cryptographically verified** — there is no wallet
connection/signing anywhere in this app today (Portfolio's wallet field is
just a lookup against the public indexer, same as everywhere else). Anyone
who knows an address could read or write that address's saved data in
Supabase. This is an accepted trade-off: everything stored here is paper
data with no real funds at stake, consistent with the rest of the app's
"simulated" framing (the SIMULATED/SIM tags already used in Predict, etc.).
If this app ever moves to real wallet signing, this is the seam where a
verified-signature check would replace the permissive RLS policy below.

Cloud sync is **opt-in**: if `address` is empty, both screens behave exactly
as they do today (in-memory only, nothing sent to Supabase).

## Data model

One generic table, not two parallel ones — the two payload shapes (a
strategy template, a Predict position) differ enough to just live as JSON,
and a single table means one CRUD code path instead of two:

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
-- No real auth in this app — RLS is enabled for hygiene but the policy is
-- permissive, consistent with the identity trade-off above.
create policy "anon full access" on saved_items
  for all using (true) with check (true);
```

- `kind='template'` → `data` is `{ pool: string, plan: IntentPlan }` (the
  existing `SavedStrategy` shape in `StrategyBuilder.tsx`, minus `id`/
  `createdAt` which become the table's own `id`/`created_at`).
- `kind='predict_position'` → `data` is
  `{ market, side, price, size, strike, days, isCall }` (the existing
  position shape in `Predict.tsx`).

## Components

- **`src/lib/supabase.ts`** (new) — creates the Supabase client from
  `import.meta.env.VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`.
- **`src/lib/cloudState.ts`** (new) — three generic functions:
  - `listItems<T>(wallet: string, kind: 'template' | 'predict_position'): Promise<{id: number, data: T, createdAt: number}[]>`
  - `addItem<T>(wallet: string, kind, data: T): Promise<void>`
  - `removeItem(id: number): Promise<void>`
- **`src/lib/session.tsx`** — no shape change; `address`/`setAddress` already
  exist on the context.
- **`App.tsx`** — adds a "wallet" text input in the sidebar bound to
  `session.address`, initialized from and synced to `localStorage`.
- **`StrategyBuilder.tsx`** — `saved` state becomes
  `useLoad(() => address ? listItems(address, 'template') : Promise.resolve([]), [address])`.
  "Save as template" calls `addItem` then refetches. Each row gets a
  "remove" button calling `removeItem` (necessary now that rows persist
  forever otherwise — this wasn't needed when state was just in-memory).
- **`Predict.tsx`** — same pattern: `positions` loads via `listItems`, "Buy
  YES/NO" calls `addItem`, each row gets a "close" button calling
  `removeItem`.

## Error handling

Reuses the existing `useLoad`/`Empty` conventions already used everywhere
else in this codebase (e.g. an `Empty` fallback reading something like
"couldn't reach saved data" on fetch failure). No new UX pattern.

## Build/deploy changes

- `npm install @supabase/supabase-js`
- Two new GitHub repo secrets: `SUPABASE_URL`, `SUPABASE_ANON_KEY` (the anon
  key is meant to be public — Supabase's security model relies on RLS, not
  on keeping it secret — but it's still cleanest to inject via secrets
  rather than commit it).
- `.github/workflows/deploy.yml` build step gets two more `env:` entries
  (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`), same pattern as the
  existing `GITHUB_PAGES` var.
- `.env.example` gets the same two vars documented for local dev.

## Testing

This project has no test framework (`npm run build` is `tsc -b && vite
build` only; no `vitest`/`jest`, no test files anywhere). Consistent with
how every other feature in this project has been verified, this will be
checked manually live in the browser after implementation: enter a wallet
address, save a template, refresh, confirm it reloads from Supabase; repeat
for a Predict position; confirm both screens still work with no address
set (today's in-memory-only behavior, unchanged).

## Prerequisite (outside this repo)

A Supabase project must exist before implementation can run end-to-end —
this requires a free Supabase account and a new project, which only the
user can create (account signup / org selection isn't something an agent
can do). The implementation plan will pause at the point the project URL
and anon key are needed.
