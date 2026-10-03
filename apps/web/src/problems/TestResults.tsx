/**
 * One test's outcome, for a teacher checking a solution or a child checking their code.
 *
 * Sage for passing, amber for "not yet" — never rust, never a red cross (spec §3.4, §8).
 * A hidden test shows only whether it passed; its result carries nothing else anyway
 * (see `grader.py`).
 */

import type { TestResult } from '../runtime/protocol'

export function TestResultLine({ result }: { result: TestResult }) {
  return (
    <div
      className={`rounded-lg px-3 py-2 text-sm ring-1 ${
        result.passed ? 'bg-sage/10 ring-sage/40' : 'bg-amber/10 ring-amber/40'
      }`}
    >
      <p className="font-medium text-ink">
        {result.passed ? '✓ ' : '○ '}
        {result.name}
        {result.hidden ? <span className="ml-2 text-xs text-ink-soft">(hidden)</span> : null}
      </p>
      {!result.passed && result.error ? (
        <p className="mt-1 font-mono text-xs text-ink">{result.error}</p>
      ) : null}
      {!result.passed && !result.error && result.expected !== undefined ? (
        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 font-mono text-xs text-ink">
          <dt className="text-ink-soft">expected</dt>
          <dd className="whitespace-pre-wrap">{result.expected}</dd>
          <dt className="text-ink-soft">got</dt>
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
    <p className={`text-sm font-medium ${all ? 'text-sage' : 'text-ink'}`}>
      {passed} of {results.length} passing
    </p>
  )
}
