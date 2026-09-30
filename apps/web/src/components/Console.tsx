/**
 * The terminal: program output, and where the child types when the program asks.
 *
 * **Input happens here, inline, not in a box below.** A terminal is where you type, and
 * these students will meet a real shell soon enough — a separate "answer" field would
 * teach a mental model they then have to unlearn. So when `input()` runs, a caret appears
 * exactly where the cursor would be in a real terminal: immediately after the prompt the
 * program printed, on the same line.
 *
 * That only works because the runtime forwards **raw bytes** rather than whole lines.
 * `input("Name? ")` writes its prompt without a newline, so the text flows straight into
 * the caret.
 *
 * **product-spec §8's rule bites hardest here.** A Python traceback is a *student's
 * mistake* — `SyntaxError`, `NameError`, a typo — and must never be rust. Every other tool
 * a programmer has used prints errors in red, so this is the easiest convention in the
 * codebase to break by reflex, and the audience is nine-year-olds. stderr is **amber**:
 * "not yet". Rust appears only when the fault is ours.
 */

import { useEffect, useRef, useState } from 'react'
import type { OutputSegment } from '../runtime/usePython'

// On the dark surface the palette still holds, just inverted: cream for ordinary output
// where ink would be on paper. Amber and sage read well on ink-deep, which is why the §8
// colours survive the change of background.
const STREAM_CLASS: Record<OutputSegment['stream'], string> = {
  stdout: 'text-cream',
  // A traceback. Amber, never rust — see the module comment.
  stderr: 'text-amber',
  // The echo of what the child typed. Sky-deep is §8's emphasis colour, so their own
  // words stand out from the program's without implying anything went wrong.
  stdin: 'text-sky-pale',
  // Our own notices — output dropped, and so on. Not an error either.
  system: 'text-cream/50 italic',
}

interface Props {
  segments: OutputSegment[]
  /** True while the program is parked at an `input()` prompt. */
  asking?: boolean
  onAnswer?: (text: string) => void
  placeholder?: string
}

export function Console({
  segments,
  asking = false,
  onAnswer,
  placeholder = 'Press Run to see what your program does.',
}: Props) {
  const [typed, setTyped] = useState('')
  const caret = useRef<HTMLInputElement>(null)
  const end = useRef<HTMLDivElement>(null)

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [segments, asking])

  // A child should not have to work out that the terminal is waiting for them. Focus
  // only — the field is cleared on submit, so clearing here too would be a redundant
  // render.
  useEffect(() => {
    if (asking) caret.current?.focus()
  }, [asking])

  function submit(event: React.FormEvent) {
    event.preventDefault()
    onAnswer?.(typed)
    setTyped('')
  }

  return (
    <div
      // A log, so a screen reader announces new output without stealing focus.
      role="log"
      aria-live="polite"
      aria-label="Program output"
      onClick={() => asking && caret.current?.focus()}
      className="h-full min-h-0 overflow-y-auto rounded-lg bg-ink-deep p-3 font-mono text-sm ring-1 ring-ink/25"
    >
      {segments.length === 0 && !asking ? (
        <p className="text-cream/50">{placeholder}</p>
      ) : (
        // One flow rather than one node per line: output arrives as raw chunks that may
        // end mid-line, and `whitespace-pre-wrap` is what makes them join correctly.
        <span className="whitespace-pre-wrap break-words">
          {segments.map((segment, index) => (
            <span key={index} className={STREAM_CLASS[segment.stream]}>
              {segment.text}
            </span>
          ))}
          {asking ? (
            <form onSubmit={submit} className="inline">
              <input
                ref={caret}
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                aria-label="Your answer"
                autoComplete="off"
                spellCheck={false}
                // Sized to the text so the caret sits where a terminal cursor would,
                // rather than inside a visible field.
                style={{ width: `${Math.max(typed.length, 1)}ch` }}
                className="border-none bg-transparent p-0 font-mono text-sm text-sky-pale caret-sky-pale outline-none"
              />
              {/* A hairline block cursor, so it is obvious the terminal is waiting. */}
              <span aria-hidden="true" className="animate-pulse text-sky-pale">
                ▍
              </span>
            </form>
          ) : null}
        </span>
      )}
      <div ref={end} />
    </div>
  )
}
