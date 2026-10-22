/**
 * Closing the app means signing in again (Ken's decision, 10 Oct 2026).
 *
 * A child's session is a cookie the page cannot read, so the tab they signed in from
 * carries a marker (`lib/tabSession.ts`). Opening the app in a tab without it — after
 * closing the old one, or as a second tab — ends that session on the server and shows the
 * sign-in. Teachers get the same from supabase-js keeping its session in sessionStorage.
 */

import { screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { Route, Routes } from 'react-router'
import { beforeEach, expect, test, vi } from 'vitest'
import { clearStudentTab, isStudentTab } from '../lib/tabSession'
import { renderScreen } from '../test/render'
import type { Schemas } from '../lib/api'
import { ARIA_ID, ARIA_PIN, ARIA_USERNAME, CLASS_ID, server } from '../test/server'
import { Join } from './Join'
import { Landing } from './Landing'
import { RequireStudent } from './RequireStudent'

vi.mock('../lib/supabase', () => ({
  supabaseConfigured: true,
  currentAccessToken: async () => null,
}))

let signedOut = 0

beforeEach(() => {
  signedOut = 0
  // Like the real server: once the session is ended, the cookie no longer signs anyone in.
  server.use(
    http.get('/api/auth/student/me', () =>
      signedOut > 0
        ? HttpResponse.json({ detail: 'session is no longer valid' }, { status: 401 })
        : HttpResponse.json(ME),
    ),
    http.post('/api/auth/student/logout', () => {
      signedOut += 1
      return new HttpResponse(null, { status: 204 })
    }),
  )
})

const ME: Schemas['StudentMeOut'] = {
  student_id: ARIA_ID,
  display_name: 'Aria K',
  class_id: CLASS_ID,
  class_name: 'Year 4-6 Python',
  term_label: '2026 T4',
}

const today = <Route path="/home" element={<p>Today page</p>} />

function app(route: string) {
  return renderScreen(
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/join" element={<Join />} />
      <Route element={<RequireStudent pages={today} />}>{today}</Route>
    </Routes>,
    { route },
  )
}

test('reopening after the tab was closed signs the child out and shows the front page', async () => {
  clearStudentTab() // a fresh tab: the old one, and its marker, are gone
  app('/') // the default handler still has a live session cookie

  expect((await screen.findAllByRole('link', { name: 'Student sign in' }))[0]).toBeInTheDocument()
  expect(screen.queryByText('Today page')).not.toBeInTheDocument()
  await waitFor(() => expect(signedOut).toBe(1), { timeout: 2000 })
})

test('a bookmarked student page in a fresh tab also goes to the sign-in', async () => {
  clearStudentTab()
  app('/home')

  expect(await screen.findByLabelText('Username')).toBeInTheDocument()
  expect(screen.queryByText('Today page')).not.toBeInTheDocument()
  expect(signedOut).toBe(1)
})

test('in the tab they signed in from, a reload keeps them in', async () => {
  // The default: setup marks this tab as the child's.
  app('/')
  expect(await screen.findByText('Today page')).toBeInTheDocument()
  expect(signedOut).toBe(0)
})

test('signing in marks this tab as the child’s', async () => {
  clearStudentTab()
  server.use(
    http.get('/api/auth/student/me', () =>
      HttpResponse.json({ detail: 'not signed in' }, { status: 401 }),
    ),
  )
  const { user } = renderScreen(<Join />)

  await user.type(await screen.findByLabelText('Username'), ARIA_USERNAME)
  await user.type(screen.getByLabelText('PIN'), ARIA_PIN)
  await user.click(screen.getByRole('button', { name: 'Sign in' }))

  await screen.findByText(/You’re in/)
  expect(isStudentTab()).toBe(true)
})
