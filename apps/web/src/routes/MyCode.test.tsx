/**
 * My code: a teacher's own files, and Present mode (Ken's decisions, 10 Oct 2026).
 *
 * The editor is a textarea stand-in that reports the font size it was given, so Present
 * mode's bigger text is something a test can see. Python is mocked; Run is asserted to
 * pass the file's code.
 */

import { screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { beforeEach, expect, test, vi } from 'vitest'
import type { Schemas } from '../lib/api'
import { renderScreen } from '../test/render'
import { server } from '../test/server'

vi.mock('../editor/CodeSurface', () => ({
  CodeSurface: ({
    value,
    onChange,
    fontSize,
    language,
  }: {
    value: string
    onChange: (next: string) => void
    fontSize?: number
    language?: string
  }) => (
    <textarea
      aria-label="Your code"
      data-font-size={fontSize}
      data-language={language ?? 'python'}
      defaultValue={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}))

const python = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('../runtime/usePython', () => ({
  usePython: () => ({
    state: { status: 'idle' },
    output: [],
    run: python.run,
    stop: vi.fn(),
    answer: vi.fn(),
  }),
}))

vi.mock('../lib/supabase', () => ({
  supabaseConfigured: true,
  currentAccessToken: async () => 'teacher-token',
}))

const { MyCode } = await import('./MyCode')

const DOC: Schemas['DocumentOut'] = {
  id: 'd1',
  title: 'squares.py',
  folder_id: null,
  status: 'active',
  content: 'for i in range(5):\n    print(i * i)\n',
  created_at: '2026-10-10T00:00:00Z',
  updated_at: '2026-10-10T00:00:00Z',
}

let saved: unknown[]
let authorization: string | null

beforeEach(() => {
  saved = []
  authorization = null
  python.run.mockReset()
  server.use(
    http.get('/api/teacher/documents', ({ request }) => {
      authorization = request.headers.get('authorization')
      const { content: _content, ...summary } = DOC
      return HttpResponse.json([summary])
    }),
    http.get('/api/teacher/documents/d1', () => HttpResponse.json(DOC)),
    http.patch('/api/teacher/documents/d1', async ({ request }) => {
      const body = (await request.json()) as { content: string }
      saved.push(body)
      return HttpResponse.json({ ...DOC, content: body.content })
    }),
  )
})

async function editor() {
  await waitFor(() => expect(screen.getByLabelText('Your code')).toHaveValue(DOC.content), {
    timeout: 3_000,
  })
  return screen.getByLabelText('Your code')
}

test('opens my last file, runs it, and saves through my own files', async () => {
  const { user } = renderScreen(<MyCode />)

  await editor()
  expect(authorization).toBe('Bearer teacher-token')
  expect(screen.getByRole('tab', { name: /squares\.py/ })).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Run' }))
  expect(python.run).toHaveBeenCalledWith(DOC.content)

  await user.type(await editor(), '# demo')
  await waitFor(() => expect(saved.length).toBeGreaterThan(0), { timeout: 4_000 })
  expect(JSON.stringify(saved.at(-1))).toContain('# demo')
})

test('a first visit gets a starter file', async () => {
  let created = false
  server.use(
    http.get('/api/teacher/documents', () => HttpResponse.json(created ? [DOC] : [])),
    http.post('/api/teacher/documents', () => {
      created = true
      return HttpResponse.json(DOC, { status: 201 })
    }),
  )
  renderScreen(<MyCode />)
  await editor()
  expect(created).toBe(true)
})

test('Present makes the code big and hides the tabs; Exit brings them back', async () => {
  const { user } = renderScreen(<MyCode />)
  const normal = await editor()
  expect(normal).toHaveAttribute('data-font-size', '15')

  await user.click(screen.getByRole('button', { name: 'Present' }))
  expect(screen.getByLabelText('Your code')).toHaveAttribute('data-font-size', '24')
  expect(screen.queryByRole('tab', { name: /squares\.py/ })).not.toBeInTheDocument()
  expect(screen.getByText('squares.py')).toBeInTheDocument() // the file name stays in the bar
  expect(screen.getByRole('button', { name: 'Run' })).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Exit' }))
  expect(screen.getByLabelText('Your code')).toHaveAttribute('data-font-size', '15')
  expect(screen.getByRole('tab', { name: /squares\.py/ })).toBeInTheDocument()
})

test('Escape leaves Present mode', async () => {
  const { user } = renderScreen(<MyCode />)
  await editor()
  await user.click(screen.getByRole('button', { name: 'Present' }))
  expect(screen.getByRole('button', { name: 'Exit' })).toBeInTheDocument()
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('button', { name: 'Exit' })).not.toBeInTheDocument()
})

test('a file whose name does not end in .py is plain text and cannot run', async () => {
  server.use(
    http.get('/api/teacher/documents', () => {
      const { content: _content, ...summary } = DOC
      return HttpResponse.json([{ ...summary, title: 'notes' }])
    }),
    http.get('/api/teacher/documents/d1', () => HttpResponse.json({ ...DOC, title: 'notes' })),
  )
  renderScreen(<MyCode />)
  await editor()
  expect(screen.getByLabelText('Your code')).toHaveAttribute('data-language', 'plaintext')
  expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled()
  expect(screen.getByText(/This is a text file/)).toBeInTheDocument()
})

test('a .py file is Python: coloured and runnable', async () => {
  renderScreen(<MyCode />)
  await editor()
  expect(screen.getByLabelText('Your code')).toHaveAttribute('data-language', 'python')
  expect(screen.getByRole('button', { name: 'Run' })).toBeEnabled()
  expect(screen.queryByText(/This is a text file/)).not.toBeInTheDocument()
})
