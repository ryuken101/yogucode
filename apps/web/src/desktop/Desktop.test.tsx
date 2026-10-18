/**
 * The desktop around the pages (Ken's decisions, 16 Oct 2026): a teacher starts in Live,
 * the dock opens apps, the URL follows the front window, a teacher's layout is saved and
 * comes back, and a child's windows cannot be arranged.
 *
 * The guards are given stand-in pages, so what is under test is the desktop, not them.
 */

import { screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { Route, Routes, useLocation } from 'react-router'
import { expect, test, vi } from 'vitest'
import type { Schemas } from '../lib/api'
import { RequireStudent } from '../routes/RequireStudent'
import { RequireTeacher } from '../routes/RequireTeacher'
import { renderScreen } from '../test/render'
import { CLASS_ID, server } from '../test/server'

vi.mock('../lib/supabase', () => ({
  supabaseConfigured: true,
  currentAccessToken: async () => 'token',
  signOut: async () => undefined,
}))

const KLASS: Schemas['ClassOut'] = {
  id: CLASS_ID,
  name: 'Year 4-6 Python',
  term_label: null,
  status: 'active',
  course_id: null,
  current_lesson_id: null,
  is_mine: true,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
}

const teacherPages = (
  <>
    <Route path="/classes/:classId/live" element={<p>Live page</p>} />
    <Route path="/classes/:classId" element={<p>Class page</p>} />
    <Route path="/classes" element={<p>Classes page</p>} />
    <Route path="/my-code" element={<p>My code page</p>} />
    <Route path="/desk" element={null} />
  </>
)

/** The browser's address, as the desktop sets it. */
function Where() {
  const { pathname } = useLocation()
  return <output aria-label="address">{pathname}</output>
}

function asTeacher(saved: Schemas['DesktopOut'] = { windows: [], class_id: null, saved: false }) {
  const saves: Schemas['DesktopIn'][] = []
  server.use(
    http.get('/api/auth/me', () =>
      HttpResponse.json({
        id: 'u1', email: 'ken@example.com', display_name: 'Ken', role: 'owner',
        centre: { id: 'c1', name: 'Magikid Castle Hill', slug: 'castle-hill' },
      } satisfies Schemas['TeacherProfileOut']),
    ),
    http.get('/api/classes', () => HttpResponse.json([KLASS])),
    http.get('/api/me/desktop', () => HttpResponse.json(saved)),
    http.put('/api/me/desktop', async ({ request }) => {
      const body = (await request.json()) as Schemas['DesktopIn']
      saves.push(body)
      return HttpResponse.json({ ...body, saved: true })
    }),
  )
  const view = renderScreen(
    <>
      <Routes>
        <Route element={<RequireTeacher pages={teacherPages} />}>{teacherPages}</Route>
      </Routes>
      <Where />
    </>,
    { route: '/desk' },
  )
  return { ...view, saves }
}

const address = () => screen.getByLabelText('address').textContent

test('a teacher’s desktop starts in Live, for their class', async () => {
  asTeacher()
  expect(await screen.findByText('Live page')).toBeInTheDocument()
  expect(screen.getByRole('region', { name: 'Live · Year 4-6 Python' })).toBeInTheDocument()
  await waitFor(() => expect(address()).toBe(`/classes/${CLASS_ID}/live`))
})

test('the dock opens an app, and closing it gives the address back to the window behind', async () => {
  const { user } = asTeacher()
  await screen.findByText('Live page')

  await user.click(screen.getByRole('button', { name: 'Open Code' }))
  expect(await screen.findByText('My code page')).toBeInTheDocument()
  await waitFor(() => expect(address()).toBe('/my-code'))

  await user.click(screen.getByRole('button', { name: 'Close Code' }))
  await waitFor(() => expect(address()).toBe(`/classes/${CLASS_ID}/live`))
  await waitFor(() => expect(screen.queryByText('My code page')).not.toBeInTheDocument())
})

test('a saved layout comes back, and changes are saved to the account', async () => {
  const { user, saves } = asTeacher({
    windows: [{ app: 'code', path: '/my-code', x: 0.5, y: 0, w: 0.5, h: 1, max: false, min: false, z: 3 }],
    class_id: CLASS_ID,
    saved: true,
  })
  expect(await screen.findByText('My code page')).toBeInTheDocument()
  expect(screen.queryByText('Live page')).not.toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Open Live' }))
  await screen.findByText('Live page')
  await waitFor(() => expect(saves.at(-1)?.windows?.map((w) => w.app)).toEqual(['code', 'live']), {
    timeout: 3000,
  })
  expect(saves.at(-1)?.class_id).toBe(CLASS_ID)
})

test('a teacher can make a window of a full-screen app', async () => {
  const { user } = asTeacher()
  await screen.findByText('Live page')
  await user.click(screen.getByRole('button', { name: 'Make it a window' }))
  expect(screen.getByRole('button', { name: 'Full screen' })).toBeInTheDocument()
})

test('a child’s windows are not arranged or saved, but switch to a window and back', async () => {
  let saved = 0
  server.use(http.put('/api/me/desktop', () => {
    saved += 1
    return HttpResponse.json({})
  }))
  const pages = (
    <>
      <Route path="/home" element={<p>Today page</p>} />
      <Route path="/my-desk" element={null} />
    </>
  )
  const { user } = renderScreen(
    <Routes>
      <Route element={<RequireStudent pages={pages} />}>{pages}</Route>
    </Routes>,
    { route: '/home' },
  )
  expect(await screen.findByText('Today page')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Open Lessons' })).toBeInTheDocument()
  // A window opened full screen can become a window and back (18 Oct 2026), but is never
  // dragged into a saved layout.
  await user.click(screen.getByRole('button', { name: 'Make it a window' }))
  await user.click(await screen.findByRole('button', { name: 'Full screen' }))
  expect(await screen.findByRole('button', { name: 'Make it a window' })).toBeInTheDocument()
  await new Promise((resolve) => setTimeout(resolve, 1000))
  expect(saved).toBe(0)
})

test('a child in a side-by-side layout can go back to full screen', async () => {
  const pages = (
    <>
      <Route path="/home" element={<p>Today page</p>} />
      <Route path="/work" element={<p>Code page</p>} />
      <Route path="/my-desk" element={null} />
    </>
  )
  const { user } = renderScreen(
    <Routes>
      <Route element={<RequireStudent pages={pages} />}>{pages}</Route>
    </Routes>,
    { route: '/home' },
  )
  await screen.findByText('Today page')
  await user.click(screen.getByRole('button', { name: 'Layouts' }))
  await user.click(screen.getByRole('menuitem', { name: /Lesson and my code/ }))
  const fullScreen = await screen.findAllByRole('button', { name: 'Full screen' })
  await user.click(fullScreen[0]!)
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'Full screen' })).toHaveLength(1))
})
