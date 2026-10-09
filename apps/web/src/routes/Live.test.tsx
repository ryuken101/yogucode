/**
 * The live view against a mock of the relay (`routers/live.py`), over MSW's WebSocket
 * interception: the token goes first, a snapshot rebuilds every open editor, keystrokes
 * stream onto the right tile, and the stuck signals light up in calm tones.
 */

import { screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { Route, Routes } from 'react-router'
import { beforeEach, expect, test, vi } from 'vitest'
import * as Y from 'yjs'
import { toBase64 } from '../collab/socket'
import type { Schemas } from '../lib/api'
import { renderScreen } from '../test/render'
import { liveSockets, server } from '../test/server'
import { flagsFor } from './liveFlags'
import { Live } from './Live'

vi.mock('../lib/supabase', () => ({
  supabaseConfigured: true,
  currentAccessToken: async () => 'teacher-token',
}))
vi.mock('../editor/CodeSurface', () => ({
  CodeSurface: ({ value }: { value: string }) => <pre aria-label="expanded editor">{value}</pre>,
}))

const CLASS = '018f0000-0000-7000-8000-000000000001'
const ARIA = '018f0000-0000-7000-8000-000000000002'
const BELLA = '018f0000-0000-7000-8000-000000000003'
const TARGET = 'attempt:018f0000-0000-7000-8000-0000000000aa'

beforeEach(() => {
  server.use(
    http.get(`/api/classes/${CLASS}`, () =>
      HttpResponse.json({ id: CLASS, name: 'Year 4-6 Python', term_label: null, status: 'active',
        course_id: null, current_lesson_id: null, join_code: 'WNPXYZ', is_mine: true,
        created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' } satisfies Schemas['ClassDetailOut']),
    ),
    http.get(`/api/classes/${CLASS}/roster`, () =>
      HttpResponse.json([
        { student_id: ARIA, display_name: 'Aria K' },
        { student_id: BELLA, display_name: 'Bella N' },
      ] as unknown as Schemas['RosterEntryOut'][]),
    ),
  )
})

test('the token goes first, the snapshot fills the tiles, and keystrokes stream in', async () => {
  const doc = new Y.Doc()
  doc.getText('code').insert(0, 'numbers = [1, 2, 3]\n')
  let auth: unknown = null
  let send: (message: unknown) => void = () => {}

  server.use(
    liveSockets.addEventListener('connection', ({ client }) => {
      send = (message) => client.send(JSON.stringify(message))
      client.addEventListener('message', (event) => {
        const message = JSON.parse(String(event.data))
        if (auth === null) {
          auth = message
          send({
            type: 'snapshot',
            students: [{ student_id: ARIA, display_name: 'Aria K', focus: { target: TARGET, kind: 'problem', title: 'Add to the end' }, recent: [] }],
            docs: [{ target: TARGET, student_id: ARIA, updates: [toBase64(Y.encodeStateAsUpdate(doc))] }],
          })
        }
      })
    }),
  )

  renderScreen(
    <Routes>
      <Route path="/classes/:classId/live" element={<Live />} />
    </Routes>,
    { route: `/classes/${CLASS}/live` },
  )

  expect(await screen.findByText(/numbers = \[1, 2, 3\]/)).toBeInTheDocument()
  expect(auth).toEqual({ type: 'auth', token: 'teacher-token', class_id: CLASS })
  expect(screen.getByText('Add to the end')).toBeInTheDocument()
  expect(screen.getByText('not signed in')).toBeInTheDocument() // Bella's empty seat

  // A keystroke: the child's doc changes and the relay forwards the delta.
  const before = Y.encodeStateVector(doc)
  doc.getText('code').insert(20, 'numbers.append(5)\n')
  send({ type: 'doc', student_id: ARIA, target: TARGET, update: toBase64(Y.encodeStateAsUpdate(doc, before)), full: false })
  await waitFor(() => expect(screen.getByText(/numbers\.append\(5\)/)).toBeInTheDocument())

  // A finished child is flagged good; nothing on the page is system-error.
  send({ type: 'status', student_id: ARIA, status: { kind: 'check', target: TARGET, passed: 2, total: 2, compile_error: null, at: Date.now() } })
  const done = await screen.findByText('all passing')
  expect(done.className).toContain('good')
  expect(document.body.innerHTML).not.toContain('system-error')
})

/* --- stuck signals ---------------------------------------------------------------------- */

function student(recent: object[], extra: object = {}) {
  return {
    studentId: ARIA, displayName: 'Aria K', online: true,
    focus: { target: TARGET, kind: 'problem' as const, title: 'Q1' },
    recent: recent as never[], lastEditAt: null, ...extra,
  }
}

test('the same error four times in a row is flagged; a different one resets it', () => {
  const error = (text: string) => ({ kind: 'error', text })
  const run = { kind: 'run' }
  expect(flagsFor(student([run, error('NameError'), run, error('NameError'), run, error('NameError'), run, error('NameError')])))
    .toContainEqual({ label: 'same error ×4', tone: 'attention' })
  expect(flagsFor(student([error('NameError'), error('NameError'), error('NameError'), error('TypeError')])))
    .toEqual([])
})

test('quiet for five minutes is flagged; a recent keystroke clears it', () => {
  const now = 1_000_000_000
  const old = [{ kind: 'run', at: now - 6 * 60_000 }]
  expect(flagsFor(student(old), now)).toContainEqual({ label: 'quiet for 5 min', tone: 'attention' })
  expect(flagsFor(student(old, { lastEditAt: now - 10_000 }), now)).toEqual([])
})

test('a large paste into the open problem is shown, as information', () => {
  expect(flagsFor(student([{ kind: 'paste', target: TARGET, chars: 240 }])))
    .toContainEqual({ label: 'pasted 240 chars', tone: 'info' })
  expect(flagsFor(student([{ kind: 'paste', target: TARGET, chars: 5 }]))).toEqual([])
})

test('a child who is not connected has no flags', () => {
  expect(flagsFor(student([{ kind: 'error', text: 'x' }], { online: false }))).toEqual([])
})
