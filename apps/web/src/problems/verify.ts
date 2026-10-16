/**
 * Run a problem's reference solutions against its own tests, in this browser.
 *
 * The one place "is this problem's solution correct?" is answered — the editor's "Check
 * solution" and the bank's "Check & publish all" both call it, so the two can never
 * disagree about what passing means. Hidden tests are revealed: the teacher wrote them.
 *
 * It also runs the problem's examples (17 Oct 2026) with the same solution, and keeps what
 * each run looked like: publishing sends those transcripts, which is how a child gets to
 * watch the solution run without ever being sent it.
 */

import type { Schemas } from '../lib/api'
import type { ExampleRun, TestCheck, TestRun } from '../runtime/protocol'
import { exampleLeaves, leavesOf, solutionOf, toChecks, type ExamplePiece } from './doc'

export interface Runner {
  check: (code: string, tests: TestCheck[]) => Promise<TestRun | null>
  example: (code: string, inputs: string[]) => Promise<ExampleRun | null>
}

export interface Verification {
  /** The saved version the runs were against — what the publish route checks. */
  updatedAt: string
  runs: Record<string, TestRun | null>
  /** Each leaf's example runs, in order, keyed as the publish route takes them. */
  examples: Record<string, (ExampleRun | null)[]>
}

/**
 * The solution runs and passes every check. A leaf with no checks passes when its solution
 * at least parses — checks are optional since 17 Oct 2026 (Ken).
 */
export function runPassed(run: TestRun | null | undefined): boolean {
  return Boolean(run && !run.compile_error && run.results.every((r) => r.passed))
}

export async function verifyProblem(
  runner: Runner,
  problem: Schemas['ProblemOut'],
): Promise<Verification> {
  const doc = problem.document
  const runs: Record<string, TestRun | null> = {}
  for (const leaf of leavesOf(doc)) {
    runs[leaf.key] = await runner.check(
      solutionOf(doc, leaf.leaf),
      toChecks(leaf.leaf.tests, { revealHidden: true, solution: solutionOf(doc, leaf.leaf) }),
    )
  }
  const examples: Verification['examples'] = {}
  for (const leaf of exampleLeaves(doc)) {
    examples[leaf.key] = []
    for (const example of leaf.examples) {
      examples[leaf.key]!.push(await runner.example(leaf.solution, example.inputs ?? []))
    }
  }
  return { updatedAt: problem.updated_at, runs, examples }
}

export function allLeavesPass(problem: Schemas['ProblemOut'], verification: Verification): boolean {
  return (
    leavesOf(problem.document).every((leaf) => runPassed(verification.runs[leaf.key])) &&
    Object.values(verification.examples).every((runs) => runs.every((run) => run !== null))
  )
}

/** What publishing sends: every example's transcript. Only call once `allLeavesPass`. */
export function transcriptsOf(verification: Verification): Record<string, ExamplePiece[][]> {
  return Object.fromEntries(
    Object.entries(verification.examples).map(([key, runs]) => [
      key,
      runs.map((run) => run?.transcript ?? []),
    ]),
  )
}
