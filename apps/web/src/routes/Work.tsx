/**
 * Where a student writes and runs Python.
 *
 * Laid out for the actual work rather than for a form: the editor takes most of the height
 * and the terminal sits under it, because a child spends the lesson moving between those
 * two panels and nothing else on this screen earns space.
 *
 * Both panels are dark — a deliberately *considered* dark, built from the §8 palette rather
 * than VS Code's, which is what §8 asks for. The page stays cream around them.
 *
 * There are no problems on screen yet; those are Phase 4. Until then this is usable
 * classwork on its own: the teacher says "write a program that prints your name", and a
 * child does exactly that.
 */

import { useState } from 'react'
import { Button } from '../components/Button'
import { Console } from '../components/Console'
import { Notice } from '../components/Notice'
import { Spinner } from '../components/Spinner'
import { CodeSurface } from '../editor/CodeSurface'
import { usePython } from '../runtime/usePython'

const STARTER = 'name = input("What is your name? ")\nprint("Hello " + name + "!")\n'

export function Work() {
  const { state, output, run, stop, answer } = usePython()
  const [code, setCode] = useState(STARTER)

  const busy = state.status === 'running' || state.status === 'asking'
  const loading = state.status === 'loading'

  if (state.status === 'unsupported') {
    return (
      <div className="mx-auto max-w-2xl px-6 py-16">
        <Notice tone="system-error">{state.reason}</Notice>
      </div>
    )
  }

  return (
    // A full-height column rather than a card: the editor should use the screen a child
    // actually has, which on a laptop is mostly vertical.
    <div className="flex h-dvh flex-col gap-3 bg-cream p-4">
      <div className="flex shrink-0 items-center gap-2">
        <Button variant="primary" onClick={() => run(code)} disabled={busy || loading}>
          {busy ? 'Running…' : 'Run'}
        </Button>
        {/* Not a danger variant: stopping your own program destroys nothing. */}
        <Button variant="secondary" onClick={stop} disabled={!busy}>
          Stop
        </Button>
        {loading ? <Spinner label={state.detail} /> : null}
        {state.status === 'asking' ? (
          <span className="text-sm text-amber">Your program is waiting for you to type.</span>
        ) : null}
      </div>

      {/* The editor gets roughly two thirds; the terminal is legible at a third and grows
          when there is room. min-h-0 is what lets both scroll instead of overflowing. */}
      <div className="min-h-0 flex-[2] overflow-hidden rounded-lg ring-1 ring-ink/20">
        <CodeSurface value={code} onChange={setCode} />
      </div>
      <div className="min-h-0 flex-1">
        <Console segments={output} asking={state.status === 'asking'} onAnswer={answer} />
      </div>
    </div>
  )
}
