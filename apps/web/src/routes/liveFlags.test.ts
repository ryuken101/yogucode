import { expect, test } from 'vitest'
import type { LiveStudent } from '../collab/useLiveClass'
import { flagsFor } from './liveFlags'

function student(overrides: Partial<LiveStudent> = {}): LiveStudent {
  return {
    studentId: 's1', displayName: 'Aria', online: true, focus: null, recent: [], lastEditAt: null,
    awaySince: null, awayCount: 0, awayTotal: 0, ...overrides,
  }
}
const labels = (s: LiveStudent, context = {}) => flagsFor(s, 100_000, context).map((f) => f.label)

test('a child away now says for how long, as something worth a look', () => {
  const flags = flagsFor(student({ awaySince: 88_000, awayCount: 1 }), 100_000)
  expect(flags[0]).toEqual({ label: 'left the page · 12s', tone: 'attention' })
  expect(flags[1]).toEqual({ label: 'left 1×', tone: 'attention' })
})

test('a quiz counts from its own record, which outlives a reconnect', () => {
  expect(labels(student({ awayCount: 0 }), { timesLeft: 3 })).toEqual(['left 3×'])
})

test('no flag for a child who has stayed, or who is not connected', () => {
  expect(labels(student())).toEqual([])
  expect(labels(student({ online: false, awayCount: 2 }))).toEqual([])
})

const onFile = { target: 'document:d', kind: 'file' as const, title: 'mine.py' }
const onLesson = { target: 'attempt:a', kind: 'problem' as const, title: 'Rung', mode: 'classwork', assignment_id: 'today' }

test("something else open during a lesson is noted, softly", () => {
  const flags = flagsFor(student({ focus: onFile }), 100_000, { todaysWork: 'today' })
  expect(flags).toEqual([{ label: 'not on today’s lesson', tone: 'info' }])
})

test("on today's lesson, nothing open, or no lesson today: no note", () => {
  expect(labels(student({ focus: onLesson }), { todaysWork: 'today' })).toEqual([])
  expect(labels(student({ focus: null }), { todaysWork: 'today' })).toEqual([])
  expect(labels(student({ focus: onFile }), { todaysWork: null })).toEqual([])
})
