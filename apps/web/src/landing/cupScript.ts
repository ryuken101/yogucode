/**
 * The landing page's turtle program, which draws the Yogucode cup.
 *
 * Each line is what the code pane types, together with what that line does to the turtle
 * when it "runs". This is the one place the two are written down, so the drawing cannot
 * drift from the code shown beside it. A function body does nothing as it is typed; the
 * calls further down do the drawing.
 *
 * The geometry follows `CupMark`'s 200×200 viewBox converted to turtle coordinates
 * (y = 100 − svgY). The drawing is an approximation, and the window cross-fades to the
 * real `CupMark` when it finishes, so the brand mark itself is never redrawn by hand.
 */

import { Turtle } from './turtle'
import type { Step } from './turtle'

type Run = (t: Turtle) => void

function box(t: Turtle, x: number, y: number, w: number, h: number, r: number, colour: string) {
  t.penup()
  t.goto(x + r, y)
  t.setheading(0)
  t.pendown()
  t.color(colour)
  t.begin_fill()
  for (const side of [w, h, w, h]) {
    t.forward(side - 2 * r)
    t.circle(r, 90)
  }
  t.end_fill()
}

function dot(t: Turtle, x: number, y: number, size: number, colour: string) {
  t.penup()
  t.goto(x, y)
  t.dot(size, colour)
}

const CUP: [number, number][] = [
  [40, 10],
  [30, -62],
  [-30, -62],
  [-40, 10],
]

const LINES: [string, Run?][] = [
  ['import turtle'],
  [''],
  ['t = turtle.Turtle()'],
  [''],
  ['def box(x, y, w, h, r, colour):'],
  ['    t.penup()'],
  ['    t.goto(x + r, y)'],
  ['    t.setheading(0)'],
  ['    t.pendown()'],
  ['    t.color(colour)'],
  ['    t.begin_fill()'],
  ['    for side in [w, h, w, h]:'],
  ['        t.forward(side - 2 * r)'],
  ['        t.circle(r, 90)'],
  ['    t.end_fill()'],
  [''],
  ['def dot(x, y, size, colour):'],
  ['    t.penup()'],
  ['    t.goto(x, y)'],
  ['    t.dot(size, colour)'],
  [''],
  ['# a pink tile'],
  ['box(-100, -100, 200, 200, 48, "#FF5C8A")', (t) => box(t, -100, -100, 200, 200, 48, '#FF5C8A')],
  ['# a lid, with a lemon on top'],
  ['box(-28, 16, 56, 26, 13, "white")', (t) => box(t, -28, 16, 56, 26, 13, 'white')],
  ['dot(0, 50, 18, "#FFD166")', (t) => dot(t, 0, 50, 18, '#FFD166')],
  ['# the cup'],
  ['t.penup()', (t) => t.penup()],
  ['t.goto(-40, 10)', (t) => t.goto(-40, 10)],
  ['t.pendown()', (t) => t.pendown()],
  ['t.color("#FFF6E9")', (t) => t.color('#FFF6E9')],
  ['t.begin_fill()', (t) => t.begin_fill()],
  ['for x, y in [(40, 10), (30, -62), (-30, -62), (-40, 10)]:'],
  ['    t.goto(x, y)', (t) => CUP.forEach(([x, y]) => t.goto(x, y))],
  ['t.end_fill()', (t) => t.end_fill()],
  ['box(-46, 6, 92, 14, 7, "white")', (t) => box(t, -46, 6, 92, 14, 7, 'white')],
  ['# a happy face'],
  ['dot(-13, -24, 11, "#4B2FB8")', (t) => dot(t, -13, -24, 11, '#4B2FB8')],
  ['dot(13, -24, 11, "#4B2FB8")', (t) => dot(t, 13, -24, 11, '#4B2FB8')],
  ['dot(-21, -36, 12, "#FFA1B5")', (t) => dot(t, -21, -36, 12, '#FFA1B5')],
  ['dot(21, -36, 12, "#FFA1B5")', (t) => dot(t, 21, -36, 12, '#FFA1B5')],
  ['t.penup()', (t) => t.penup()],
  ['t.goto(-8, -35)', (t) => t.goto(-8, -35)],
  ['t.setheading(-60)', (t) => t.setheading(-60)],
  ['t.pensize(4)', (t) => t.pensize(4)],
  ['t.color("#4B2FB8")', (t) => t.color('#4B2FB8')],
  ['t.pendown()', (t) => t.pendown()],
  ['t.circle(9.2, 120)', (t) => t.circle(9.2, 120)],
]

export interface ScriptLine {
  code: string
  /** The steps this line draws: `steps.slice(from, to)`. Empty for most lines. */
  from: number
  to: number
}

export interface Script {
  lines: ScriptLine[]
  steps: Step[]
}

export function buildScript(): Script {
  const t = new Turtle()
  const lines = LINES.map(([code, run]) => {
    const from = t.steps.length
    run?.(t)
    return { code, from, to: t.steps.length }
  })
  return { lines, steps: t.steps }
}

/** Typing speed and drawing speed at 1×. */
export const CHARS_PER_SECOND = 90
export const UNITS_PER_SECOND = 520
/** A pause at the end of each line, so a reader sees the line before the next starts. */
const LINE_PAUSE = 0.06

export interface Frame {
  /** Lines fully typed. */
  line: number
  /** Characters typed of line `line`, if it is not finished. */
  chars: number
  /** Steps fully drawn. */
  steps: number
  /** How far through step `steps` the turtle is, 0–1. */
  partial: number
  /** The line being typed or run, for the highlight; -1 when finished. */
  active: number
  done: boolean
}

/** Seconds at 1× for the whole program to type and draw. */
export function duration(script: Script): number {
  let total = 0
  for (const line of script.lines) {
    total += line.code.length / CHARS_PER_SECOND + LINE_PAUSE
    for (let i = line.from; i < line.to; i++) total += script.steps[i].cost / UNITS_PER_SECOND
  }
  return total
}

/**
 * Where the program is `seconds` in (at 1×). Each line types, then draws its steps, then
 * the next line starts. Kept pure so the timeline is tested without a clock.
 */
export function frameAt(script: Script, seconds: number): Frame {
  let left = Math.max(0, seconds)
  const { lines, steps } = script
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]
    const typing = line.code.length / CHARS_PER_SECOND + LINE_PAUSE
    if (left < typing) {
      return { line: n, chars: Math.min(line.code.length, Math.floor(left * CHARS_PER_SECOND)), steps: line.from, partial: 0, active: n, done: false }
    }
    left -= typing
    for (let i = line.from; i < line.to; i++) {
      const cost = steps[i].cost / UNITS_PER_SECOND
      if (left < cost) return { line: n + 1, chars: 0, steps: i, partial: left / cost, active: n, done: false }
      left -= cost
    }
  }
  return { line: lines.length, chars: 0, steps: steps.length, partial: 0, active: -1, done: true }
}
