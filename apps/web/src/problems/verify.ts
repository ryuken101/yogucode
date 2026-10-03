/**
 * Run a problem's reference solutions against its own tests, in this browser.
 *
 * The one place "is this problem's solution correct?" is answered — the editor's "Check
 * solution" and the bank's "Check & publish all" both call it, so the two can never
 * disagree about what passing means. Hidden tests are revealed: the teacher wrote them.
 */

import type { Schemas } from '../lib/api'
import type { TestCheck, TestRun } from '../runtime/protocol'
import { leavesOf, toChecks } from './doc'

export type Check = (code: string, tests: TestCheck[]) => Promise<TestRun | null>

export interface Verification {
  /** The saved version the runs were against — what the publish route checks. */
  updatedAt: string
  runs: Record<string, TestRun | null>
}

export function runPassed(run: TestRun | null | undefined): boolean {
  return Boolean(
    run && !run.compile_error && run.results.length > 0 && run.results.every((r) => r.passed),
  )
}

export async function verifyProblem(
  check: Check,
  problem: Schemas['ProblemOut'],
): Promise<Verification> {
  const runs: Record<string, TestRun | null> = {}
  for (const leaf of leavesOf(problem.document)) {
    runs[leaf.key] = await check(
      leaf.leaf.solution_code,
      toChecks(leaf.leaf.tests, { revealHidden: true }),
    )
  }
  return { updatedAt: problem.updated_at, runs }
}

export function allLeavesPass(problem: Schemas['ProblemOut'], verification: Verification): boolean {
  return leavesOf(problem.document).every((leaf) => runPassed(verification.runs[leaf.key]))
}
