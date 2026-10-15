/**
 * Teacher accounts: sign-in with a password, sign-up by invitation, password reset, the
 * callback, and the owner's Teachers page (Ken's decisions, 10 Oct 2026).
 *
 * Supabase is mocked at the module boundary (`lib/supabase`), keeping the real error
 * mapping and constants; the API is the MSW mock. The palette rule is asserted where it
 * bites: a wrong password, an uninvited email and an expired link are `not-yet`, never
 * `system-error`.
 */

import { screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { Route, Routes } from 'react-router'
import { beforeEach, expect, test, vi } from 'vitest'
import type { Schemas } from '../lib/api'
import { renderScreen } from '../test/render'
import { server } from '../test/server'
import { AuthCallback } from './AuthCallback'
import { ResetPassword } from './ResetPassword'
import { SignIn } from './SignIn'
import { SignUp } from './SignUp'
import { Teachers } from './Teachers'

const auth = vi.hoisted(() => ({
  token: null as string | null,
  signIn: vi.fn(),
  signUp: vi.fn(),
  signOut: vi.fn(),
  sendPasswordReset: vi.fn(),
  resendVerification: vi.fn(),
  updatePassword: vi.fn(),
}))

vi.mock('../lib/supabase', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/supabase')>()
  return {
    ...real,
    supabaseConfigured: true,
    currentAccessToken: async () => auth.token,
    signIn: auth.signIn,
    signUp: auth.signUp,
    signOut: auth.signOut,
    sendPasswordReset: auth.sendPasswordReset,
    resendVerification: auth.resendVerification,
    updatePassword: auth.updatePassword,
  }
})

const { AuthProblem } = await import('../lib/supabase')

const PROFILE: Schemas['TeacherProfileOut'] = {
  id: 'u1',
  email: 'ken@example.com',
  display_name: 'Ken',
  role: 'owner',
  centre: { id: 'c1', name: 'Magikid Castle Hill', slug: 'castle-hill' },
}

beforeEach(() => {
  auth.token = null
  for (const fn of Object.values(auth)) if (typeof fn === 'function') fn.mockReset()
  window.location.hash = ''
  server.use(
    http.get('/api/auth/me', () =>
      HttpResponse.json({ detail: 'not signed in' }, { status: 401 }),
    ),
  )
})

function screens(route: string) {
  return renderScreen(
    <Routes>
      <Route path="/sign-in" element={<SignIn />} />
      <Route path="/sign-up" element={<SignUp />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/auth/callback" element={<AuthCallback />} />
      <Route path="/desk" element={<p>Desktop</p>} />
    </Routes>,
    { route },
  )
}

// --- sign in ----------------------------------------------------------------------------

test('signing in with a password finishes through the callback', async () => {
  auth.signIn.mockImplementation(async () => {
    auth.token = 'token'
  })
  server.use(http.post('/api/auth/teacher/session', () => HttpResponse.json(PROFILE)))
  const { user } = screens('/sign-in')

  await user.type(await screen.findByLabelText('Email'), 'ken@example.com')
  await user.type(screen.getByLabelText('Password'), 'correct horse')
  await user.click(screen.getByRole('button', { name: 'Sign in' }))

  expect(await screen.findByText('Desktop')).toBeInTheDocument()
  expect(auth.signIn).toHaveBeenCalledWith('ken@example.com', 'correct horse')
})

test('a wrong password is not-yet, never system-error', async () => {
  auth.signIn.mockRejectedValue(new AuthProblem('That email and password don’t match.', true))
  const { user } = screens('/sign-in')

  await user.type(await screen.findByLabelText('Email'), 'ken@example.com')
  await user.type(screen.getByLabelText('Password'), 'wrong one')
  await user.click(screen.getByRole('button', { name: 'Sign in' }))

  const message = await screen.findByText('That email and password don’t match.')
  expect(message.className).toContain('not-yet')
  expect(document.body.innerHTML).not.toContain('system-error')
})

test('the password can be shown and hidden', async () => {
  const { user } = screens('/sign-in')
  const field = await screen.findByLabelText('Password')
  expect(field).toHaveAttribute('type', 'password')
  await user.click(screen.getByRole('button', { name: 'Show password' }))
  expect(field).toHaveAttribute('type', 'text')
})

test('forgot password sends a reset link without saying whether the account exists', async () => {
  auth.sendPasswordReset.mockResolvedValue(undefined)
  const { user } = screens('/sign-in')

  await user.click(await screen.findByRole('button', { name: 'Forgot password?' }))
  await user.type(screen.getByLabelText('Email'), 'ken@example.com')
  await user.click(screen.getByRole('button', { name: 'Email me a reset link' }))

  expect(await screen.findByText(/If there’s an account for ken@example.com/)).toBeInTheDocument()
  expect(auth.sendPasswordReset).toHaveBeenCalledWith('ken@example.com')
})

// --- sign up ----------------------------------------------------------------------------

async function fillSignUp(user: ReturnType<typeof screens>['user'], email = 'sam@school.test') {
  await user.type(await screen.findByLabelText('Your name'), 'Sam Lee')
  await user.type(screen.getByLabelText('Email'), email)
  await user.type(screen.getByLabelText('Password'), 'long enough pw')
  await user.click(screen.getByRole('button', { name: 'Create account' }))
}

test('an uninvited email is told to ask, before any account is created', async () => {
  server.use(http.get('/api/auth/signup-allowed', () => HttpResponse.json({ allowed: false })))
  const { user } = screens('/sign-up')
  await fillSignUp(user)

  const message = await screen.findByText(/hasn’t been invited/)
  expect(message.className).toContain('not-yet')
  expect(auth.signUp).not.toHaveBeenCalled()
})

test('an invited email gets "check your email", and can resend it', async () => {
  server.use(http.get('/api/auth/signup-allowed', () => HttpResponse.json({ allowed: true })))
  auth.signUp.mockResolvedValue('sent')
  auth.resendVerification.mockResolvedValue(undefined)
  const { user } = screens('/sign-up')
  await fillSignUp(user)

  expect(await screen.findByText(/We sent a link to sam@school.test/)).toBeInTheDocument()
  expect(auth.signUp).toHaveBeenCalledWith('Sam Lee', 'sam@school.test', 'long enough pw')

  await user.click(screen.getByRole('button', { name: 'Resend the email' }))
  expect(await screen.findByText('Sent again.')).toBeInTheDocument()
})

test('an address that already has an account is sent to sign in', async () => {
  server.use(http.get('/api/auth/signup-allowed', () => HttpResponse.json({ allowed: true })))
  auth.signUp.mockResolvedValue('exists')
  const { user } = screens('/sign-up')
  await fillSignUp(user)

  expect(await screen.findByText('You already have an account')).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Go to sign in' })).toHaveAttribute('href', '/sign-in')
})

test('a short password cannot be submitted', async () => {
  const { user } = screens('/sign-up')
  await user.type(await screen.findByLabelText('Your name'), 'Sam')
  await user.type(screen.getByLabelText('Email'), 'sam@school.test')
  await user.type(screen.getByLabelText('Password'), 'short')

  expect(screen.getByText('At least 10 characters.')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Create account' })).toBeDisabled()
})

// --- reset password -----------------------------------------------------------------------

test('a new password must be typed the same twice, then signs in', async () => {
  auth.token = 'recovery-token'
  auth.updatePassword.mockResolvedValue(undefined)
  server.use(http.post('/api/auth/teacher/session', () => HttpResponse.json(PROFILE)))
  const { user } = screens('/reset-password')

  await user.type(await screen.findByLabelText('New password'), 'a brand new pw')
  await user.type(screen.getByLabelText('Type it again'), 'a brand new px')
  expect(screen.getByText('These don’t match yet.')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Save and sign in' })).toBeDisabled()

  await user.clear(screen.getByLabelText('Type it again'))
  await user.type(screen.getByLabelText('Type it again'), 'a brand new pw')
  await user.click(screen.getByRole('button', { name: 'Save and sign in' }))

  expect(await screen.findByText('Desktop')).toBeInTheDocument()
  expect(auth.updatePassword).toHaveBeenCalledWith('a brand new pw')
})

test('an expired reset link says so, in not-yet', async () => {
  window.location.hash = '#error=access_denied&error_code=otp_expired'
  screens('/reset-password')

  const message = await screen.findByText(/expired or has already been used/)
  expect(message.className).toContain('not-yet')
  expect(screen.queryByLabelText('New password')).not.toBeInTheDocument()
})

// --- the callback ------------------------------------------------------------------------

test('a refusal from the API is not-yet, and signs the person out of Supabase', async () => {
  auth.token = 'token'
  auth.signOut.mockResolvedValue(undefined)
  server.use(
    http.post('/api/auth/teacher/session', () =>
      HttpResponse.json({ detail: 'This email hasn’t been invited yet.' }, { status: 403 }),
    ),
  )
  screens('/auth/callback')

  const message = await screen.findByText('This email hasn’t been invited yet.')
  expect(message.className).toContain('not-yet')
  await waitFor(() => expect(auth.signOut).toHaveBeenCalled())
})

// --- the Teachers page ----------------------------------------------------------------------

const LISTING: Schemas['TeachersOut'] = {
  teachers: [
    { id: 'u1', email: 'ken@example.com', display_name: 'Ken', role: 'owner', is_you: true },
    { id: 'u2', email: 'sam@school.test', display_name: 'Sam Lee', role: 'teacher', is_you: false },
  ],
  invites: [{ id: 'i1', email: 'kim@school.test', created_at: '2026-10-10T00:00:00Z' }],
}

test('the owner sees teachers and open invites, and can invite someone', async () => {
  let invited: unknown = null
  server.use(
    http.get('/api/teachers', () => HttpResponse.json(LISTING)),
    http.post('/api/teachers/invites', async ({ request }) => {
      invited = await request.json()
      return HttpResponse.json(
        { id: 'i2', email: 'eve@school.test', created_at: '2026-10-10T00:00:00Z' },
        { status: 201 },
      )
    }),
  )
  const { user } = renderScreen(<Teachers />)

  expect(await screen.findByText('Sam Lee')).toBeInTheDocument()
  expect(screen.getByText('kim@school.test')).toBeInTheDocument()
  expect(screen.getByText('Invited — hasn’t signed up yet')).toBeInTheDocument()
  // You cannot remove yourself, so there is exactly one Remove: Sam's.
  expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(1)

  await user.type(screen.getByLabelText('Their email'), 'eve@school.test')
  await user.click(screen.getByRole('button', { name: 'Invite' }))
  expect(await screen.findByText(/eve@school.test is invited/)).toBeInTheDocument()
  expect(invited).toEqual({ email: 'eve@school.test' })
})

test('removing a teacher asks first, in words', async () => {
  let removed = ''
  server.use(
    http.get('/api/teachers', () => HttpResponse.json(LISTING)),
    http.post('/api/teachers/:id/remove', ({ params }) => {
      removed = String(params.id)
      return new HttpResponse(null, { status: 204 })
    }),
  )
  const { user } = renderScreen(<Teachers />)

  await user.click(await screen.findByRole('button', { name: 'Remove' }))
  expect(screen.getByText('Remove Sam Lee?')).toBeInTheDocument()
  expect(removed).toBe('')
  await user.click(screen.getAllByRole('button', { name: 'Remove' }).at(-1)!)
  await waitFor(() => expect(removed).toBe('u2'))
})

test('a teacher who is not the owner is told so, not shown an error', async () => {
  server.use(
    http.get('/api/teachers', () =>
      HttpResponse.json({ detail: 'Only the centre’s owner can manage teachers.' }, { status: 403 }),
    ),
  )
  renderScreen(<Teachers />)

  const message = await screen.findByText('Only the centre’s owner can manage teachers.')
  expect(message.className).toContain('not-yet')
})
