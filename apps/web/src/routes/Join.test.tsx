/**
 * The join flow — the one screen a nine-year-old uses unaided.
 *
 * The colour assertions here are not decoration. product-spec §8: "never red for a
 * student's incorrect answer." Every other product colours a wrong password red, so this
 * is the convention most likely to be broken by reflex, and a test is the only thing that
 * will notice.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test } from 'vitest'
import { Join } from './Join'
import { ARIA_PIN, CODE, lockedOut, server, unreachable } from '../test/server'

function renderJoin() {
  return { user: userEvent.setup(), ...render(<Join />) }
}

async function reachThePinStep(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Class code'), CODE)
  await user.click(screen.getByRole('button', { name: 'Next' }))
  await user.click(await screen.findByRole('button', { name: /Aria K/ }))
}

test('a child signs in with a code, a name and a PIN', async () => {
  const { user } = renderJoin()

  await user.type(screen.getByLabelText('Class code'), CODE.toLowerCase())
  await user.click(screen.getByRole('button', { name: 'Next' }))

  expect(await screen.findByText('Who are you?')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: /Aria K/ }))

  await user.type(screen.getByLabelText('Your 4-digit PIN'), ARIA_PIN)
  await user.click(screen.getByRole('button', { name: 'Start' }))

  expect(await screen.findByText(/You’re in, Aria K/)).toBeInTheDocument()
})

test('the class code never reaches the URL', async () => {
  const { user } = renderJoin()
  await user.type(screen.getByLabelText('Class code'), CODE)
  await user.click(screen.getByRole('button', { name: 'Next' }))
  await screen.findByText('Who are you?')

  // A code in the address bar lands in history on a shared laptop, and in the Referer
  // of whatever loads next. That is why the API takes it in a POST body.
  expect(window.location.search).toBe('')
  expect(window.location.href).not.toContain(CODE)
})

test('a wrong PIN is amber and never rust', async () => {
  const { user } = renderJoin()
  await reachThePinStep(user)

  await user.type(screen.getByLabelText('Your 4-digit PIN'), '1111')
  await user.click(screen.getByRole('button', { name: 'Start' }))

  const message = await screen.findByText(/try again/i)
  expect(message.className).toContain('amber')
  expect(message.className).not.toContain('rust')
  expect(document.body.innerHTML).not.toContain('rust')
})

test('a wrong PIN clears the box so the next try starts clean', async () => {
  const { user } = renderJoin()
  await reachThePinStep(user)

  await user.type(screen.getByLabelText('Your 4-digit PIN'), '1111')
  await user.click(screen.getByRole('button', { name: 'Start' }))
  await screen.findByText(/try again/i)

  expect(screen.getByLabelText('Your 4-digit PIN')).toHaveValue('')
})

test('a lockout is amber too, and tells the child what to do', async () => {
  server.use(lockedOut())
  const { user } = renderJoin()
  await reachThePinStep(user)

  await user.type(screen.getByLabelText('Your 4-digit PIN'), '1111')
  await user.click(screen.getByRole('button', { name: 'Start' }))

  const message = await screen.findByText(/ask your teacher/i)
  expect(message.className).toContain('amber')
  expect(document.body.innerHTML).not.toContain('rust')
})

test('a child with no PIN yet is listed but not selectable', async () => {
  const { user } = renderJoin()
  await user.type(screen.getByLabelText('Class code'), CODE)
  await user.click(screen.getByRole('button', { name: 'Next' }))

  const bella = await screen.findByRole('button', { name: /Bella N/ })
  expect(bella).toBeDisabled()
  expect(screen.getByText(/hasn’t set your PIN yet/)).toBeInTheDocument()
})

test('a wrong code is something to fix, not a system error', async () => {
  const { user } = renderJoin()
  await user.type(screen.getByLabelText('Class code'), 'ZZZZZZ')
  await user.click(screen.getByRole('button', { name: 'Next' }))

  const message = await screen.findByText(/couldn’t find that code/i)
  expect(message.className).toContain('amber')
  expect(message.className).not.toContain('rust')
})

test('an unreachable server is the one case that shows rust', async () => {
  server.use(unreachable())
  const { user } = renderJoin()
  await user.type(screen.getByLabelText('Class code'), CODE)
  await user.click(screen.getByRole('button', { name: 'Next' }))

  const message = await screen.findByRole('alert')
  expect(message.className).toContain('rust')
  expect(message.textContent).toMatch(/could not reach the server/i)
})
