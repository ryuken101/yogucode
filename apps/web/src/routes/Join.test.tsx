/**
 * The sign-in — the one screen a nine-year-old uses unaided. A username and a PIN, from
 * the slip their teacher gave them (Ken's decision, 11 Oct 2026).
 *
 * The colour assertions here are not decoration. The palette rule: "never red for a
 * student's incorrect answer." Every other product colours a wrong password red, so this
 * is the convention most likely to be broken by reflex, and a test is the only thing that
 * will notice.
 */

import { screen } from '@testing-library/react'
import type userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { expect, test } from 'vitest'
import { Join } from './Join'
import { isStudentTab, clearStudentTab } from '../lib/tabSession'
import { renderScreen } from '../test/render'
import { ARIA_PIN, ARIA_USERNAME, lockedOut, server, unreachable } from '../test/server'

// `renderScreen` supplies the router and a query client: Join navigates once a child is in.
function renderJoin() {
  return renderScreen(<Join />)
}

async function signIn(user: ReturnType<typeof userEvent.setup>, username: string, pin: string) {
  await user.type(screen.getByLabelText('Username'), username)
  await user.type(screen.getByLabelText('PIN'), pin)
  await user.click(screen.getByRole('button', { name: 'Sign in' }))
}

test('a child signs in with their username and PIN', async () => {
  clearStudentTab()
  const { user } = renderJoin()
  // Capitals and spaces are forgiven — usernames are case-insensitive.
  await signIn(user, ' Aria.K ', ARIA_PIN)

  expect(await screen.findByText(/You’re in, Aria K/)).toBeInTheDocument()
  expect(isStudentTab()).toBe(true)
})

test('there is no class code and no list of names any more', () => {
  renderJoin()
  expect(screen.queryByLabelText('Class code')).not.toBeInTheDocument()
  expect(screen.queryByText('Who are you?')).not.toBeInTheDocument()
})

test('Sign in waits for a username and all four digits', async () => {
  const { user } = renderJoin()
  const button = screen.getByRole('button', { name: 'Sign in' })
  expect(button).toBeDisabled()
  await user.type(screen.getByLabelText('Username'), ARIA_USERNAME)
  await user.type(screen.getByLabelText('PIN'), '48a')
  expect(screen.getByLabelText('PIN')).toHaveValue('48')
  expect(button).toBeDisabled()
})

test('a wrong PIN is not-yet and never system-error', async () => {
  const { user } = renderJoin()
  await signIn(user, ARIA_USERNAME, '1111')

  const message = await screen.findByText(/try again/i)
  expect(message.className).toContain('not-yet')
  expect(message.className).not.toContain('system-error')
  expect(document.body.innerHTML).not.toContain('system-error')
})

test('a wrong PIN clears the box so the next try starts clean', async () => {
  const { user } = renderJoin()
  await signIn(user, ARIA_USERNAME, '1111')
  await screen.findByText(/try again/i)

  expect(screen.getByLabelText('PIN')).toHaveValue('')
  expect(screen.getByLabelText('Username')).toHaveValue(ARIA_USERNAME)
})

test('a lockout is not-yet too, and tells the child what to do', async () => {
  server.use(lockedOut())
  const { user } = renderJoin()
  await signIn(user, ARIA_USERNAME, '1111')

  const message = await screen.findByText(/ask your teacher/i)
  expect(message.className).toContain('not-yet')
  expect(document.body.innerHTML).not.toContain('system-error')
})

test('a child in no class is told to ask their teacher, calmly', async () => {
  server.use(
    http.post('/api/auth/student/session', () =>
      HttpResponse.json(
        { detail: 'You’re not in a class yet — ask your teacher to add you.' },
        { status: 403 },
      ),
    ),
  )
  const { user } = renderJoin()
  await signIn(user, ARIA_USERNAME, ARIA_PIN)

  const message = await screen.findByText(/not in a class yet/)
  expect(message.className).toContain('not-yet')
})

test('an unreachable server is the one case that shows system-error', async () => {
  server.use(unreachable())
  const { user } = renderJoin()
  await signIn(user, ARIA_USERNAME, ARIA_PIN)

  const message = await screen.findByRole('alert')
  expect(message.className).toContain('system-error')
  expect(message.textContent).toMatch(/could not reach the server/i)
})
