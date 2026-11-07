/**
 * Run a child's answer while marking, to see what it really does (Ken, 7 Nov 2026). Nothing is
 * saved and no mark changes: the re-run checks are still what fill those in.
 *
 * Its own worker, because a program waiting at `input()` or stuck in a loop would otherwise hold
 * up the re-run of the whole class's checks. Each run gets fresh globals, or the last child's
 * variables would hide this child's mistake. One worker across children, since a new one takes
 * seconds to start, so `ranFor` keeps one child's output from showing under the next.
 */

import { useEffect, useRef, useState } from 'react'
import { Button } from '../components/Button'
import { Console } from '../components/Console'
import { Notice } from '../components/Notice'
import { Spinner } from '../components/Spinner'
import { usePython } from '../runtime/usePython'

export function RunAnswer({ code, owner }: { code: string; owner: string }) {
  const { state, output, run, stop, answer } = usePython()
  const [ranFor, setRanFor] = useState<string | null>(null)

  // Moving on stops what's running. Only then: a stop with nothing running has nothing to end.
  const busyNow = useRef(false)
  useEffect(() => {
    busyNow.current = state.status === 'running' || state.status === 'asking'
  })
  useEffect(
    () => () => {
      if (busyNow.current) stop()
    },
    [owner, stop],
  )

  if (state.status === 'unsupported') {
    return (
      <div className="mt-3">
        <Notice tone="system-error">{state.reason}</Notice>
      </div>
    )
  }

  const busy = state.status === 'running' || state.status === 'asking'
  const mine = ranFor === owner
  return (
    <div className="mt-3 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          disabled={busy || state.status === 'loading'}
          onClick={() => {
            setRanFor(owner)
            run(code, { fresh: true })
          }}
        >
          {busy ? 'Running…' : 'Run'}
        </Button>
        <Button variant="quiet" onClick={stop} disabled={!busy}>
          Stop
        </Button>
        {state.status === 'loading' ? <Spinner label={state.detail} /> : null}
      </div>
      {mine ? (
        <div className="h-48">
          <Console segments={output} asking={state.status === 'asking'} onAnswer={answer} />
        </div>
      ) : null}
    </div>
  )
}
