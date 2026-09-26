/**
 * The §8 colour rule, enforced rather than remembered.
 *
 * "Never red for a student's incorrect answer — amber means not yet, sage means correct,
 * rust is reserved for system errors." It is the single convention in this codebase most
 * likely to be broken by reflex, because every other product on earth colours a wrong
 * answer red. These tests make that break a failing build instead of a nine-year-old
 * being told in red that they are wrong.
 */

import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import { Badge } from './Badge'
import { Notice } from './Notice'
import { Button } from './Button'
import { TextInput } from './Field'

function classesOf(element: HTMLElement): string {
  return element.className
}

test('a "not yet" badge is amber and never rust', () => {
  render(<Badge variant="not-yet">No PIN yet</Badge>)
  const badge = screen.getByText('No PIN yet')
  expect(classesOf(badge)).toContain('amber')
  expect(classesOf(badge)).not.toContain('rust')
})

test('an archived student is muted, not an error', () => {
  render(<Badge variant="muted">Archived</Badge>)
  const badge = screen.getByText('Archived')
  expect(classesOf(badge)).not.toContain('rust')
  expect(classesOf(badge)).toContain('ink-soft')
})

test('a "not yet" notice is amber and never rust', () => {
  render(<Notice tone="not-yet">Not quite — try again</Notice>)
  const notice = screen.getByText('Not quite — try again')
  expect(classesOf(notice)).toContain('amber')
  expect(classesOf(notice)).not.toContain('rust')
})

test('rust is reachable only under the name system-error', () => {
  render(<Notice tone="system-error">Could not reach the server</Notice>)
  expect(classesOf(screen.getByText('Could not reach the server'))).toContain('rust')
})

test('a system error is announced assertively, a not-yet is not', () => {
  const { unmount } = render(<Notice tone="system-error">Server down</Notice>)
  expect(screen.getByRole('alert')).toBeInTheDocument()
  unmount()
  render(<Notice tone="not-yet">Try again</Notice>)
  expect(screen.getByRole('status')).toBeInTheDocument()
})

test('no button variant renders red, because nothing here deletes', () => {
  for (const variant of ['primary', 'secondary', 'quiet'] as const) {
    const { unmount } = render(<Button variant={variant}>Rotate code</Button>)
    expect(classesOf(screen.getByRole('button'))).not.toContain('rust')
    unmount()
  }
})

test('a field hint is amber, because a hint is something you can fix', () => {
  render(<TextInput label="Class name" hint="Give the class a name" />)
  const hint = screen.getByText('Give the class a name')
  expect(classesOf(hint)).toContain('amber')
  expect(classesOf(hint)).not.toContain('rust')
})

test('an input is labelled, so a teacher can find it by name', () => {
  render(<TextInput label="Class name" />)
  expect(screen.getByLabelText('Class name')).toBeInTheDocument()
})
