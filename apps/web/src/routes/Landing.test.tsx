/**
 * The bare address is the children's sign-in, and it knows who is already here.
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
      <Route path="/classes" element={<p>Classes page</p>} />
    </Routes>,
    { route },
  )
}

test('nobody signed in: the class code, and a side door for teachers', async () => {
  signedOutStudent()
  renderAt('/')

  expect(await screen.findByLabelText('Class code')).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Sign in here' })).toHaveAttribute('href', '/sign-in')
})

test('a child still signed in goes straight to Today', async () => {
  renderAt('/') // the default handler has a signed-in student
  expect(await screen.findByText('Today page')).toBeInTheDocument()
})

test('a teacher with a session goes to their classes', async () => {
  signedOutStudent()
  supabase.token = 'teacher-token'
  renderAt('/')
  expect(await screen.findByText('Classes page')).toBeInTheDocument()
})

test('/join still works for anyone with the old link', async () => {
  renderAt('/join')
  expect(await screen.findByLabelText('Class code')).toBeInTheDocument()
})
