/**
 * A part's checks as a child sees them: how many there are before a Check, then
 * "3 of 5 passing" and each result — in `good` and `not-yet`, never red (§3.4).
 *
 * Shared by the attempt page and the teacher's "Preview as student".
 */

import { Notice } from '../components/Notice'
import type { TestRun } from '../runtime/protocol'
import { PassingSummary, TestResultLine } from './TestResults'

interface Props {
  /** Off during a quiz unless the teacher allowed checks. */
  enabled: boolean
  count: number
  /** Undefined before the first Check; null when one was stopped. */
  run: TestRun | null | undefined
  /** On a shared file, each part's checks run against the whole program. */
  sharedFile?: boolean
}

export function ChecksPanel({ enabled, count, run, sharedFile = false }: Props) {
  return (
    <section aria-label="Checks" className="flex flex-col gap-2">
      <h2 className="font-display font-semibold text-lg text-grape">Checks</h2>
      {!enabled ? (
        <p className="text-sm text-muted">
          Checks are off for this quiz — use Run to try your code yourself.
        </p>
      ) : run === undefined ? (
        <p className="text-sm text-muted">
          Press <strong>Check</strong> to see how your code does on {count} check
          {count === 1 ? '' : 's'}
          {sharedFile ? ' for this part. All the parts are in the one file' : ''}.
        </p>
      ) : run === null ? (
        <Notice tone="not-yet">The check was stopped before it finished.</Notice>
      ) : (
        <>
          <PassingSummary results={run.results} />
          {run.compile_error ? (
            <Notice tone="not-yet">Python could not read your code: {run.compile_error}</Notice>
          ) : (
            run.results.map((result, index) => <TestResultLine key={index} result={result} />)
          )}
        </>
      )}
    </section>
  )
}
