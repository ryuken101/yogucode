/**
 * The live class demo's timeline: one child, Noah, typing on his laptop while his
 * teacher's Live view shows the same code keystroke by keystroke. He gets stuck, she opens
 * his tile, presses Help, types the fix into his editor, and hands it back.
 *
 * `sceneAt(t)` is pure: everything on screen at `t` seconds. `LiveDemo.tsx` only runs a
 * clock and draws the scene. The words on screen copy the product's own Live page
 * (`routes/Live.tsx`, `routes/liveFlags.ts`), so the demo shows what a teacher will see.
 */

export const TEACHER = 'Ms Lee'
export const CHILD = 'Noah'

export const TYPED = 'name = input("Name? ")\nfor i in range(3)\n    print("Hi", name)'
/** Where the missing colon goes: straight after `range(3)`. */
export const FIX_AT = TYPED.indexOf('range(3)') + 'range(3)'.length
export const FIXED = `${TYPED.slice(0, FIX_AT)}:${TYPED.slice(FIX_AT)}`
export const ANSWER = 'Noah'

const TYPE_START = 0.4
const CHARS_PER_SECOND = 11
const TYPE_END = TYPE_START + TYPED.length / CHARS_PER_SECOND
/** The four Runs that end in the same error. Live flags a child at four (`SAME_ERROR_TIMES`). */
const RUNS = [6.2, 6.9, 7.6, 8.3]
const POINTER_IN = 8.8
const TO_TILE: [number, number] = [9.0, 10.0]
const CLICK_TILE = 10.1
const OPEN = 10.3
const TO_HELP: [number, number] = [10.8, 11.6]
const CLICK_HELP = 11.7
const HELP_ON = 11.9
const CARET_IN = 12.2
const CARET_TO_FIX = 12.8
const TYPE_FIX = 13.4
const CLICK_DONE = 14.4
const HELP_OFF = 14.6
const POINTER_OUT = 15.0
const RUN_OK = 15.4
const ANSWER_START = 15.6
const ANSWER_CPS = 8
const OUTPUT = 16.4
const PASS = 16.9
/** The whole film, after which it starts again. */
export const LENGTH = 20
const CLICK_S = 0.2

/** When each chapter starts. Its words are `LIVE_CHAPTERS` in `copy.ts`. */
export const CHAPTER_STARTS = [0, RUNS[0] - 0.1, POINTER_IN, HELP_ON, HELP_OFF]

export type Target = 'start' | 'tile' | 'help'

export interface Pointer {
  from: Target
  to: Target
  /** 0 at `from`, 1 at `to`, eased. */
  p: number
  down: boolean
}

export type Console =
  | { kind: 'empty' }
  | { kind: 'error' }
  | { kind: 'run'; answer: string; output: boolean; passed: boolean }

export interface Scene {
  /** The shared document: what Noah's laptop and the teacher's view both show. */
  code: string
  /** Where Noah's own cursor is, or null while it isn't shown. */
  childCaret: number | null
  /** Where the teacher's cursor is in Noah's editor, while she helps. */
  teacherCaret: number | null
  /** Runs that ended in the error so far. */
  errors: number
  view: 'grid' | 'open'
  helping: boolean
  pointer: Pointer | null
  console: Console
  passing: boolean
  chapter: number
}

const ease = (x: number) => (x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2)
const progress = (t: number, [a, b]: [number, number]) => ease(Math.min(1, Math.max(0, (t - a) / (b - a))))
const clicking = (t: number, at: number) => t >= at && t < at + CLICK_S

function pointerAt(t: number): Pointer | null {
  if (t < POINTER_IN || t >= POINTER_OUT) return null
  if (t < OPEN) return { from: 'start', to: 'tile', p: progress(t, TO_TILE), down: clicking(t, CLICK_TILE) }
  return {
    from: 'tile',
    to: 'help',
    p: progress(t, TO_HELP),
    down: clicking(t, CLICK_HELP) || clicking(t, CLICK_DONE),
  }
}

export function sceneAt(t: number): Scene {
  t = Math.max(0, t)
  const typed = Math.max(0, Math.min(TYPED.length, Math.floor((t - TYPE_START) * CHARS_PER_SECOND)))
  const fixed = t >= TYPE_FIX
  const code = fixed ? FIXED : TYPED.slice(0, typed)
  const helping = t >= HELP_ON && t < HELP_OFF
  const errors = RUNS.filter((r) => t >= r).length

  let teacherCaret: number | null = null
  if (helping && t >= CARET_IN) teacherCaret = t < CARET_TO_FIX ? code.length : FIX_AT + (fixed ? 1 : 0)

  let console: Console = { kind: 'empty' }
  if (t >= RUN_OK) {
    const chars = Math.max(0, Math.min(ANSWER.length, Math.floor((t - ANSWER_START) * ANSWER_CPS)))
    console = { kind: 'run', answer: ANSWER.slice(0, chars), output: t >= OUTPUT, passed: t >= PASS }
  } else if (errors > 0) {
    console = { kind: 'error' }
  }

  // Noah's cursor shows while he types and runs, never while his editor is locked.
  const childCaret = !helping && t < RUN_OK ? (t < HELP_OFF ? Math.min(code.length, Math.max(typed, 0)) : FIX_AT + 1) : null

  return {
    code,
    childCaret: t < TYPE_START ? null : childCaret,
    teacherCaret,
    errors,
    view: t >= OPEN ? 'open' : 'grid',
    helping,
    pointer: pointerAt(t),
    console,
    passing: t >= PASS,
    chapter: CHAPTER_STARTS.findLastIndex((s) => t >= s),
  }
}

/** Typing time is over once every character is in. Exported for the tests. */
export const TYPING_ENDS = TYPE_END
