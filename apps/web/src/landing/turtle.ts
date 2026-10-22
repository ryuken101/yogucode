/**
 * A very small Python-style turtle for the landing page. It is not the classroom turtle.
 *
 * It records instead of drawing. Each command appends `Step`s, where one step is one shape
 * (a line, a filled polygon or a dot) plus where the turtle is after it. The page then
 * replays the steps at whatever speed it likes. Commands take Python turtle's coordinates
 * and angles (origin in the middle, y up, 0° east, positive angles anticlockwise) and store
 * SVG coordinates in a 200×200 box (`CupMark`'s viewBox), so the result lines up with the
 * brand mark the drawing hands over to.
 *
 * Only what the cup needs is here. Children's turtle in the product (spec §5.2) will run
 * in Pyodide; this is a JS replay so the front page never downloads Python.
 */

export type Shape =
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number; colour: string; width: number }
  | { kind: 'fill'; points: [number, number][]; colour: string }
  | { kind: 'dot'; x: number; y: number; size: number; colour: string }

export interface Step {
  shape: Shape
  /** Where the turtle is after this step, in SVG coordinates. */
  x: number
  y: number
  /** Python heading in degrees. */
  heading: number
  /** How long the step takes to draw, in units of distance. */
  cost: number
}

/** A fill or a dot appears at once, but still takes a beat so the eye catches it. */
const INSTANT_COST = 24

const toSvg = (x: number, y: number): [number, number] => [100 + x, 100 - y]

export class Turtle {
  readonly steps: Step[] = []
  private x = 0
  private y = 0
  private heading = 0
  private down = true
  private pen = 'black'
  private fill = 'black'
  private width = 1
  private filling: [number, number][] | null = null

  private push(shape: Shape, cost: number) {
    const [x, y] = toSvg(this.x, this.y)
    this.steps.push({ shape, x, y, heading: this.heading, cost })
  }

  penup() {
    this.down = false
  }

  pendown() {
    this.down = true
  }

  goto(x: number, y: number) {
    const [x1, y1] = toSvg(this.x, this.y)
    this.x = x
    this.y = y
    const [x2, y2] = toSvg(x, y)
    this.filling?.push([x2, y2])
    if (this.down) {
      this.push({ kind: 'line', x1, y1, x2, y2, colour: this.pen, width: this.width }, Math.hypot(x2 - x1, y2 - y1))
    }
  }

  forward(distance: number) {
    const rad = (this.heading * Math.PI) / 180
    this.goto(this.x + distance * Math.cos(rad), this.y + distance * Math.sin(rad))
  }

  left(angle: number) {
    this.heading = (this.heading + angle) % 360
  }

  setheading(angle: number) {
    this.heading = angle
  }

  /** Python's algorithm: the centre is `radius` to the turtle's left. */
  circle(radius: number, extent = 360) {
    const n = Math.max(4, Math.ceil(Math.abs(extent) / 10))
    const w = extent / n
    const chord = 2 * radius * Math.sin((w * Math.PI) / 360)
    this.left(w / 2)
    for (let i = 0; i < n; i++) {
      this.forward(chord)
      if (i < n - 1) this.left(w)
    }
    this.left(w / 2)
  }

  dot(size: number, colour: string) {
    const [x, y] = toSvg(this.x, this.y)
    this.push({ kind: 'dot', x, y, size, colour }, INSTANT_COST)
  }

  /** Python's one-argument `color`: pen and fill both. */
  color(colour: string) {
    this.pen = colour
    this.fill = colour
  }

  pensize(width: number) {
    this.width = width
  }

  begin_fill() {
    this.filling = [toSvg(this.x, this.y)]
  }

  end_fill() {
    if (this.filling && this.filling.length > 2) {
      this.push({ kind: 'fill', points: this.filling, colour: this.fill }, INSTANT_COST)
    }
    this.filling = null
  }
}
