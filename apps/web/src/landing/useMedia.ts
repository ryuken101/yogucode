import { useEffect, useState } from 'react'
import type { RefObject } from 'react'

/** Whether a media query matches, kept current. False where `matchMedia` doesn't exist (jsdom). */
export function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false,
  )
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const list = window.matchMedia(query)
    const onChange = () => setMatches(list.matches)
    onChange()
    list.addEventListener('change', onChange)
    return () => list.removeEventListener('change', onChange)
  }, [query])
  return matches
}

export const useReducedMotion = () => useMedia('(prefers-reduced-motion: reduce)')

/** Below this the desktop's windows fill the screen (`desktop/desktop.css`). */
export const useNarrow = () => useMedia('(max-width: 760px)')

/**
 * A counter that goes up every `ms`, for the mocks' scripted classes. It counts to `last`,
 * holds there for `hold` ticks, then starts again. With reduced motion it sits on `last`.
 */
export function useTicker(ms: number, last: number, hold = 4): number {
  const reduced = useReducedMotion()
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (reduced) return
    const timer = setInterval(() => setTick((n) => (n >= last + hold ? 0 : n + 1)), ms)
    return () => clearInterval(timer)
  }, [ms, last, hold, reduced])
  return reduced ? last : Math.min(tick, last)
}

/** True once `ref` has scrolled into view (and from then on). True at once without IntersectionObserver. */
export function useSeen(ref: RefObject<Element | null>): boolean {
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    if (seen || !ref.current) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setSeen(true)
      },
      { threshold: 0.35 },
    )
    io.observe(ref.current)
    return () => io.disconnect()
  }, [ref, seen])
  return seen
}
