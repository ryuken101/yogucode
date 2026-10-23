/**
 * The window rules, without React: what "front" means, where snapping lands, and how a
 * window's page and the URL relate.
 */

import { describe, expect, test } from 'vitest'
import { appFor, deskPath } from './apps'
import { ZONES, frontOf, reduce, zoneAt } from './windows'
import type { Loc, Win } from './windows'

const loc = (pathname: string, search = ''): Loc => ({ pathname, search, hash: '' })
const show = (wins: Win[], app: Win['app'], path: string) =>
  reduce(wins, { type: 'show', app, loc: loc(path) })

describe('showing a page', () => {
  test('a new app opens full screen, in front', () => {
    const wins = show([], 'live', '/classes/c1/live')
    expect(wins).toHaveLength(1)
    expect(wins[0]).toMatchObject({ app: 'live', max: true, min: false, anim: 'open' })
    expect(frontOf(wins)?.app).toBe('live')
  })

  test('a page of an open app moves that window, rather than opening a second', () => {
    let wins = show([], 'classes', '/classes')
    wins = show(wins, 'live', '/classes/c1/live')
    wins = show(wins, 'classes', '/classes/c1')
    expect(wins.filter((w) => w.app === 'classes')).toHaveLength(1)
    expect(frontOf(wins)).toMatchObject({ app: 'classes', loc: { pathname: '/classes/c1' } })
  })

  test('a minimised window comes back when its app is shown again', () => {
    let wins = show([], 'code', '/my-code')
    wins = reduce(wins, { type: 'minimise', app: 'code' })
    expect(frontOf(wins)).toBeNull()
    wins = reduce(wins, { type: 'settle', app: 'code' })
    expect(wins[0]).toMatchObject({ min: true, anim: null })
    wins = show(wins, 'code', '/my-code')
    expect(wins[0]).toMatchObject({ min: false, anim: 'open' })
  })
})

describe('front, close and focus', () => {
  test('closing the front window hands the front to the next one down', () => {
    let wins = show([], 'live', '/classes/c1/live')
    wins = show(wins, 'code', '/my-code')
    wins = reduce(wins, { type: 'close', app: 'code' })
    // Still on screen for its exit animation, but no longer what the person is in.
    expect(wins).toHaveLength(2)
    expect(frontOf(wins)?.app).toBe('live')
    wins = reduce(wins, { type: 'settle', app: 'code' })
    expect(wins.map((w) => w.app)).toEqual(['live'])
  })

  test('focusing brings a window to the front', () => {
    let wins = show([], 'live', '/classes/c1/live')
    wins = show(wins, 'code', '/my-code')
    wins = reduce(wins, { type: 'focus', app: 'live' })
    expect(frontOf(wins)?.app).toBe('live')
  })
})

describe('arranging', () => {
  test('placing a window takes it out of full screen; toggling puts it back', () => {
    let wins = show([], 'code', '/my-code')
    wins = reduce(wins, { type: 'place', app: 'code', geom: ZONES.left })
    expect(wins[0]).toMatchObject({ ...ZONES.left, max: false })
    wins = reduce(wins, { type: 'toggleMax', app: 'code' })
    expect(wins[0]!.max).toBe(true)
  })

  test('a layout places its windows and minimises the rest, never closes them', () => {
    let wins = show([], 'library', '/problems')
    wins = reduce(wins, {
      type: 'layout',
      items: [
        { app: 'code', loc: loc('/my-code'), geom: ZONES.right },
        { app: 'live', loc: loc('/classes/c1/live'), geom: ZONES.left },
      ],
    })
    expect(wins.find((w) => w.app === 'library')).toMatchObject({ min: true })
    expect(frontOf(wins)?.app).toBe('live')
    const [code, live] = [wins.find((w) => w.app === 'code')!, wins.find((w) => w.app === 'live')!]
    expect(code.group).toBe(live.group)
    expect(code.group).not.toBe(0)
  })

  test('changing class points class pages at the new class, and nothing else', () => {
    let wins = show([], 'live', '/classes/c1/live')
    wins = show(wins, 'code', '/my-code')
    wins = reduce(wins, { type: 'retarget', from: 'c1', to: 'c2' })
    expect(wins.map((w) => w.loc.pathname)).toEqual(['/classes/c2/live', '/my-code'])
  })

  test('changing class takes a homework being marked to the new class’s Marking', () => {
    let wins = show([], 'marking', '/assignments/a1/mark/p1')
    wins = show(wins, 'library', '/problems/p1')
    wins = reduce(wins, {
      type: 'retarget',
      from: 'c1',
      to: 'c2',
      homes: { marking: '/classes/c2/marking' },
    })
    expect(wins.map((w) => w.loc.pathname)).toEqual(['/classes/c2/marking', '/problems/p1'])
  })
})

describe('snap zones', () => {
  const rect = { left: 0, top: 0, right: 1000, bottom: 600 }
  test('edges snap to halves, their ends to quarters, the top to full screen', () => {
    expect(zoneAt(5, 300, rect)).toBe('left')
    expect(zoneAt(995, 300, rect)).toBe('right')
    expect(zoneAt(5, 20, rect)).toBe('tl')
    expect(zoneAt(995, 590, rect)).toBe('br')
    expect(zoneAt(500, 5, rect)).toBe('max')
    expect(zoneAt(500, 300, rect)).toBeNull()
  })
})

describe('which app owns a page', () => {
  test('teacher pages', () => {
    expect(appFor('teacher', '/classes/c1/live')).toBe('live')
    expect(appFor('teacher', '/classes/c1')).toBe('classes')
    expect(appFor('teacher', '/classes/c1/slips')).toBe('classes')
    expect(appFor('teacher', '/teachers')).toBe('classes')
    expect(appFor('teacher', '/classes/c1/homework/new')).toBe('work')
    expect(appFor('teacher', '/classes/c1/quizzes/q1')).toBe('work')
    expect(appFor('teacher', '/assignments/a1/mark/i1')).toBe('marking')
    expect(appFor('teacher', '/curriculum')).toBe('library')
    expect(appFor('teacher', '/code/students/s1/d1')).toBe('code')
    expect(appFor('teacher', '/files/students/s1')).toBe('files')
    expect(appFor('teacher', deskPath('teacher'))).toBeNull()
  })

  test('student pages, which share no path with a teacher’s', () => {
    expect(appFor('student', '/home')).toBe('lessons')
    expect(appFor('student', '/lesson/a1/i1')).toBe('lessons')
    expect(appFor('student', '/work')).toBe('code')
    expect(appFor('student', '/quiz/q1')).toBe('work')
    expect(appFor('student', '/my-files')).toBe('files')
    expect(appFor('student', '/files')).toBeNull()
    expect(appFor('student', deskPath('student'))).toBeNull()
  })
})
