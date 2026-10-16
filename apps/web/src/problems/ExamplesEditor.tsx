/**
 * A leaf's examples: sample runs a child can watch (Ken's decision, 17 Oct 2026).
 *
 * The teacher gives only the inputs — one line per `input()` the program asks. "Check
 * solution" runs the reference solution with them, and that run is what the child sees:
 * it is shown here under each example, so the teacher sees exactly that too. Up to three,
 * so a normal case and an edge case can both be shown.
 */

import { Button } from '../components/Button'
import { ExampleRun } from '../components/ExampleRun'
import { Notice } from '../components/Notice'
import type { ExampleRun as Run } from '../runtime/protocol'
import type { ExampleDoc } from './doc'

export const MAX_EXAMPLES = 3

interface Props {
  examples: ExampleDoc[]
  onChange: (examples: ExampleDoc[]) => void
  disabled?: boolean
  /** The last Check solution's runs of these examples, in order; absent before one. */
  runs?: (Run | null)[]
  /** For the empty state: what these are examples of. */
  of?: string
}

export function ExamplesEditor({ examples, onChange, disabled, runs, of = 'this program' }: Props) {
  function setInputs(index: number, text: string) {
    onChange(
      examples.map((example, n) =>
        // One input per line, as typed. A trailing empty line is the one being started.
        n === index ? { ...example, inputs: text === '' ? [] : text.split('\n') } : example,
      ),
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {examples.length === 0 ? (
        <p className="text-sm text-muted">
          Show students how {of} should run — what it asks, what they type, what it prints.
        </p>
      ) : null}
      {examples.map((example, index) => {
        const run = runs?.[index]
        return (
          <div key={index} className="flex flex-col gap-2 rounded-lg bg-cream/40 p-3 ring-1 ring-line">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-grape">Example {index + 1}</p>
              {!disabled ? (
                <Button
                  variant="quiet"
                  onClick={() => onChange(examples.filter((_, n) => n !== index))}
                >
                  Remove
                </Button>
              ) : null}
            </div>
            <label className="flex flex-col gap-1.5 text-sm text-grape">
              <span>
                What the student types <span className="text-muted">— one line per input(), in order</span>
              </span>
              <textarea
                rows={Math.max(2, (example.inputs ?? []).length + 1)}
                value={(example.inputs ?? []).join('\n')}
                disabled={disabled}
                onChange={(event) => setInputs(index, event.target.value)}
                placeholder={'Ken\n9'}
                className="rounded-lg bg-surface px-3 py-2 font-mono text-sm ring-1 ring-grape/25"
              />
            </label>
            {run ? (
              <>
                {run.error ? (
                  <Notice tone="not-yet">The solution stopped on this example: {run.error}</Notice>
                ) : null}
                <ExampleRun examples={[run.transcript]} title="What students will see" />
              </>
            ) : example.transcript ? (
              <ExampleRun examples={[example.transcript]} title="What students see" />
            ) : run === null ? (
              <Notice tone="not-yet">This example was stopped before it finished.</Notice>
            ) : (
              <p className="text-sm text-muted">Check solution to see how it runs.</p>
            )}
          </div>
        )
      })}
      {!disabled && examples.length < MAX_EXAMPLES ? (
        <div>
          <Button
            variant="secondary"
            onClick={() => onChange([...examples, { inputs: [], transcript: null }])}
          >
            Add an example
          </Button>
        </div>
      ) : null}
    </div>
  )
}
