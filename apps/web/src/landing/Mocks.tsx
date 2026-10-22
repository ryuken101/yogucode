/**
 * The landing page's live class view, played from a script with made-up children. No
 * API calls; nothing here is a real class.
 *
 * They use the product's own state colours and words: lemon "not yet", mint for passing,
 * and no red anywhere (`apps/web/CLAUDE.md`).
 */

import { Check, Hand } from 'lucide-react'
import { Badge } from '../components/Badge'
import { useTicker } from './useMedia'

/** The lesson's ladder: two 1-dot problems, a 2-dot and a 3-dot extension (spec §3.3). */
const LADDER = [1, 1, 2, 3]
const NEVER = 99

interface Kid {
  name: string
  /** The tick each problem on the ladder passes. */
  passes: number[]
  /** Signals shown from a tick onwards, the last one that has started wins. */
  signals?: [from: number, text: string | null, tone: 'not-yet' | 'good' | 'active'][]
}

const CLASS: Kid[] = [
  { name: 'Aria', passes: [1, 2, 4, 6], signals: [[6, 'Finished early', 'good']] },
  { name: 'Leo', passes: [2, 4, 7, NEVER] },
  {
    name: 'Noah',
    passes: [6, 8, NEVER, NEVER],
    signals: [
      [2, 'Same error 4 times', 'not-yet'],
      [4, 'Ms Lee is helping', 'active'],
      [6, null, 'good'],
    ],
  },
  { name: 'Mia', passes: [2, 3, 6, 9] },
  { name: 'Zara', passes: [1, 3, 5, 8] },
]
const LAST_TICK = 9

type Status = 'waiting' | 'working' | 'passed'

function statusOf(kid: Kid, problem: number, tick: number): Status {
  if (kid.passes[problem] <= tick) return 'passed'
  if (problem === 0 || kid.passes[problem - 1] <= tick) return 'working'
  return 'waiting'
}

function signalOf(kid: Kid, tick: number) {
  const started = (kid.signals ?? []).filter(([from]) => from <= tick)
  const last = started.at(-1)
  return last && last[1] ? { text: last[1], tone: last[2] } : null
}

export function LiveClassMock() {
  const tick = useTicker(1300, LAST_TICK)
  const passing = CLASS.filter((kid) => kid.passes[1] <= tick).length

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-semibold text-grape">Lesson 6 · for loops</p>
        <p className="text-sm text-muted">
          {passing} of {CLASS.length} past the first rung
        </p>
      </div>
      <ul className="flex flex-col gap-2" aria-label="Children in the lesson">
        {CLASS.map((kid) => {
          const signal = signalOf(kid, tick)
          return (
            <li key={kid.name} className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-surface px-3 py-2">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-grape-pale text-sm font-semibold text-grape">
                {kid.name[0]}
              </span>
              <span className="w-12 font-medium text-grape">{kid.name}</span>
              <span className="flex gap-1.5">
                {LADDER.map((dots, i) => (
                  <Rung key={i} dots={dots} status={statusOf(kid, i, tick)} />
                ))}
              </span>
              <span className="ml-auto">
                {signal ? (
                  signal.tone === 'active' ? (
                    <Badge variant="active">
                      <Hand size={12} aria-hidden="true" className="mr-1" />
                      {signal.text}
                    </Badge>
                  ) : (
                    <Badge variant={signal.tone}>{signal.text}</Badge>
                  )
                ) : null}
              </span>
            </li>
          )
        })}
      </ul>
      <p className="mt-auto text-sm text-muted">
        Who needs you right now, not ten screens to watch. Press Help and you type in their
        file with them.
      </p>
    </div>
  )
}

function Rung({ dots, status }: { dots: number; status: Status }) {
  const label = `${dots}-dot problem: ${status === 'passed' ? 'passing' : status === 'working' ? 'working on it' : 'not started'}`
  const look =
    status === 'passed'
      ? 'bg-good text-surface'
      : status === 'working'
        ? 'bg-not-yet/40 text-grape ring-1 ring-not-yet motion-safe:animate-pulse'
        : 'bg-cream text-muted/60 ring-1 ring-line'
  return (
    <span role="img" aria-label={label} title={label} className={`flex h-7 w-9 items-center justify-center rounded-xl text-[10px] font-semibold transition-colors ${look}`}>
      {status === 'passed' ? <Check size={14} strokeWidth={3} aria-hidden="true" /> : '•'.repeat(dots)}
    </span>
  )
}
