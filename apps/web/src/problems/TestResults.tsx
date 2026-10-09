/**
 * One test's outcome, for a teacher checking a solution or a child checking their code.
 *
 * `good` for passing, `not-yet` for "not yet" — never the error colour, never a red cross
 * (spec §3.4).
 * A hidden test shows only whether it passed; its result carries nothing else anyway
 * (see `grader.py`).
 */

import type { TestResult } from '../runtime/protocol'

export function TestResultLine({ result }: { result: TestResult }) {
  return (
    <div
      className={`rounded-lg px-3 py-2 text-sm ring-1 ${
        result.passed ? 'bg-good/10 ring-good/60' : 'bg-not-yet/20 ring-not-yet'
      }`}
    >
      <p className="font-medium text-grape">
        {result.passed ? '✓ ' : '○ '}
        {result.name}
        {result.hidden ? <span className="ml-2 text-xs text-muted">(hidden)</span> : null}
      </p>
      {!result.passed && result.error ? (
        <p className="mt-1 font-mono text-xs text-grape">{result.error}</p>
      ) : null}
      {!result.passed && !result.error && result.expected !== undefined ? (
        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 font-mono text-xs text-grape">
          <dt className="text-muted">expected</dt>
          <dd className="whitespace-pre-wrap">{result.expected}</dd>
          <dt className="text-muted">got</dt>
          <dd className="whitespace-pre-wrap">{result.got || '(nothing printed)'}</dd>
        </dl>
      ) : null}
    </div>
  )
}

/** "3 of 5 passing" — the frame spec §3.4 asks for, instead of a wall of crosses. */
export function PassingSummary({ results }: { results: TestResult[] }) {
  const passed = results.filter((result) => result.passed).length
  const all = passed === results.length
  return (
    <p className={`text-sm font-medium ${all ? 'text-good-ink' : 'text-grape'}`}>
      {passed} of {results.length} passing
    </p>
  )
}
