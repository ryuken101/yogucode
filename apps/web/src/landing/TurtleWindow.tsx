/**
 * The landing page's hero: Python types itself on the left while a turtle draws the
 * Yogucode cup on the right, line by line. When the drawing finishes it cross-fades to the
 * real `CupMark`. Nothing here is editable: visitors watch, they don't type (Ken, 22 Oct 2026).
 *
 * The timeline is `cupScript.ts`. This file only maps a clock onto it. With reduced
 * motion the clock starts at the end, so the finished program and the cup show at once.
 */

import { FastForward, RotateCcw } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { CupMark } from '../components/Brand'
import { buildScript, duration, frameAt } from './cupScript'
import type { Shape } from './turtle'
import { useReducedMotion } from './useMedia'

const SCRIPT = buildScript()
const TOTAL = duration(SCRIPT)
const SIZE = 232
/** How long the finished drawing shows before it hands over to the real mark. */
const HANDOVER_S = 0.7

/** `play` false holds the program at the start, until the page scrolls it into view. */
export function TurtleWindow({ play = true }: { play?: boolean }) {
  const reduced = useReducedMotion()
  const [seconds, setSeconds] = useState(0)
  const [fast, setFast] = useState(false)
  const [run, setRun] = useState(0)
  // Read by the running animation loop, so Faster takes effect mid-drawing without a restart.
  const speed = useRef(1)
  useEffect(() => {
    speed.current = fast ? 4 : 1
  }, [fast])

  useEffect(() => {
    if (reduced || !play) return
    let elapsed = 0
    let last = performance.now()
    let frame = 0
    const tick = (now: number) => {
      elapsed += ((now - last) / 1000) * speed.current
      last = now
      setSeconds(elapsed)
      if (elapsed < TOTAL + HANDOVER_S) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [run, reduced, play])

  const shown = reduced ? TOTAL + HANDOVER_S : seconds
  const f = frameAt(SCRIPT, shown)
  const handedOver = shown >= TOTAL + HANDOVER_S

  return (
    <div className="@container flex h-full min-h-0 flex-col">
      <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] @2xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] @2xl:grid-rows-1">
        <div className="order-2 min-h-0 @2xl:order-1">
          <CodePane frame={f} />
        </div>
        <div className="order-1 flex flex-col items-center justify-center gap-4 bg-cream px-4 py-5 @2xl:order-2">
          <div
            role="img"
            aria-label={handedOver ? 'The Yogucode cup, drawn by a turtle' : 'A turtle drawing the Yogucode cup'}
            className="relative"
            style={{ width: SIZE, height: SIZE }}
          >
            <Drawing frame={f} faded={handedOver} />
            <div
              className={`absolute inset-0 transition-opacity duration-700 motion-reduce:transition-none ${handedOver ? 'opacity-100' : 'opacity-0'}`}
            >
              <CupMark size={SIZE} />
            </div>
          </div>
          <p className="min-h-[2.5em] max-w-xs text-center text-sm text-muted" aria-live="polite">
            {handedOver
              ? `That's our logo, drawn by ${SCRIPT.lines.length} lines of Python.`
              : 'Real Python, the kind kids write in class.'}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                setSeconds(0)
                setRun((n) => n + 1)
              }}
              disabled={reduced}
              className="inline-flex items-center gap-1.5 rounded-2xl bg-surface px-3 py-1.5 text-sm font-medium text-grape ring-1 ring-grape/20 hover:bg-grape-pale focus-visible:outline-2 focus-visible:outline-grape-deep disabled:opacity-50"
            >
              <RotateCcw size={15} aria-hidden="true" /> Replay
            </button>
            <button
              type="button"
              aria-pressed={fast}
              onClick={() => setFast((v) => !v)}
              disabled={reduced}
              className={`inline-flex items-center gap-1.5 rounded-2xl px-3 py-1.5 text-sm font-medium ring-1 focus-visible:outline-2 focus-visible:outline-grape-deep disabled:opacity-50 ${
                fast ? 'bg-grape text-surface ring-grape' : 'bg-surface text-grape ring-grape/20 hover:bg-grape-pale'
              }`}
            >
              <FastForward size={15} aria-hidden="true" /> Faster
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function CodePane({ frame }: { frame: ReturnType<typeof frameAt> }) {
  const pane = useRef<HTMLPreElement>(null)
  const active = useRef<HTMLSpanElement>(null)

  // Keep the line being typed in view: scroll the pane itself, never the page.
  useEffect(() => {
    const p = pane.current
    const a = active.current
    if (!p || !a) return
    const target = a.offsetTop - p.clientHeight / 2
    if (Math.abs(p.scrollTop - target) > 24) p.scrollTop = Math.max(0, target)
  }, [frame.active])

  // While a line types, `line` is its index; once it has typed and is drawing, `line` has
  // moved past it. `active` is the line on screen either way.
  const visible = frame.done ? SCRIPT.lines.length : frame.active + 1

  return (
    <pre
      ref={pane}
      aria-label="turtle.py"
      className="h-full min-h-40 overflow-auto bg-night py-4 font-mono text-[13px] leading-6 text-cream"
    >
      {SCRIPT.lines.slice(0, visible).map((line, n) => {
        const typing = n === frame.line && n === frame.active
        const text = typing ? line.code.slice(0, frame.chars) : line.code
        const on = n === frame.active
        return (
          <span
            key={n}
            ref={on ? active : undefined}
            className={`flex pr-4 ${on ? 'bg-night-raise' : ''}`}
          >
            <span aria-hidden="true" className="w-10 shrink-0 select-none pr-3 text-right text-lavender/60">
              {n + 1}
            </span>
            <span className="whitespace-pre">
              <Highlighted code={text} />
              {typing ? <span aria-hidden="true" className="ml-px inline-block h-4 w-[2px] translate-y-0.5 bg-lemon" /> : null}
            </span>
          </span>
        )
      })}
    </pre>
  )
}

const TOKEN = /(#.*$)|("[^"]*"?)|\b(import|def|for|in)\b|\b(\d+(?:\.\d+)?)\b/g

/** Just enough colour to read as an editor: the editor theme's keyword, string and number hues. */
export function Highlighted({ code }: { code: string }) {
  const parts = useMemo(() => {
    const out: { text: string; className?: string }[] = []
    let at = 0
    for (const m of code.matchAll(TOKEN)) {
      if (m.index > at) out.push({ text: code.slice(at, m.index) })
      const className = m[1] ? 'text-lavender italic' : m[2] ? 'text-lemon' : m[3] ? 'text-strawberry' : 'text-good'
      out.push({ text: m[0], className })
      at = m.index + m[0].length
    }
    if (at < code.length) out.push({ text: code.slice(at) })
    return out
  }, [code])
  return (
    <>
      {parts.map((p, i) => (
        <span key={i} className={p.className}>
          {p.text}
        </span>
      ))}
    </>
  )
}

function Drawing({ frame, faded }: { frame: ReturnType<typeof frameAt>; faded: boolean }) {
  const { steps } = SCRIPT
  const drawn = steps.slice(0, frame.steps)
  const current = frame.done ? null : steps[frame.steps]
  const partial = current?.shape.kind === 'line' && frame.partial > 0 ? current.shape : null

  const before = drawn.at(-1)
  let x = before?.x ?? 100
  let y = before?.y ?? 100
  let heading = before?.heading ?? 0
  if (partial && current) {
    x = partial.x1 + (partial.x2 - partial.x1) * frame.partial
    y = partial.y1 + (partial.y2 - partial.y1) * frame.partial
    heading = current.heading
  }

  return (
    <svg
      viewBox="0 0 200 200"
      width={SIZE}
      height={SIZE}
      aria-hidden="true"
      className={`absolute inset-0 transition-opacity duration-700 motion-reduce:transition-none ${faded ? 'opacity-0' : 'opacity-100'}`}
    >
      {drawn.map((step, i) => (
        <ShapeEl key={i} shape={step.shape} />
      ))}
      {partial ? (
        <ShapeEl
          shape={{
            ...partial,
            x2: partial.x1 + (partial.x2 - partial.x1) * frame.partial,
            y2: partial.y1 + (partial.y2 - partial.y1) * frame.partial,
          }}
        />
      ) : null}
      {!frame.done ? (
        <g transform={`translate(${x} ${y}) rotate(${-heading})`}>
          <path d="M7 0 L-6 -5.5 L-3 0 L-6 5.5 Z" fill="#3a2391" stroke="#ffffff" strokeWidth="1.2" strokeLinejoin="round" />
        </g>
      ) : null}
    </svg>
  )
}

function ShapeEl({ shape }: { shape: Shape }) {
  switch (shape.kind) {
    case 'line':
      return (
        <line
          x1={shape.x1}
          y1={shape.y1}
          x2={shape.x2}
          y2={shape.y2}
          stroke={shape.colour}
          strokeWidth={shape.width}
          strokeLinecap="round"
        />
      )
    case 'fill':
      return <polygon points={shape.points.map((p) => p.join(',')).join(' ')} fill={shape.colour} />
    case 'dot':
      return <circle cx={shape.x} cy={shape.y} r={shape.size / 2} fill={shape.colour} />
  }
}
