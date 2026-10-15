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
  signIn: async () => undefined,
  sendPasswordReset: async () => undefined,
}))

const classes = <Route path="/classes" element={<p>Classes page</p>} />

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
      <Route element={<RequireTeacher pages={classes} />}>{classes}</Route>
      <Route path="/sign-in" element={<SignIn />} />
    </Routes>,
    { route: '/classes' },
  )

  // Sign out is in the account menu on the desktop's top bar.
  await user.click(await screen.findByRole('button', { name: 'Account' }))
  await user.click(await screen.findByRole('menuitem', { name: /Sign out/ }))

  expect(await screen.findByLabelText('Email')).toBeInTheDocument()
  expect(screen.queryByText('Classes page')).not.toBeInTheDocument()
})
