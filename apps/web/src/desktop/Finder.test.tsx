/**
 * The Files app (Ken's decision, 16 Oct 2026): Finder-style places, folders and files. One
 * click selects, a double-click or Enter opens — a folder in place, a file in Code. Since
 * 17 Oct 2026 it organises too: a right-click menu, naming in place, drag to move, copy and
 * paste (across places as well), and the keyboard.
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { Route, Routes, useLocation } from 'react-router'
import { beforeEach, expect, test } from 'vitest'
import type { Schemas } from '../lib/api'
import { renderScreen } from '../test/render'
import { ARIA_ID, CLASS_ID, server } from '../test/server'
import { setClip } from './clipboard'
import { DeskContext } from './context'
import { Finder } from './Finder'

const FOLDER = '018f0000-0000-7000-8000-0000000000a1'
const STARS = '018f0000-0000-7000-8000-0000000000d1'
const NOTES = '018f0000-0000-7000-8000-0000000000d2'
const at = '2026-10-15T00:00:00Z'

const folder: Schemas['FolderOut'] = { id: FOLDER, name: 'Lesson 6', parent_id: null, created_at: at, updated_at: at }
const files: Schemas['DocumentSummaryOut'][] = [
  { id: STARS, title: 'stars.py', folder_id: FOLDER, status: 'active', created_at: at, updated_at: at },
  { id: NOTES, title: 'notes.txt', folder_id: null, status: 'active', created_at: at, updated_at: at },
]

// The clipboard is the tab's, so it would carry from one test to the next.
beforeEach(() => setClip(null))

function Where() {
  const { pathname, search } = useLocation()
  return <output aria-label="address">{pathname + search}</output>
}

function renderFinder(role: 'teacher' | 'student', route: string) {
  return renderScreen(
    <DeskContext.Provider value={{ role, classId: CLASS_ID, isOwner: false }}>
      <Routes>
        <Route path="/files/students/:studentId" element={<Finder />} />
        <Route path="/files/mine" element={<Finder />} />
        <Route path="/files" element={<Finder />} />
        <Route path="/my-files" element={<Finder />} />
        <Route path="*" element={null} />
      </Routes>
      <Where />
    </DeskContext.Provider>,
    { route },
  )
}

function aChildsFiles() {
  server.use(
    http.get(`/api/classes/${CLASS_ID}/roster`, () =>
      HttpResponse.json([
        {
          student_id: ARIA_ID, display_name: 'Aria K', username: 'aria.k', has_pin: true, pin_viewable: true,
          student_status: 'active', status: 'active', joined_at: at, withdrawn_at: null,
        },
      ] satisfies Schemas['RosterEntryOut'][]),
    ),
    http.get(`/api/students/${ARIA_ID}/folders`, () => HttpResponse.json([folder])),
    http.get(`/api/students/${ARIA_ID}/documents`, () => HttpResponse.json(files)),
  )
}

test('a teacher sees the class’s children as places, and a child’s top folder', async () => {
  aChildsFiles()
  renderFinder('teacher', `/files/students/${ARIA_ID}`)
  expect(await screen.findByRole('button', { name: 'Lesson 6, folder' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'notes.txt, file' })).toBeInTheDocument()
  // stars.py is inside Lesson 6, not at the top.
  expect(screen.queryByRole('button', { name: 'stars.py, file' })).not.toBeInTheDocument()
  const places = within(screen.getByRole('navigation', { name: 'Places' }))
  expect(places.getByRole('button', { name: 'Aria K' })).toHaveAttribute('aria-current', 'page')
})

test('a click selects, a double-click opens the folder, and Back comes out of it', async () => {
  aChildsFiles()
  const { user } = renderFinder('teacher', `/files/students/${ARIA_ID}`)
  const lesson = await screen.findByRole('button', { name: 'Lesson 6, folder' })

  await user.click(lesson)
  expect(lesson).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByText(/Lesson 6 selected/)).toBeInTheDocument()

  await user.dblClick(lesson)
  expect(await screen.findByRole('button', { name: 'stars.py, file' })).toBeInTheDocument()
  expect(screen.getByLabelText('address')).toHaveTextContent(`?folder=${FOLDER}`)

  await user.click(screen.getByRole('button', { name: 'Back' }))
  expect(await screen.findByRole('button', { name: 'notes.txt, file' })).toBeInTheDocument()
})

test('opening a child’s file shows it in Code, read-only', async () => {
  aChildsFiles()
  const { user } = renderFinder('teacher', `/files/students/${ARIA_ID}?folder=${FOLDER}`)
  const stars = await screen.findByRole('button', { name: 'stars.py, file' })
  await user.click(stars)
  await user.click(screen.getByRole('button', { name: 'Open' }))
  await waitFor(() =>
    expect(screen.getByLabelText('address')).toHaveTextContent(`/code/students/${ARIA_ID}/${STARS}`),
  )
})

test('the list view shows the same items, with their kind', async () => {
  aChildsFiles()
  const { user } = renderFinder('teacher', `/files/students/${ARIA_ID}`)
  await screen.findByRole('button', { name: 'Lesson 6, folder' })
  await user.click(screen.getByRole('button', { name: 'List' }))
  expect(screen.getByRole('table')).toBeInTheDocument()
  expect(screen.getByText('Folder')).toBeInTheDocument()
  expect(screen.getByText('Text file')).toBeInTheDocument()
})

test('a child’s own file opens in their editor', async () => {
  server.use(
    http.get('/api/me/folders', () => HttpResponse.json([])),
    http.get('/api/me/documents', () => HttpResponse.json([{ ...files[1]!, folder_id: null }])),
  )
  const { user } = renderFinder('student', '/my-files')
  const places = within(screen.getByRole('navigation', { name: 'Places' }))
  expect(places.getByRole('button', { name: 'My work' })).toHaveAttribute('aria-current', 'page')
  await user.dblClick(await screen.findByRole('button', { name: 'notes.txt, file' }))
  await waitFor(() => expect(screen.getByLabelText('address')).toHaveTextContent(`/work?open=${NOTES}`))
})

/* --- organising, as in Finder (17 Oct 2026) ----------------------------------------------- */

type Sent = { method: string; path: string; body: unknown }

/** A child's files that a teacher can organise; every write is recorded. */
function organisable() {
  aChildsFiles()
  const sent: Sent[] = []
  const base = `/api/students/${ARIA_ID}`
  const record = (method: string) => async ({ request, params }: { request: Request; params: Record<string, unknown> }) => {
    const body = request.method === 'GET' ? null : await request.json().catch(() => null)
    sent.push({ method, path: new URL(request.url).pathname, body })
    void params
    return null
  }
  const folderList = [folder]
  server.use(
    http.get(`${base}/folders`, () => HttpResponse.json(folderList)),
    http.post(`${base}/folders`, async (info) => {
      await record('POST')(info)
      const made = { ...folder, id: 'new-folder', name: 'untitled folder' }
      folderList.push(made)
      return HttpResponse.json(made, { status: 201 })
    }),
    http.patch(`${base}/folders/:id`, async (info) => {
      await record('PATCH')(info)
      return HttpResponse.json(folder)
    }),
    http.post(`${base}/documents`, async (info) => {
      await record('POST')(info)
      return HttpResponse.json({ ...files[1]!, id: 'new-file', title: 'untitled.py', content: '' }, { status: 201 })
    }),
    http.patch(`${base}/documents/:id`, async (info) => {
      await record('PATCH')(info)
      return HttpResponse.json({ ...files[1]!, content: '' })
    }),
    http.post(`${base}/documents/:id/archive`, async (info) => {
      await record('POST')(info)
      return HttpResponse.json({ ...files[1]!, status: 'archived', content: '' })
    }),
    http.get(`${base}/documents/:id`, () => HttpResponse.json({ ...files[1]!, content: 'my notes' })),
  )
  return sent
}

test('right-clicking empty space makes a folder, named in place', async () => {
  const sent = organisable()
  const { user } = renderFinder('teacher', `/files/students/${ARIA_ID}`)
  await screen.findByRole('button', { name: 'Lesson 6, folder' })

  await user.pointer({ keys: '[MouseRight]', target: screen.getByRole('region', { name: 'Folder contents' }) })
  await user.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /New folder/ }))
  await waitFor(() => expect(sent[0]).toMatchObject({ method: 'POST', body: { name: 'untitled folder', parent_id: null } }))

  const box = await screen.findByLabelText('New name for untitled folder')
  await user.clear(box)
  await user.type(box, 'Week 2{Enter}')
  await waitFor(() =>
    expect(sent.at(-1)).toMatchObject({ method: 'PATCH', path: `/api/students/${ARIA_ID}/folders/new-folder`, body: { name: 'Week 2' } }),
  )
})

test('right-clicking a file renames it; a refused name keeps the box open, in not-yet', async () => {
  organisable()
  server.use(
    http.patch(`/api/students/${ARIA_ID}/documents/:id`, () =>
      HttpResponse.json({ detail: 'You already have a file with that name here' }, { status: 409 }),
    ),
  )
  const { user } = renderFinder('teacher', `/files/students/${ARIA_ID}`)
  const notes = await screen.findByRole('button', { name: 'notes.txt, file' })
  await user.pointer({ keys: '[MouseRight]', target: notes })
  await user.click(screen.getByRole('menuitem', { name: /Rename/ }))
  const box = screen.getByLabelText('New name for notes.txt')
  await user.clear(box)
  await user.type(box, 'stars.py{Enter}')

  const notice = await screen.findByText('You already have a file with that name here')
  expect(notice.closest('[class*="not-yet"]')).not.toBeNull()
  expect(screen.getByLabelText('New name for notes.txt')).toBeInTheDocument()
})

test('Delete asks first, then puts the file away', async () => {
  const sent = organisable()
  const { user } = renderFinder('teacher', `/files/students/${ARIA_ID}`)
  await user.click(await screen.findByRole('button', { name: 'notes.txt, file' }))
  await user.keyboard('{Delete}')
  const confirm = screen.getByText('Delete notes.txt?').closest('dialog')!
  expect(sent).toEqual([])
  await user.click(within(confirm).getByRole('button', { name: 'Delete' }))
  await waitFor(() => expect(sent.at(-1)?.path).toBe(`/api/students/${ARIA_ID}/documents/${NOTES}/archive`))
})

test('dragging a file onto a folder moves it there', async () => {
  const sent = organisable()
  renderFinder('teacher', `/files/students/${ARIA_ID}`)
  const notes = await screen.findByRole('button', { name: 'notes.txt, file' })
  const lesson = screen.getByRole('button', { name: 'Lesson 6, folder' })
  const data = new Map<string, string>()
  const dataTransfer = {
    setData: (type: string, value: string) => data.set(type, value),
    getData: (type: string) => data.get(type) ?? '',
    get types() {
      return [...data.keys()]
    },
    effectAllowed: 'move',
  }
  fireEvent.dragStart(notes, { dataTransfer })
  fireEvent.dragOver(lesson, { dataTransfer })
  fireEvent.drop(lesson, { dataTransfer })
  await waitFor(() =>
    expect(sent.at(-1)).toMatchObject({ method: 'PATCH', path: `/api/students/${ARIA_ID}/documents/${NOTES}`, body: { folder_id: FOLDER } }),
  )
})

test('copy and paste into a folder makes a copy, with the content', async () => {
  const sent = organisable()
  const { user } = renderFinder('teacher', `/files/students/${ARIA_ID}`)
  await user.click(await screen.findByRole('button', { name: 'notes.txt, file' }))
  await user.keyboard('{Control>}c{/Control}')
  await user.dblClick(screen.getByRole('button', { name: 'Lesson 6, folder' }))
  await user.click(await screen.findByRole('button', { name: 'stars.py, file' }))
  await user.keyboard('{Control>}v{/Control}')
  await waitFor(() =>
    expect(sent.at(-1)).toMatchObject({
      method: 'POST',
      path: `/api/students/${ARIA_ID}/documents`,
      body: { folder_id: FOLDER, title: 'notes.txt', content: 'my notes' },
    }),
  )
})

test('a teacher pastes a file from My code into a child’s folder', async () => {
  const sent = organisable()
  server.use(
    http.get('/api/teacher/folders', () => HttpResponse.json([])),
    http.get('/api/teacher/documents', () =>
      HttpResponse.json([{ ...files[0]!, id: 'mine', title: 'handout.py', folder_id: null }]),
    ),
    http.get('/api/teacher/documents/mine', () =>
      HttpResponse.json({ ...files[0]!, id: 'mine', title: 'handout.py', folder_id: null, content: 'print(1)' }),
    ),
  )
  const { user } = renderFinder('teacher', '/files/mine')
  await user.click(await screen.findByRole('button', { name: 'handout.py, file' }))
  await user.keyboard('{Control>}c{/Control}')
  await user.click(within(screen.getByRole('navigation', { name: 'Places' })).getByRole('button', { name: 'Aria K' }))
  await user.click(await screen.findByRole('button', { name: 'notes.txt, file' }))
  await user.keyboard('{Control>}v{/Control}')
  await waitFor(() =>
    expect(sent.at(-1)).toMatchObject({
      method: 'POST',
      path: `/api/students/${ARIA_ID}/documents`,
      body: { folder_id: null, title: 'handout.py', content: 'print(1)' },
    }),
  )
})

test('F2 renames from the keyboard', async () => {
  organisable()
  const { user } = renderFinder('teacher', `/files/students/${ARIA_ID}`)
  await user.click(await screen.findByRole('button', { name: 'notes.txt, file' }))
  await user.keyboard('{F2}')
  expect(screen.getByLabelText('New name for notes.txt')).toHaveFocus()
})
