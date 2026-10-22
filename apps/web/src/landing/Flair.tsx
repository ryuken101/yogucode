/**
 * The landing page's one piece of decoration (Ken, 23 Oct 2026, keeping it when the rest
 * went): a cup in the corner that fills with yogurt as you scroll. It is a button that
 * goes to Book a demo.
 *
 * The scroll writes attributes straight onto the SVG rather than going through React
 * state, so scrolling never re-renders the page.
 */

import { useEffect, useId, useRef, useState } from 'react'

/** Call `onScroll` at most once a frame while the page scrolls, and once at the start. */
function useScroll(onScroll: () => void) {
  const latest = useRef(onScroll)
  useEffect(() => {
    latest.current = onScroll
  })
  useEffect(() => {
    let frame = 0
    const handler = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        latest.current()
      })
    }
    latest.current()
    window.addEventListener('scroll', handler, { passive: true })
    window.addEventListener('resize', handler, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', handler)
      window.removeEventListener('resize', handler)
    }
  }, [])
}

// --- the cup that fills ------------------------------------------------------------------

/** `CupMark`'s cup body, in its 200×200 viewBox. */
const CUP_BODY = 'M60 90 H140 L130 162 Q129.5 168 123 168 H77 Q70.5 168 70 162 Z'
const CUP_TOP = 90
const CUP_BOTTOM = 168

export function ScrollCup({ target }: { target: string }) {
  const clip = useId()
  const fill = useRef<SVGRectElement>(null)
  const [full, setFull] = useState(false)

  useScroll(() => {
    const max = document.documentElement.scrollHeight - window.innerHeight
    const p = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0
    const y = CUP_BOTTOM - (CUP_BOTTOM - CUP_TOP) * p
    fill.current?.setAttribute('y', String(y))
    fill.current?.setAttribute('height', String(CUP_BOTTOM - y))
    setFull(p > 0.97)
  })

  return (
    <button
      type="button"
      aria-label="Book a demo"
      title="Book a demo"
      onClick={() => document.getElementById(target)?.scrollIntoView({ behavior: 'smooth' })}
      className="fixed right-3 bottom-3 z-50 rounded-2xl bg-surface/90 p-1 ring-1 ring-line transition-transform hover:-translate-y-0.5 focus-visible:outline-2 focus-visible:outline-grape-deep sm:right-5 sm:bottom-5"
    >
      <svg viewBox="40 30 120 150" className="h-11 w-11 sm:h-14 sm:w-14" aria-hidden="true">
        <defs>
          <clipPath id={clip}>
            <path d={CUP_BODY} />
          </clipPath>
        </defs>
        <circle cx="100" cy="50" r="9" fill="#FFD166" className={`transition-opacity duration-300 ${full ? 'opacity-100' : 'opacity-0'}`} />
        <path d={CUP_BODY} fill="#FFF6E9" />
        <rect ref={fill} x="40" y={CUP_BOTTOM} width="120" height="0" fill="#FF5C8A" clipPath={`url(#${clip})`} />
        <rect x="54" y="80" width="92" height="14" rx="7" fill="#ffffff" stroke="#4B2FB8" strokeWidth="3" />
        <path d={CUP_BODY} fill="none" stroke="#4B2FB8" strokeWidth="4" strokeLinejoin="round" />
        <circle cx="87" cy="124" r="5.5" fill="#4B2FB8" />
        <circle cx="113" cy="124" r="5.5" fill="#4B2FB8" />
        <path d="M92 135 Q100 143 108 135" fill="none" stroke="#4B2FB8" strokeWidth="4.5" strokeLinecap="round" />
      </svg>
    </button>
  )
}
