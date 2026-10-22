/**
 * Signing a child out must leave the laptop on the sign-in page, ready for the next child.
 * Regression: Ken signed out as a student and was left with no way to sign back in.
 */

import { screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { Route, Routes } from 'react-router'
import { beforeEach, expect, test, vi } from 'vitest'
import { renderScreen } from '../test/render'
import { server } from '../test/server'
import App from '../App'
import { Join } from './Join'
import { Landing } from './Landing'
import { RequireStudent } from './RequireStudent'

vi.mock('../lib/supabase', () => ({
  supabaseConfigured: true,
  currentAccessToken: async () => null,
}))

let signedIn = true

beforeEach(() => {
  signedIn = true
  server.use(
    http.get('/api/auth/student/me', () =>
      signedIn
        ? HttpResponse.json({
            student_id: 's1', display_name: 'Aria K', class_id: 'c1',
            class_name: 'Year 4-6 Python', term_label: null,
          })
        : HttpResponse.json({ detail: 'not signed in' }, { status: 401 }),
    ),
    http.post('/api/auth/student/logout', () => {
      signedIn = false
      return new HttpResponse(null, { status: 204 })
    }),
  )
})

test('signing out lands on the sign-in, ready for the next child', async () => {
  const { user } = renderScreen(
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/join" element={<Join />} />
      <Route element={<RequireStudent />}>
        <Route path="/home" element={<p>Today page</p>} />
      </Route>
    </Routes>,
    { route: '/home' },
  )

  await user.click(await screen.findByRole('button', { name: 'Sign out' }))

  expect(await screen.findByLabelText('Username', {}, { timeout: 3000 })).toBeInTheDocument()
})

for (const start of ['/home', '/work', '/homework/018f0000-0000-7000-8000-0000000000a1']) {
  test(`signing out from ${start} in the whole app lands on the sign-in`, async () => {
    server.use(
      http.get('/api/me/home', () =>
        HttpResponse.json(
          signedIn
            ? { today: { class_name: 'Y', lesson_title: null, assignment_id: null, problems: [] }, homework: [] }
            : { detail: 'not signed in' },
          { status: signedIn ? 200 : 401 },
        ),
      ),
    )
    const errors = vi.spyOn(console, 'error')
    const { user } = renderScreen(<App />, { route: start })
    await user.click(await screen.findByRole('button', { name: 'Sign out' }))
    expect(await screen.findByLabelText('Username', {}, { timeout: 3000 })).toBeInTheDocument()
    expect(errors.mock.calls.map((c) => String(c[0])).filter((m) => !m.includes('act('))).toEqual([])
  })
}
