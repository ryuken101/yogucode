/**
 * Signing a teacher out must land on the sign-in page, not bounce back to their classes.
 * Regression: the cached profile made the sign-in page think they were still signed in.
 */

import { screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { Route, Routes } from 'react-router'
import { expect, test, vi } from 'vitest'
import type { Schemas } from '../lib/api'
import { renderScreen } from '../test/render'
import { server } from '../test/server'
import { RequireTeacher } from './RequireTeacher'
import { SignIn } from './SignIn'

const session = vi.hoisted(() => ({ signedIn: true }))
vi.mock('../lib/supabase', () => ({
  supabaseConfigured: true,
  currentAccessToken: async () => (session.signedIn ? 'token' : null),
  signOut: async () => {
    session.signedIn = false
  },
  sendMagicLink: async () => undefined,
}))

test('signing out lands on the sign-in page and stays there', async () => {
  server.use(
    http.get('/api/auth/me', () =>
      session.signedIn
        ? HttpResponse.json({
            id: 'u1', email: 'ken@example.com', display_name: 'Ken', role: 'owner',
            centre: { id: 'c1', name: 'Magikid Castle Hill', slug: 'castle-hill' },
          } satisfies Schemas['TeacherProfileOut'])
        : HttpResponse.json({ detail: 'not signed in' }, { status: 401 }),
    ),
  )
  const { user } = renderScreen(
    <Routes>
      <Route element={<RequireTeacher />}>
        <Route path="/classes" element={<p>Classes page</p>} />
      </Route>
      <Route path="/sign-in" element={<SignIn />} />
    </Routes>,
    { route: '/classes' },
  )

  await user.click(await screen.findByRole('button', { name: 'Sign out' }))

  expect(await screen.findByLabelText('Email address')).toBeInTheDocument()
  expect(screen.queryByText('Classes page')).not.toBeInTheDocument()
})
