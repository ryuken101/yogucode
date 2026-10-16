/**
 * The problem document, as the editor holds it.
 *
 * The API's `ProblemDoc` is the unit of saving (see `app/problem_bank.py`), so the editor
 * keeps exactly that shape in state and sends it back whole. These helpers are the few
 * things the screen needs to do *to* a document: make an empty one, walk its attemptable
 * leaves, and turn a leaf's tests into what the grader takes.
 *
 * **A shared file** (`shared_file`, 17 Oct 2026): a problem's parts are one program, whose
 * starter and solution live on the problem, and every part's checks run against all of
 * it. `codeOf` is the one place that decides which code a leaf runs.
 */

import type { Schemas } from '../lib/api'
import type { ChosenValue, TestCheck } from '../runtime/protocol'

export type ProblemDoc = Schemas['ProblemDoc']
export type PartDoc = Schemas['PartDoc']
export type TestDoc =
  | Schemas['IoTest']
  | Schemas['FunctionTest']
  | Schemas['ScriptTest']
  | Schemas['CompareTest']
export type CompareDoc = Schemas['CompareTest']
export type HintDoc = Schemas['HintDoc']
export type ExampleDoc = Schemas['ExampleDoc']
export type ExamplePiece = Schemas['TranscriptLine']

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
  | 'examples'
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
    examples: [],
  }
}

export function emptyProblem(): ProblemDoc {
  return {
    kind: 'code',
    title: '',
    prompt_md: '',
    parts: [],
    options: [],
    shared_file: false,
    ...emptyLeaf(),
  }
}

/** Whether the problem's parts are one file. */
export function isSharedFile(doc: ProblemDoc): boolean {
  return Boolean(doc.shared_file) && (doc.parts ?? []).length > 0
}

/** The reference solution a leaf's checks and examples run: the file's, when shared. */
export function solutionOf(doc: ProblemDoc, leaf: LeafDoc): string {
  return isSharedFile(doc) ? doc.solution_code ?? '' : leaf.solution_code ?? ''
}

/**
 * Everything with examples on it, and the solution they are runs of. The problem's own
 * examples sit at key `''` — on a problem without parts, that is the problem itself; on a
 * shared file, they are examples of the whole program.
 */
export function exampleLeaves(doc: ProblemDoc): { key: string; examples: ExampleDoc[]; solution: string }[] {
  const parts = doc.parts ?? []
  const own = parts.length === 0 || isSharedFile(doc)
  return [
    ...(own ? [{ key: '', examples: doc.examples ?? [], solution: doc.solution_code ?? '' }] : []),
    ...parts.map((part) => ({ key: part.label, examples: part.examples ?? [], solution: solutionOf(doc, part) })),
  ].filter((leaf) => leaf.examples.length > 0)
}

export function emptyPart(label: string): PartDoc {
  return { label, prompt_md: '', ...emptyLeaf() }
}

export function nextPartLabel(parts: PartDoc[]): string | null {
  const used = new Set(parts.map((part) => part.label))
  return PART_LABELS.find((label) => !used.has(label)) ?? null
}

/**
 * Starting points for a custom check (17 Oct 2026). Each one is a working example of a
 * shape that a fixed expected value cannot express.
 */
export const SCRIPT_TEMPLATES: { label: string; code: string }[] = [
  {
    label: 'Every input in a range',
    code: `# Try every guess, and check the answer against the ships THEY chose.
for guess in range(10):
    out, v = run(guess)          # run their program, typing the guess
    hit = guess in v["ships"]    # v holds their program's variables
    check(("HIT!" in out) == hit,
          f"Guessing {guess} should say {'HIT!' if hit else 'MISS!'}")
`,
  },
  {
    label: 'Uses a variable they chose',
    code: `out, v = run()
check(len(v["names"]) >= 3, "Make a list called names with at least 3 names in it")
check(contains(out, v["names"][0]), "Print the first name in your list")
`,
  },
  {
    label: 'Output contains a value they set',
    code: `out, v = run("Ken")
check(contains(out, "Ken"), "Say hello to the name that was typed in")
check(contains(out, str(v["age"])), "Print the age you stored in age")
`,
  },
]

export function newTest(kind: TestDoc['kind'], index: number): TestDoc {
  const name = `Check ${index + 1}`
  if (kind === 'compare') {
    return {
      kind: 'compare',
      name,
      hidden: false,
      inputs: [{ mode: 'range', start: 0, end: 9 }],
      chosen: [],
      match: 'exact',
    }
  }
  if (kind === 'script') return { kind: 'script', name, hidden: false, code: SCRIPT_TEMPLATES[0]!.code }
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
/** How many cases a "matches my solution" check tries: every combination of its inputs. */
export function caseCount(test: CompareDoc): number {
  return (test.inputs ?? []).reduce(
    (total, row) =>
      total *
      (row.mode === 'range'
        ? Math.max(0, row.end - row.start + 1)
        : row.mode === 'values'
          ? (row.values ?? []).length
          : row.count),
    1,
  )
}

export function toChecks(
  tests: TestDoc[] | undefined,
  {
    revealHidden = false,
    solution,
  }: {
    revealHidden?: boolean
    /** The teacher's own runs: the plain solution for "matches my solution" checks. */
    solution?: string
  } = {},
): TestCheck[] {
  return (tests ?? []).map((test): TestCheck =>
    test.kind === 'compare'
      ? {
          kind: 'compare',
          name: test.name,
          hidden: test.hidden && !revealHidden,
          inputs: test.inputs ?? [],
          chosen: (test.chosen ?? []).map((value) => ({
            name: value.name,
            rule: value.rule ?? { type: 'none' },
          })) as ChosenValue[],
          match: test.match,
          // A child's check carries the server's scrambled copy; the teacher's, the plain one.
          ...(solution !== undefined ? { solution } : { reference: test.reference ?? null }),
          reveal: revealHidden,
        }
      : test.kind === 'script'
      ? { kind: 'script', name: test.name, hidden: test.hidden && !revealHidden, code: test.code, reveal: revealHidden }
      : test.kind === 'io'
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
