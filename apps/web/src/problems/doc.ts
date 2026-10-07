/**
 * The problem document, as the editor holds it.
 *
 * The API's `ProblemDoc` is the unit of saving (see `app/problem_bank.py`), so the editor
 * keeps exactly that shape in state and sends it back whole. These helpers are the few
 * things the screen needs to do *to* a document: make an empty one, walk its attemptable
 * leaves, and turn a leaf's tests into what the grader takes.
 */

import type { Schemas } from '../lib/api'
import type { TestCheck } from '../runtime/protocol'

export type ProblemDoc = Schemas['ProblemDoc']
export type PartDoc = Schemas['PartDoc']
export type TestDoc = Schemas['IoTest'] | Schemas['FunctionTest']
export type HintDoc = Schemas['HintDoc']

/** The fields every attemptable thing has — a problem without parts, or one part. */
export type LeafDoc = Pick<
  ProblemDoc,
  | 'difficulty'
  | 'concept_ids'
  | 'primary_concept_id'
  | 'starter_code'
  | 'solution_code'
  | 'tests'
  | 'hints'
>

export const PART_LABELS = ['a', 'b', 'c', 'd', 'e', 'f'] as const

export function emptyLeaf(): Required<LeafDoc> {
  return {
    difficulty: 1,
    concept_ids: [],
    primary_concept_id: null,
    starter_code: '',
    solution_code: '',
    tests: [],
    hints: [],
  }
}

export function emptyProblem(): ProblemDoc {
  return { kind: 'code', title: '', prompt_md: '', parts: [], options: [], ...emptyLeaf() }
}

export function emptyPart(label: string): PartDoc {
  return { label, prompt_md: '', ...emptyLeaf() }
}

export function nextPartLabel(parts: PartDoc[]): string | null {
  const used = new Set(parts.map((part) => part.label))
  return PART_LABELS.find((label) => !used.has(label)) ?? null
}

export function newTest(kind: TestDoc['kind'], index: number): TestDoc {
  const name = `Check ${index + 1}`
  return kind === 'io'
    ? { kind: 'io', name, hidden: false, stdin: '', expected: '', match: 'exact' }
    : { kind: 'function', name, hidden: false, call: '', expected: '' }
}

export interface Leaf {
  /** Stable within one document: `''` for a problem without parts, else the part letter. */
  key: string
  /** How the editor names it to a teacher. */
  title: string
  leaf: LeafDoc
}

/** The things a student actually attempts. A problem with parts is its parts. */
export function leavesOf(doc: ProblemDoc): Leaf[] {
  const parts = doc.parts ?? []
  if (parts.length === 0) return [{ key: '', title: 'The problem', leaf: doc }]
  return parts.map((part) => ({ key: part.label, title: `Part (${part.label})`, leaf: part }))
}

/**
 * A leaf's tests as the grader takes them.
 *
 * `revealHidden` is for the teacher's own runs: the grader strips the detail from a hidden
 * test's result so a child cannot read the expected answer back out of it, but the teacher
 * wrote that answer and needs to see why their solution fails it.
 */
export function toChecks(
  tests: TestDoc[] | undefined,
  { revealHidden = false }: { revealHidden?: boolean } = {},
): TestCheck[] {
  return (tests ?? []).map((test) =>
    test.kind === 'io'
      ? {
          kind: 'io',
          name: test.name,
          hidden: test.hidden && !revealHidden,
          stdin: test.stdin,
          expected: test.expected,
          match: test.match,
        }
      : {
          kind: 'function',
          name: test.name,
          hidden: test.hidden && !revealHidden,
          call: test.call,
          expected: test.expected,
        },
  )
}
