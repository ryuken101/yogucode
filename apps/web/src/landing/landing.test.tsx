/**
 * The public landing page: the turtle's timeline, the page, and the desktop at its top.
 */

import { screen, within } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { renderScreen } from '../test/render'
import { buildScript, duration, frameAt } from './cupScript'
import { CHAPTER_STARTS, FIXED, LENGTH, TYPED, TYPING_ENDS, sceneAt } from './liveScript'
import { DEMO_EMAIL, LIVE_AT, LIVE_CHAPTERS } from './copy'
import { LandingPage } from './LandingPage'

describe('the turtle program', () => {
  const script = buildScript()

  test('every step belongs to exactly one line, in order', () => {
    let next = 0
    for (const line of script.lines) {
      expect(line.from).toBe(next)
      next = line.to
    }
    expect(next).toBe(script.steps.length)
    expect(script.steps.length).toBeGreaterThan(0)
  })

  test('a box comes back to where it started, so its fill closes', () => {
    const tile = script.lines.find((l) => l.code.startsWith('box(-100'))!
    const lines = script.steps.slice(tile.from, tile.to).filter((s) => s.shape.kind === 'line')
    const first = lines[0].shape
    const last = lines.at(-1)!.shape
    if (first.kind !== 'line' || last.kind !== 'line') throw new Error('expected lines')
    expect(last.x2).toBeCloseTo(first.x1, 5)
    expect(last.y2).toBeCloseTo(first.y1, 5)
    // The tile fills the cup's 200×200 box: its first line runs along the bottom edge.
    expect(first.y1).toBeCloseTo(200, 5)
  })

  test('the clock runs from nothing to the finished drawing, never backwards', () => {
    const total = duration(script)
    expect(frameAt(script, 0)).toMatchObject({ line: 0, chars: 0, steps: 0, done: false })
    let steps = 0
    for (let s = 0; s <= total; s += total / 200) {
      const f = frameAt(script, s)
      expect(f.steps).toBeGreaterThanOrEqual(steps)
      steps = f.steps
    }
    expect(frameAt(script, total + 1)).toMatchObject({ steps: script.steps.length, active: -1, done: true })
  })
})

describe('the live class film', () => {
  test('the teacher sees his code as he types it, a keystroke at a time', () => {
    let last = ''
    for (let t = 0; t <= TYPING_ENDS; t += 0.05) {
      const { code } = sceneAt(t)
      expect(TYPED.startsWith(code)).toBe(true)
      expect(code.length).toBeGreaterThanOrEqual(last.length)
      last = code
    }
    expect(sceneAt(TYPING_ENDS + 0.1).code).toBe(TYPED)
  })

  test('he is flagged before she arrives, and only she types while she helps', () => {
    const helpAt = CHAPTER_STARTS[3]
    expect(sceneAt(CHAPTER_STARTS[2]).errors).toBe(4)
    expect(sceneAt(CHAPTER_STARTS[2]).view).toBe('grid')
    for (let t = 0; t < LENGTH; t += 0.05) {
      const s = sceneAt(t)
      if (s.helping) expect(s.childCaret).toBeNull()
      else expect(s.teacherCaret).toBeNull()
    }
    expect(sceneAt(helpAt + 0.05)).toMatchObject({ helping: true, view: 'open' })
    expect(sceneAt(LENGTH - 0.01)).toMatchObject({ code: FIXED, helping: false, passing: true })
    expect(FIXED).toContain('range(3):')
  })

  test('every chapter has words, in order', () => {
    expect(LIVE_CHAPTERS).toHaveLength(CHAPTER_STARTS.length)
    CHAPTER_STARTS.forEach((start, i) => expect(sceneAt(start + 0.01).chapter).toBe(i))
  })
})

describe('the page', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('the hero, and a door for children and one for teachers', () => {
    renderScreen(<LandingPage />)
    expect(screen.getByRole('heading', { level: 1, name: /all-in-one platform for coding academies/ })).toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: 'Student sign in' })[0]).toHaveAttribute('href', '/join')
    expect(screen.getAllByRole('link', { name: 'Teacher sign in' })[0]).toHaveAttribute('href', '/sign-in')
  })

  test('nobody can type code into it', () => {
    const { container } = renderScreen(<LandingPage />)
    expect(container.querySelector('textarea, input, [contenteditable="true"]')).toBeNull()
    expect(screen.queryByRole('button', { name: /\brun\b/i })).not.toBeInTheDocument()
  })

  test('the centre it runs at, by name', () => {
    renderScreen(<LandingPage />)
    const live = screen.getByRole('heading', { name: /Running in real classes/ })
    expect(live).toHaveTextContent(LIVE_AT)
  })

  test('Book a demo is an email to a real inbox', () => {
    renderScreen(<LandingPage />)
    const link = screen.getByRole('link', { name: /Email us to book a demo/ })
    expect(link.getAttribute('href')).toMatch(new RegExp(`^mailto:${DEMO_EMAIL}\\?subject=`))
  })

  test('the hero opens with Hello, and an icon opens and reopens its window', async () => {
    const { user } = renderScreen(<LandingPage />)
    const desk = screen.getByRole('group', { name: 'Yogucode desktop' })
    const hello = within(desk).getByRole('region', { name: 'Hello' })
    expect(within(hello).getByRole('heading', { level: 1 })).toBeInTheDocument()
    expect(within(desk).queryByRole('region', { name: 'For teachers' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Open For teachers' }))
    const teachers = await within(desk).findByRole('region', { name: 'For teachers' })
    expect(within(teachers).getByText(/A pretend class/)).toBeInTheDocument()

    await user.click(within(desk).getByRole('button', { name: 'Close For teachers' }))
    await vi.waitFor(() => expect(within(desk).queryByRole('region', { name: 'For teachers' })).not.toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: 'Open For teachers' }))
    expect(await within(desk).findByRole('region', { name: 'For teachers' })).toBeInTheDocument()
  })

  test('the live demo: each chapter shows its moment', async () => {
    const { user } = renderScreen(<LandingPage />)
    const live = screen.getByRole('region', { name: 'See a live class.' })
    await user.click(within(live).getByRole('button', { name: 'Pause' }))

    await user.click(within(live).getByRole('button', { name: 'They fix it together' }))
    expect(within(live).getByText(/Your teacher is helping/)).toBeInTheDocument()
    expect(within(live).getByText('Done helping')).toBeInTheDocument()

    await user.click(within(live).getByRole('button', { name: 'Back to Noah' }))
    expect(within(live).queryByText(/Your teacher is helping/)).not.toBeInTheDocument()
    expect(within(live).getByText('3 of 3 checks pass')).toBeInTheDocument()
  })

  test('with reduced motion the cup is already drawn', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('reduce'),
      addEventListener() {},
      removeEventListener() {},
    }))
    renderScreen(<LandingPage />)
    expect(screen.getByRole('img', { name: 'The Yogucode cup, drawn by a turtle' })).toBeInTheDocument()
    expect(screen.getByText(/That's our logo/)).toBeInTheDocument()
  })
})
