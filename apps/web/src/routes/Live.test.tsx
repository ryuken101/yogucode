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

  // The tile is in the editor's colours, so its text is broken into coloured pieces.
  const tileCode = () => document.querySelector('pre code')?.textContent ?? ''
  await waitFor(() => expect(tileCode()).toContain('numbers = [1, 2, 3]'))
  expect(screen.getByText('numbers')).toHaveStyle({ color: '#FFF6E9' })
  expect(screen.getByText('1')).toHaveStyle({ color: '#B9ACE6' })
  expect(auth).toEqual({ type: 'auth', token: 'teacher-token', class_id: CLASS })
  expect(screen.getByText('Add to the end')).toBeInTheDocument()
  expect(screen.getByText('not signed in')).toBeInTheDocument() // Bella's empty seat

  // A keystroke: the child's doc changes and the relay forwards the delta.
  const before = Y.encodeStateVector(doc)
  doc.getText('code').insert(20, 'numbers.append(5)\n')
  send({ type: 'doc', student_id: ARIA, target: TARGET, update: toBase64(Y.encodeStateAsUpdate(doc, before)), full: false })
  await waitFor(() => expect(tileCode()).toContain('numbers.append(5)'))

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
    recent: recent as never[], lastEditAt: null, awaySince: null, awayCount: 0, awayTotal: 0, ...extra,
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

/* --- Help locks the child's editor (Ken's decision, 11 Oct 2026) ----------------------- */

test('Help tells the relay to lock the child’s editor, and Done helping unlocks it', async () => {
  const doc = new Y.Doc()
  doc.getText('code').insert(0, 'print(1)\n')
  const sent: Array<{ type: string; target?: string; on?: boolean }> = []
  let authed = false

  server.use(
    liveSockets.addEventListener('connection', ({ client }) => {
      client.addEventListener('message', (event) => {
        const message = JSON.parse(String(event.data))
        sent.push(message)
        if (!authed) {
          authed = true
          client.send(
            JSON.stringify({
              type: 'snapshot',
              students: [{ student_id: ARIA, display_name: 'Aria K', focus: { target: TARGET, kind: 'problem', title: 'Q1' }, recent: [] }],
              docs: [{ target: TARGET, student_id: ARIA, updates: [toBase64(Y.encodeStateAsUpdate(doc))] }],
            }),
          )
        }
      })
    }),
  )

  const { user } = renderScreen(
    <Routes>
      <Route path="/classes/:classId/live" element={<Live />} />
    </Routes>,
    { route: `/classes/${CLASS}/live` },
  )

  await user.click(await screen.findByRole('button', { name: /Aria K/ }))
  await user.click(await screen.findByRole('button', { name: /Help/ }))
  await waitFor(() =>
    expect(sent).toContainEqual({ type: 'help', target: TARGET, on: true }),
  )

  await user.click(screen.getByRole('button', { name: 'Done helping' }))
  await waitFor(() =>
    expect(sent).toContainEqual({ type: 'help', target: TARGET, on: false }),
  )
})

/* --- the question beside the code (Ken, 7 Nov 2026) ------------------------------------- */

function connectAria(doc: Y.Doc, focus: object, onSend?: (send: (message: unknown) => void) => void) {
  let authed = false
  server.use(
    liveSockets.addEventListener('connection', ({ client }) => {
      onSend?.((message) => client.send(JSON.stringify(message)))
      client.addEventListener('message', () => {
        if (authed) return
        authed = true
        client.send(
          JSON.stringify({
            type: 'snapshot',
            students: [{ student_id: ARIA, display_name: 'Aria K', focus, recent: [] }],
            docs: [{ target: (focus as { target: string }).target, student_id: ARIA, updates: [toBase64(Y.encodeStateAsUpdate(doc))] }],
          }),
        )
      })
    }),
  )
}

function renderLive() {
  return renderScreen(
    <Routes>
      <Route path="/classes/:classId/live" element={<Live />} />
    </Routes>,
    { route: `/classes/${CLASS}/live` },
  )
}

test('an open problem shows its question, and it follows the child to the next one', async () => {
  const OTHER = '018f0000-0000-7000-8000-0000000000bb'
  const doc = new Y.Doc()
  doc.getText('code').insert(0, 'print(1)\n')
  server.use(
    http.get('/api/attempts/:id/question', ({ params }) =>
      HttpResponse.json({
        title: params.id === OTHER ? 'Second' : 'First',
        kind: 'code',
        prompt_md: params.id === OTHER ? 'The second question.' : 'What does this print?',
        options: [],
      } satisfies Schemas['AttemptQuestionOut']),
    ),
  )
  let send: (message: unknown) => void = () => {}
  connectAria(doc, { target: TARGET, kind: 'problem', title: 'First' }, (s) => (send = s))
  const { user } = renderLive()

  await user.click(await screen.findByRole('button', { name: /Aria K/ }))
  expect(await screen.findByText('What does this print?')).toBeInTheDocument()

  send({ type: 'focus', student_id: ARIA, focus: { target: `attempt:${OTHER}`, kind: 'problem', title: 'Second' } })
  expect(await screen.findByText('The second question.')).toBeInTheDocument()
  expect(screen.queryByText('What does this print?')).not.toBeInTheDocument()
})

test('a non-Python file is plain on its tile and has no question', async () => {
  const DOCUMENT = 'document:018f0000-0000-7000-8000-0000000000dd'
  const doc = new Y.Doc()
  doc.getText('code').insert(0, 'print is a word\n')
  let asked = false
  server.use(
    http.get('/api/attempts/:id/question', () => {
      asked = true
      return HttpResponse.json({})
    }),
  )
  connectAria(doc, { target: DOCUMENT, kind: 'file', title: 'notes.txt' })
  const { user } = renderLive()

  const tile = await screen.findByText(/print is a word/, { selector: 'pre' })
  expect(tile.querySelector('span')).toBeNull()
  await user.click(screen.getByRole('button', { name: /Aria K/ }))
  await screen.findByRole('button', { name: 'Close' })
  expect(screen.queryByRole('region', { name: 'The question' })).not.toBeInTheDocument()
  expect(asked).toBe(false)
})

test('during a quiz the question follows the tab, including one they haven’t opened', async () => {
  const QUIZ = '018f0000-0000-7000-8000-0000000000ee'
  const answer = (item_id: string, title: string, prompt_md: string) =>
    ({ item_id, problem_id: item_id, title, kind: 'code', prompt_md, attempt_id: null, code: null, choice: null, options: [], answered: false }) satisfies Schemas['QuizAnswerOut']
  server.use(
    http.get(`/api/classes/${CLASS}/quizzes`, () =>
      HttpResponse.json([
        { id: QUIZ, title: 'Friday quiz', running: true, ends_at: new Date(Date.now() + 600_000).toISOString() },
      ] as unknown as Schemas['QuizOut'][]),
    ),
    http.get(`/api/quizzes/${QUIZ}/sittings`, () => HttpResponse.json([])),
    http.get(`/api/quizzes/${QUIZ}/students/${ARIA}/answers`, () =>
      HttpResponse.json([answer('q1', 'First', 'Quiz question one.'), answer('q2', 'Second', 'Quiz question two.')]),
    ),
  )
  connectAria(new Y.Doc(), { target: TARGET, kind: 'problem', title: 'First', mode: 'quiz' })
  const { user } = renderLive()

  await user.click(await screen.findByRole('button', { name: /Aria K/ }))
  expect(await screen.findByText('Quiz question one.')).toBeInTheDocument()
  await user.click(screen.getByRole('tab', { name: /Second/ }))
  expect(await screen.findByText('Quiz question two.')).toBeInTheDocument()
  expect(screen.queryByText('Quiz question one.')).not.toBeInTheDocument()
})

test('children leaving and coming back in a burst share one re-fetch of the quiz record', async () => {
  const QUIZ = '018f0000-0000-7000-8000-0000000000ee'
  let fetches = 0
  server.use(
    http.get(`/api/classes/${CLASS}/quizzes`, () =>
      HttpResponse.json([
        { id: QUIZ, title: 'Friday quiz', running: true, ends_at: new Date(Date.now() + 600_000).toISOString() },
      ] as unknown as Schemas['QuizOut'][]),
    ),
    http.get(`/api/quizzes/${QUIZ}/sittings`, () => {
      fetches += 1
      return HttpResponse.json([])
    }),
  )
  let send: (data: string) => void = () => undefined
  server.use(
    liveSockets.addEventListener('connection', ({ client }) => {
      client.addEventListener('message', () => {
        send = (data) => client.send(data)
        client.send(JSON.stringify({
          type: 'snapshot',
          students: [{ student_id: ARIA, display_name: 'Aria K', focus: null, recent: [] }],
          docs: [],
        }))
      })
    }),
  )
  renderLive()
  await screen.findByRole('button', { name: /Aria K/ })
  await waitFor(() => expect(fetches).toBe(1))

  for (const away_count of [1, 2, 3, 4, 5]) {
    send(JSON.stringify({ type: 'attention', student_id: ARIA, away_for: null, away_count, away_total: 0 }))
  }
  await waitFor(() => expect(fetches).toBe(2), { timeout: 4_000 })
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(fetches).toBe(2)
})
