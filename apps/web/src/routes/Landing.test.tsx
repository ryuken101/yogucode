/**
 * The bare address is the public landing page, with the sign-ins in its top bar, and it
 * knows who is already here.
 */

import { screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { Route, Routes } from 'react-router'
import { beforeEach, expect, test, vi } from 'vitest'
import { renderScreen } from '../test/render'
import { server } from '../test/server'
import { Join } from './Join'
import { Landing } from './Landing'

const supabase = vi.hoisted(() => ({ token: null as string | null }))
vi.mock('../lib/supabase', () => ({
  supabaseConfigured: true,
  currentAccessToken: async () => supabase.token,
}))

beforeEach(() => {
  supabase.token = null
})

function signedOutStudent() {
  server.use(
    http.get('/api/auth/student/me', () =>
      HttpResponse.json({ detail: 'not signed in' }, { status: 401 }),
    ),
  )
}

function renderAt(route: string) {
  return renderScreen(
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/join" element={<Join />} />
      <Route path="/home" element={<p>Today page</p>} />
      <Route path="/desk" element={<p>Desktop</p>} />
    </Routes>,
    { route },
  )
}

test('nobody signed in: the landing page, with a door for children and one for teachers', async () => {
  signedOutStudent()
  renderAt('/')

  expect((await screen.findAllByRole('link', { name: 'Student sign in' }))[0]).toHaveAttribute('href', '/join')
  expect(screen.getAllByRole('link', { name: 'Teacher sign in' })[0]).toHaveAttribute('href', '/sign-in')
  expect(await screen.findByRole('heading', { level: 1, name: /all-in-one platform for coding academies/ })).toBeInTheDocument()
})

test('Student sign in leads to the username and PIN form', async () => {
  signedOutStudent()
  const { user } = renderAt('/')
  await user.click((await screen.findAllByRole('link', { name: 'Student sign in' }))[0])
  expect(await screen.findByLabelText('Username')).toBeInTheDocument()
})

test('a child still signed in goes straight to Today', async () => {
  renderAt('/') // the default handler has a signed-in student
  expect(await screen.findByText('Today page')).toBeInTheDocument()
})

test('a teacher with a session goes to their desktop', async () => {
  signedOutStudent()
  supabase.token = 'teacher-token'
  renderAt('/')
  expect(await screen.findByText('Desktop')).toBeInTheDocument()
})

test('/join still works for anyone with the old link', async () => {
  renderAt('/join')
  expect(await screen.findByLabelText('Username')).toBeInTheDocument()
})
