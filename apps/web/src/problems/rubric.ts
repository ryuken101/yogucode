/**
 * The rubric's two pre-filled dimensions, from a re-run of a child's code (spec §3.5).
 *
 * The same rule as `app/homework.py:correct_from` on the server; the browser computes it
 * because the browser is where the code runs.
 */

import type { TestRun } from '../runtime/protocol'

/** Rubric Correct from a re-run — the same rule as `app/homework.py:correct_from`. */
export function correctFrom(run: TestRun | null | undefined): number {
  if (!run || run.compile_error || run.results.length === 0) return 0
  const passed = run.results.filter((r) => r.passed).length
  if (passed === run.results.length) return 2
  return passed > 0 ? 1 : 0
}

/** "Runs" means Python could read it and at least one check ran without an error. */
export function runsFrom(run: TestRun | null | undefined): boolean {
  return Boolean(run && !run.compile_error && run.results.some((r) => !r.error))
}
