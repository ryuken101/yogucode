/**
 * How the program should run: a sample run of the teacher's solution, played back in a
 * terminal (Ken's decision, 17 Oct 2026).
 *
 * The point is the *order* of things in a program that talks to you — the prompt, what you
 * type, what it prints back — which a description in words gets across badly. So the run
 * plays as if it were happening: output appears a line at a time and the inputs are typed
 * a letter at a time, with Replay to watch it again. With reduced motion asked for, it is
 * all there at once.
 *
 * It looks like `Console` on purpose, and uses its colours: cream for what the program
 * printed, lavender for what was typed. Nothing in a sample run is a mistake, so nothing
 * here is lemon either.
 */

import { useEffect, useMemo, useState } from 'react'
import type { ExamplePiece } from '../runtime/protocol'
import { Button } from './Button'

const LINE_MS = 280
const KEY_MS = 110
const ENTER_MS = 350

/** Whether to skip the playback. No `matchMedia` (a test, an old browser) means skip. */
function reducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

interface Step {
  piece: number
  /** How much of the piece is showing once this step has played. */
  chars: number
  delay: number
}

/** The playback as steps: a line of output at a time, a key of input at a time. */
function stepsOf(pieces: ExamplePiece[]): Step[] {
  const steps: Step[] = []
  pieces.forEach((piece, index) => {
    if (piece.kind === 'in') {
      for (let n = 1; n <= piece.text.length; n += 1) steps.push({ piece: index, chars: n, delay: KEY_MS })
      // The Enter that sends it.
      steps.push({ piece: index, chars: piece.text.length + 1, delay: ENTER_MS })
      return
    }
    let at = 0
    while (at < piece.text.length) {
      const newline = piece.text.indexOf('\n', at)
      at = newline === -1 ? piece.text.length : newline + 1
      steps.push({ piece: index, chars: at, delay: LINE_MS })
    }
  })
  return steps
}

function Playback({ pieces }: { pieces: ExamplePiece[] }) {
  const steps = useMemo(() => stepsOf(pieces), [pieces])
  const [played, setPlayed] = useState(() => (reducedMotion() ? steps.length : 0))
  const [round, setRound] = useState(0)

  useEffect(() => {
    if (played >= steps.length) return
    const timer = setTimeout(() => setPlayed((n) => n + 1), steps[played]!.delay)
    return () => clearTimeout(timer)
  }, [played, steps, round])

  const done = played >= steps.length
  const last = played > 0 ? steps[played - 1]! : null
  const shown = pieces.flatMap((piece, index) => {
    if (done || (last && index < last.piece)) return [{ piece, text: piece.text, enter: true }]
    if (last && index === last.piece) {
      const text = piece.text.slice(0, last.chars)
      return [{ piece, text, enter: piece.kind === 'in' && last.chars > piece.text.length }]
    }
    return []
  })
  const typing = !done && last !== null && pieces[last.piece]?.kind === 'in'

  return (
    <div className="flex flex-col gap-2">
      <div
        aria-label="Example run"
        className="min-h-24 overflow-y-auto rounded-lg bg-night p-3 font-mono text-sm ring-1 ring-grape/30"
      >
        <span className="whitespace-pre-wrap break-words">
          {shown.map(({ piece, text, enter }, index) =>
            piece.kind === 'in' ? (
              <span key={index} className="text-lavender">
                {text}
                {enter ? '\n' : ''}
              </span>
            ) : (
              <span key={index} className="text-cream">
                {text}
              </span>
            ),
          )}
          {!done ? (
            <span aria-hidden="true" className={typing ? 'text-lavender' : 'animate-pulse text-lavender'}>
              ▍
            </span>
          ) : null}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="quiet"
          onClick={() => {
            setPlayed(0)
            setRound((n) => n + 1)
          }}
        >
          Replay
        </Button>
        {done ? null : (
          <Button variant="quiet" onClick={() => setPlayed(steps.length)}>
            Show it all
          </Button>
        )}
      </div>
    </div>
  )
}

interface Props {
  /** The runs to show, each one a transcript. Nothing to show renders nothing. */
  examples: ExamplePiece[][]
  title?: string
}

export function ExampleRun({ examples, title = 'How it should run' }: Props) {
  const [active, setActive] = useState(0)
  const runs = examples.filter((run) => run.length > 0)
  if (runs.length === 0) return null
  const index = Math.min(active, runs.length - 1)

  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-display text-base font-semibold text-grape">{title}</h3>
        {runs.length > 1 ? (
          <div role="tablist" aria-label="Examples" className="flex gap-1">
            {runs.map((_, n) => (
              <button
                key={n}
                type="button"
                role="tab"
                aria-selected={n === index}
                onClick={() => setActive(n)}
                className={`rounded-md px-2 py-0.5 text-xs ring-1 ${
                  n === index ? 'bg-grape-pale ring-grape' : 'bg-surface ring-grape/20'
                }`}
              >
                Example {n + 1}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {/* Keyed so a different example starts from the top rather than mid-way. */}
      <Playback key={index} pieces={runs[index]!} />
    </section>
  )
}
