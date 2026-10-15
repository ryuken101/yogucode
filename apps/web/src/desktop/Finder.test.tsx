/**
 * The Files app (Ken's decision, 16 Oct 2026): Finder-style places, folders and files. One
 * click selects, a double-click or Enter opens — a folder in place, a file in Code.
 */

import { screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { Route, Routes, useLocation } from 'react-router'
import { expect, test } from 'vitest'
import type { Schemas } from '../lib/api'
import { renderScreen } from '../test/render'
import { ARIA_ID, CLASS_ID, server } from '../test/server'
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

function Where() {
  const { pathname, search } = useLocation()
  return <output aria-label="address">{pathname + search}</output>
}

function renderFinder(role: 'teacher' | 'student', route: string) {
  return renderScreen(
    <DeskContext.Provider value={{ role, classId: CLASS_ID, isOwner: false }}>
      <Routes>
        <Route path="/files/students/:studentId" element={<Finder />} />
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
