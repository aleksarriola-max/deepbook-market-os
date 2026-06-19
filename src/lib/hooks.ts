import { useEffect, useRef, useState } from 'react'

export interface PollState<T> {
  data: T | null
  error: string | null
  loading: boolean
  lastUpdated: number
}

/**
 * Polls an async loader every `intervalMs`. Keeps last good data on transient
 * errors so the UI never flashes empty.
 */
export function usePoll<T>(
  loader: () => Promise<T>,
  intervalMs: number,
  deps: unknown[] = [],
): PollState<T> {
  const [state, setState] = useState<PollState<T>>({
    data: null,
    error: null,
    loading: true,
    lastUpdated: 0,
  })
  const loaderRef = useRef(loader)
  loaderRef.current = loader

  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      try {
        const data = await loaderRef.current()
        if (alive)
          setState({ data, error: null, loading: false, lastUpdated: Date.now() })
      } catch (e) {
        if (alive)
          setState((s) => ({
            ...s,
            error: e instanceof Error ? e.message : String(e),
            loading: false,
          }))
      }
      if (alive) timer = setTimeout(tick, intervalMs)
    }
    setState((s) => ({ ...s, loading: true }))
    tick()
    return () => {
      alive = false
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return state
}

/** One-shot async load. */
export function useLoad<T>(loader: () => Promise<T>, deps: unknown[] = []) {
  return usePoll(loader, 24 * 3600 * 1000, deps)
}
