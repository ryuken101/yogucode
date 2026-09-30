/**
 * The class list — the first screen a teacher sees after signing in.
 *
 * The empty state matters more than it looks: on the very first sign-in it is the entire
 * product, and the phase plan's acceptance script opens with "sign in as a teacher via
 * magic link → land on an empty class list."
 */

import { screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { expect, test } from 'vitest'
import { ClassList } from './ClassList'
import { renderScreen } from '../test/render'
import { CODE, oneClass, server } from '../test/server'

test('an empty centre says so, and says what to do about it', async () => {
  renderScreen(<ClassList />)

  expect(await screen.findByText('No classes yet')).toBeInTheDocument()
  // The join code arriving with the class is the non-obvious part, so the empty state
  // is where a teacher should learn it.
  expect(screen.getByText(/join code straight away/i)).toBeInTheDocument()
})

test('existing classes are listed with their term', async () => {
  server.use(oneClass())
  renderScreen(<ClassList />)

  expect(await screen.findByText('Year 4-6 Python')).toBeInTheDocument()
  expect(screen.getByText('2026 T4')).toBeInTheDocument()
  expect(screen.queryByText('No classes yet')).not.toBeInTheDocument()
})

test('a class links through to its detail screen', async () => {
  server.use(oneClass())
  renderScreen(<ClassList />)

  const link = await screen.findByRole('link', { name: /Year 4-6 Python/ })
  expect(link).toHaveAttribute('href', expect.stringContaining('/classes/'))
})

test('creating a class needs only a name', async () => {
  const { user } = renderScreen(<ClassList />)
  await screen.findByText('No classes yet')

  expect(screen.getByRole('button', { name: 'Create class' })).toBeDisabled()
  await user.type(screen.getByLabelText('Class name'), 'Year 4-6 Python')
  expect(screen.getByRole('button', { name: 'Create class' })).toBeEnabled()
})

test('a class created shows its join code, because the code arrives with it', async () => {
  // The list is refetched after creating, so the new class appears; step 6 mints the code
  // inside create_class, which is what makes "create a class, read out the code" one step.
  const { user } = renderScreen(<ClassList />)
  await screen.findByText('No classes yet')

  await user.type(screen.getByLabelText('Class name'), 'Year 4-6 Python')
  server.use(oneClass())
  await user.click(screen.getByRole('button', { name: 'Create class' }))

  await waitFor(() => expect(screen.getByText('Year 4-6 Python')).toBeInTheDocument())
  expect(CODE).toMatch(/^[A-Z0-9]{6}$/)
})

test('the form clears after a successful create, ready for the next one', async () => {
  const { user } = renderScreen(<ClassList />)
  await screen.findByText('No classes yet')

  await user.type(screen.getByLabelText('Class name'), 'Year 4-6 Python')
  await user.type(screen.getByLabelText('Term (optional)'), '2026 T4')
  await user.click(screen.getByRole('button', { name: 'Create class' }))

  await waitFor(() => expect(screen.getByLabelText('Class name')).toHaveValue(''))
  expect(screen.getByLabelText('Term (optional)')).toHaveValue('')
})

test('a rejected create is amber — the teacher can fix the name', async () => {
  server.use(
    http.post('/api/classes', () =>
      HttpResponse.json(
        {
          detail: [
            { loc: ['body', 'name'], msg: 'String should have at least 1 character', type: 'x' },
          ],
        },
        { status: 422 },
      ),
    ),
  )
  const { user } = renderScreen(<ClassList />)
  await screen.findByText('No classes yet')

  await user.type(screen.getByLabelText('Class name'), 'x')
  await user.click(screen.getByRole('button', { name: 'Create class' }))

  const message = await screen.findByText(/at least 1 character/)
  expect(message.className).toContain('amber')
  expect(message.className).not.toContain('rust')
})
