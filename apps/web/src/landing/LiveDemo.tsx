/**
 * How a live class works, played as a short film (Ken, 23 Oct 2026). Noah's laptop is on
 * the left and his teacher's Live view on the right. As he types, his tile shows the same
 * code. When he gets stuck her pointer clicks his tile, then Help, and she types the fix
 * into his editor, which appears on his screen.
 *
 * The timeline is `liveScript.ts`. This file runs the clock and draws the scene. The stage
 * is a picture (`aria-hidden`), and the chapter buttons and caption below it tell the same
 * story in words. It plays once it's in view and loops. Under reduced motion it doesn't
 * move by itself, and each chapter button shows that chapter's finished moment. Colours
 * follow the product's: lemon for the error, mint for passing, and a strawberry caret for
 * the other person's cursor, as in `collab/remoteCaret.ts`.
 */

import { Check, Hand, Pause, Play, RotateCcw } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { Badge } from '../components/Badge'
import { LIVE_CHAPTERS } from './copy'
import { CHAPTER_STARTS, CHILD, LENGTH, TEACHER, sceneAt } from './liveScript'
import type { Scene, Target } from './liveScript'
import { Highlighted } from './TurtleWindow'
import { useReducedMotion, useSeen } from './useMedia'

/** The moment a chapter is shown at: its start while playing, its last moment when still. */
function chapterTime(i: number, still: boolean) {
  if (!still) return CHAPTER_STARTS[i] + 0.05
  return (CHAPTER_STARTS[i + 1] ?? LENGTH) - 0.05
}

export function LiveDemo() {
  const reduced = useReducedMotion()
  const box = useRef<HTMLDivElement>(null)
  const seen = useSeen(box)
  const [paused, setPaused] = useState(false)
  const [seconds, setSeconds] = useState(() => (reduced ? chapterTime(0, true) : 0))
  const clock = useRef(seconds)
  const playing = seen && !reduced && !paused

  useEffect(() => {
    if (!playing) return
    let last = performance.now()
    let frame = 0
    const tick = (now: number) => {
      clock.current = (clock.current + Math.max(0, now - last) / 1000) % LENGTH
      last = now
      setSeconds(clock.current)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing])

  function jump(t: number) {
    clock.current = t
    setSeconds(t)
  }

  // Until it scrolls into view it shows Noah's finished typing, then plays from the start.
  const scene = sceneAt(seen || reduced ? seconds : chapterTime(0, true))
  const chapter = LIVE_CHAPTERS[scene.chapter]

  return (
    <div ref={box} className="mx-auto max-w-5xl">
      <div aria-hidden="true" className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <Laptop scene={scene} />
        <LiveView scene={scene} />
      </div>

      <div className="mt-6 flex flex-col items-center gap-4">
        <p className="min-h-[3em] max-w-xl text-center text-lg text-grape">{chapter.caption}</p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <ol className="flex flex-wrap justify-center gap-2">
            {LIVE_CHAPTERS.map((c, i) => (
              <li key={c.title}>
                <button
                  type="button"
                  aria-pressed={i === scene.chapter}
                  onClick={() => jump(chapterTime(i, reduced || paused))}
                  className={`rounded-full px-3 py-1.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-grape-deep ${
                    i === scene.chapter ? 'bg-grape text-surface' : 'bg-surface text-grape ring-1 ring-line hover:bg-grape-pale'
                  }`}
                >
                  {c.title}
                </button>
              </li>
            ))}
          </ol>
          {!reduced ? (
            <span className="flex gap-1">
              <IconButton label={paused ? 'Play' : 'Pause'} onClick={() => setPaused((p) => !p)}>
                {paused ? <Play size={16} aria-hidden="true" /> : <Pause size={16} aria-hidden="true" />}
              </IconButton>
              <IconButton
                label="Start again"
                onClick={() => {
                  jump(0)
                  setPaused(false)
                }}
              >
                <RotateCcw size={16} aria-hidden="true" />
              </IconButton>
            </span>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex h-9 w-9 items-center justify-center rounded-full bg-surface text-grape ring-1 ring-line hover:bg-grape-pale focus-visible:outline-2 focus-visible:outline-grape-deep"
    >
      {children}
    </button>
  )
}

// --- the code, with cursors --------------------------------------------------------------

interface Mark {
  at: number
  /** Someone else's cursor: strawberry, with their name. */
  remote?: string
}

/** Code with cursors in it. `numbers` adds a gutter, as on the child's editor. */
function Code({ code, marks, numbers, className }: { code: string; marks: Mark[]; numbers?: boolean; className: string }) {
  const lines = code.split('\n')
  const starts = lines.map((_, n) => lines.slice(0, n).reduce((sum, l) => sum + l.length + 1, 0))
  return (
    <pre className={`font-mono text-cream ${className}`}>
      {lines.map((line, n) => {
        const start = starts[n]
        const here = marks.filter((m) => m.at >= start && m.at <= start + line.length).sort((a, b) => a.at - b.at)
        const pieces: React.ReactNode[] = []
        let at = 0
        here.forEach((m, i) => {
          const cut = m.at - start
          pieces.push(<Highlighted key={`t${i}`} code={line.slice(at, cut)} />)
          pieces.push(<Caret key={`c${i}`} remote={m.remote} />)
          at = cut
        })
        pieces.push(<Highlighted key="end" code={line.slice(at)} />)
        return (
          <span key={n} className="flex">
            {numbers ? <span className="w-8 shrink-0 pr-3 text-right text-lavender/60">{n + 1}</span> : null}
            <span className="whitespace-pre">{pieces}</span>
          </span>
        )
      })}
    </pre>
  )
}

function Caret({ remote }: { remote?: string }) {
  if (!remote) {
    return <span className="inline-block h-[1.15em] w-[2px] translate-y-[0.2em] bg-cream motion-safe:animate-pulse" />
  }
  return (
    <span className="relative inline-block h-[1.15em] w-[2px] translate-y-[0.2em] bg-strawberry">
      <span className="absolute -top-[1.15em] left-0 rounded-sm bg-strawberry px-1 font-sans text-[10px] leading-[1.1em] font-semibold whitespace-nowrap text-surface">
        {remote}
      </span>
    </span>
  )
}

// --- Noah's laptop -----------------------------------------------------------------------

function Laptop({ scene }: { scene: Scene }) {
  const marks: Mark[] = []
  if (scene.childCaret !== null) marks.push({ at: scene.childCaret })
  if (scene.teacherCaret !== null) marks.push({ at: scene.teacherCaret, remote: TEACHER })
  return (
    <figure className="flex h-[400px] flex-col overflow-hidden rounded-3xl border border-night bg-night">
      <figcaption className="flex items-center gap-2 bg-night-raise px-4 py-2 text-xs font-medium text-lavender">
        {CHILD}’s laptop · greet.py
        <span className="ml-auto rounded-lg bg-good/90 px-2 py-0.5 text-[11px] font-semibold text-night">▶ Run</span>
      </figcaption>
      {scene.helping ? (
        <p className="flex items-center gap-2 bg-grape-pale px-4 py-2 text-xs text-grape">
          <Hand size={13} aria-hidden="true" className="shrink-0" />
          Your teacher is helping — watch your code. You can type again when they’re done.
        </p>
      ) : null}
      <Code code={scene.code} marks={marks} numbers className="px-0 pt-5 pb-3 text-[13px] leading-6" />
      <div className="mt-auto min-h-[120px] border-t border-night-raise px-4 py-3 font-mono text-xs leading-5 text-cream">
        <ConsoleView scene={scene} />
      </div>
    </figure>
  )
}

function ConsoleView({ scene }: { scene: Scene }) {
  const c = scene.console
  if (c.kind === 'empty') return <p className="text-lavender">Press Run to try your code.</p>
  if (c.kind === 'error') {
    return (
      <>
        <p className="text-lavender">File "greet.py", line 2</p>
        <p className="text-not-yet">SyntaxError: expected ':'</p>
      </>
    )
  }
  return (
    <>
      <p>
        Name? <span className="text-lavender">{c.answer}</span>
      </p>
      {c.output ? [1, 2, 3].map((n) => <p key={n}>Hi {c.answer}</p>) : null}
      {c.passed ? (
        <p className="mt-1 flex items-center gap-1 font-sans text-good">
          <Check size={14} strokeWidth={3} aria-hidden="true" /> 3 of 3 checks pass
        </p>
      ) : null}
    </>
  )
}

// --- the teacher's Live view ---------------------------------------------------------------

/** The rest of the class, standing still: name, code, and what their tile says. */
const OTHERS: { name: string; code: string; check?: string; flag?: 'all passing' }[] = [
  { name: 'Aria', code: 'for i in range(3):\n    print("Hi", name)', check: '3 of 3 passing', flag: 'all passing' },
  { name: 'Leo', code: 'name = input("Name? ")\nprint("Hi" name)', check: 'does not run' },
  { name: 'Mia', code: 'name = input("Name? ")\nfor i in range(3):', check: '1 of 3 passing' },
]

function LiveView({ scene }: { scene: Scene }) {
  const pane = useRef<HTMLDivElement>(null)
  const tile = useRef<HTMLDivElement>(null)
  const help = useRef<HTMLSpanElement>(null)
  const arrow = useRef<HTMLSpanElement>(null)
  const spots = useRef<Record<Target, { x: number; y: number }>>({
    start: { x: 0, y: 0 },
    tile: { x: 0, y: 0 },
    help: { x: 0, y: 0 },
  })

  // The pointer's targets move with the layout, so measure them every frame, then put the
  // pointer between them. It's written to the DOM here because it depends on the layout.
  const { pointer } = scene
  useLayoutEffect(() => {
    const area = pane.current?.getBoundingClientRect()
    if (!area) return
    const at = spots.current
    at.start = { x: area.width * 0.92, y: area.height * 0.96 }
    const centre = (el: RefObject<HTMLElement | null>, key: Target) => {
      const box = el.current?.getBoundingClientRect()
      if (box) at[key] = { x: box.left - area.left + box.width / 2, y: box.top - area.top + box.height / 2 }
    }
    centre(tile, 'tile')
    centre(help, 'help')
    if (!pointer || !arrow.current) return
    const a = at[pointer.from]
    const b = at[pointer.to]
    arrow.current.style.transform = `translate(${a.x + (b.x - a.x) * pointer.p}px, ${a.y + (b.y - a.y) * pointer.p}px)`
    arrow.current.style.visibility = 'visible'
  })

  const noahFlags = (
    <>
      {scene.passing ? <Badge variant="good">all passing</Badge> : null}
      {!scene.passing && scene.errors >= 4 ? <Badge variant="not-yet">same error ×{scene.errors}</Badge> : null}
      {scene.helping ? <Badge variant="active">you are helping</Badge> : null}
    </>
  )
  const childMarks: Mark[] = []
  if (scene.childCaret !== null) childMarks.push({ at: scene.childCaret, remote: CHILD })
  if (scene.teacherCaret !== null) childMarks.push({ at: scene.teacherCaret })

  return (
    <figure ref={pane} className="relative flex h-[400px] flex-col overflow-hidden rounded-3xl border border-line bg-cream">
      <figcaption className="border-b border-line bg-surface px-4 py-2 text-xs font-medium text-muted">
        {TEACHER}’s screen · Live · Year 4–6 Python
      </figcaption>

      {scene.view === 'grid' ? (
        <div className="grid min-h-0 flex-1 grid-cols-2 grid-rows-2 gap-2 p-3">
          {[OTHERS[0], null, OTHERS[1], OTHERS[2]].map((o, i) =>
            o === null ? (
              <Tile
                key={CHILD}
                ref={tile}
                name={CHILD}
                hot={scene.pointer?.to === 'tile' && scene.pointer.p >= 1}
                code={<Code code={scene.code} marks={childMarks} className="text-[10px] leading-snug" />}
                footer={
                  <>
                    {scene.errors > 0 ? <span>does not run</span> : null}
                    {noahFlags}
                  </>
                }
              />
            ) : (
              <Tile
                key={i}
                name={o.name}
                code={<Code code={o.code} marks={[]} className="text-[10px] leading-snug" />}
                footer={
                  <>
                    {o.check ? <span>{o.check}</span> : null}
                    {o.flag ? <Badge variant="good">{o.flag}</Badge> : null}
                  </>
                }
              />
            ),
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-display text-lg font-semibold text-grape">{CHILD}</span>
            <span className="text-xs text-muted">greet.py</span>
            {noahFlags}
            <span
              ref={help}
              className={`ml-auto rounded-2xl px-3 py-1.5 text-xs font-medium transition-colors ${
                scene.helping ? 'bg-grape text-surface' : 'bg-surface text-grape ring-1 ring-grape/20'
              }`}
            >
              {scene.helping ? 'Done helping' : 'Help — take over their editor'}
            </span>
          </div>
          <p className="min-h-[1.25rem] text-xs text-muted">
            {scene.helping ? `You and ${CHILD} are both typing in this editor.` : ''}
          </p>
          <div className="min-h-0 flex-1 overflow-hidden rounded-2xl bg-night ring-1 ring-grape/25">
            <Code code={scene.code} marks={childMarks} numbers className="pt-5 pb-3 text-[13px] leading-6" />
          </div>
        </div>
      )}

      {pointer ? <PointerArrow ref={arrow} down={pointer.down} /> : null}
    </figure>
  )
}

function Tile({
  ref,
  name,
  code,
  footer,
  hot = false,
}: {
  ref?: RefObject<HTMLDivElement | null>
  name: string
  code: React.ReactNode
  footer: React.ReactNode
  hot?: boolean
}) {
  return (
    <div ref={ref} className={`flex min-h-0 flex-col rounded-2xl bg-surface p-2 ring-1 ${hot ? 'ring-2 ring-grape' : 'ring-line'}`}>
      <span className="flex items-center gap-1.5">
        <span className="size-2 rounded-full bg-good" />
        <span className="text-xs font-medium text-grape">{name}</span>
        <span className="ml-auto text-[10px] text-muted">greet.py</span>
      </span>
      <div className="mt-1.5 min-h-0 flex-1 overflow-hidden rounded-md bg-night p-1.5 pt-3">{code}</div>
      <span className="mt-1.5 flex min-h-5 flex-wrap items-center gap-1 text-[10px] text-muted">{footer}</span>
    </div>
  )
}

/** Positioned by `LiveView`'s layout effect; hidden until it has been. */
function PointerArrow({ ref, down }: { ref: RefObject<HTMLSpanElement | null>; down: boolean }) {
  return (
    <span ref={ref} className="pointer-events-none invisible absolute top-0 left-0 z-10">
      {down ? <span className="absolute -top-3 -left-3 h-6 w-6 rounded-full bg-grape/25" /> : null}
      <svg
        width="22"
        height="22"
        viewBox="0 0 22 22"
        className={`relative -translate-x-[3px] -translate-y-[2px] transition-transform duration-100 ${down ? 'scale-85' : ''}`}
      >
        <path d="M3 2 L3 18 L7.5 14 L10.5 20.5 L13.5 19 L10.5 12.8 L16.5 12.8 Z" fill="#1a1233" stroke="#ffffff" strokeWidth="1.5" strokeLinejoin="round" />
      </svg>
    </span>
  )
}
