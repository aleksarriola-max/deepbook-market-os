export function fmt(n: number | null | undefined, digits = 2): string {
  if (n == null || Number.isNaN(n)) return '—'
  if (n === 0) return '0'
  const abs = Math.abs(n)
  if (abs >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + 'B'
  if (abs >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
  if (abs >= 10_000) return (n / 1_000).toFixed(1) + 'K'
  if (abs < 0.0001) return n.toExponential(2)
  if (abs < 1) return n.toFixed(Math.max(digits, 4))
  return n.toLocaleString(undefined, { maximumFractionDigits: digits })
}

export function fmtPrice(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n) || n === 0) return '—'
  const abs = Math.abs(n)
  if (abs >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 1 })
  if (abs >= 1) return n.toFixed(4)
  if (abs >= 0.01) return n.toFixed(5)
  return n.toFixed(7)
}

export function fmtUsd(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—'
  return '$' + fmt(n)
}

export function fmtPct(n: number | null | undefined, digits = 2): string {
  if (n == null || Number.isNaN(n)) return '—'
  return (n >= 0 ? '+' : '') + n.toFixed(digits) + '%'
}

export function fmtQty(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—'
  return n.toFixed(4)
}

export function fmtBps(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—'
  return n.toFixed(2) + ' bps'
}

export function shortAddr(a: string, head = 6, tail = 4): string {
  if (!a) return '—'
  return a.length > head + tail + 3 ? `${a.slice(0, head)}…${a.slice(-tail)}` : a
}

export function ago(tsMs: number): string {
  const s = Math.max(0, (Date.now() - tsMs) / 1000)
  if (s < 60) return `${Math.floor(s)}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export function clock(tsMs: number): string {
  return new Date(tsMs).toLocaleTimeString(undefined, { hour12: false })
}

export function fmtTime(tsMs: number): string {
  return Date.now() - tsMs < 86_400_000
    ? ago(tsMs)
    : new Date(tsMs).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
}
