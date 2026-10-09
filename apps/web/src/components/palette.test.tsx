/**
 * The palette rule, enforced rather than remembered.
 *
 * "Never red for a student's incorrect answer — `not-yet` (lemon) means not yet, `good`
 * (mint) means correct, `system-error` (raspberry) is reserved for system errors, and
 * strawberry, the brand accent, is never a state." It is the single convention in this
 * codebase most likely to be broken by reflex, because every other product on earth
 * colours a wrong answer red. These tests make that break a failing build instead of a nine-year-old
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

test('a "not yet" badge is not-yet and never system-error', () => {
  render(<Badge variant="not-yet">No PIN yet</Badge>)
  const badge = screen.getByText('No PIN yet')
  expect(classesOf(badge)).toContain('not-yet')
  expect(classesOf(badge)).not.toContain('system-error')
})

test('an archived student is muted, not an error', () => {
  render(<Badge variant="muted">Archived</Badge>)
  const badge = screen.getByText('Archived')
  expect(classesOf(badge)).not.toContain('system-error')
  expect(classesOf(badge)).toContain('muted')
})

test('a "not yet" notice is not-yet and never system-error', () => {
  render(<Notice tone="not-yet">Not quite — try again</Notice>)
  const notice = screen.getByText('Not quite — try again')
  expect(classesOf(notice)).toContain('not-yet')
  expect(classesOf(notice)).not.toContain('system-error')
})

test('system-error is reachable only under the name system-error', () => {
  render(<Notice tone="system-error">Could not reach the server</Notice>)
  expect(classesOf(screen.getByText('Could not reach the server'))).toContain('system-error')
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
    expect(classesOf(screen.getByRole('button'))).not.toContain('system-error')
    unmount()
  }
})

test('a field hint is not-yet, because a hint is something you can fix', () => {
  render(<TextInput label="Class name" hint="Give the class a name" />)
  const hint = screen.getByText('Give the class a name')
  expect(classesOf(hint)).toContain('not-yet')
  expect(classesOf(hint)).not.toContain('system-error')
})

test('strawberry is decoration, never a state — pink-red on a wrong answer is still red', () => {
  const variants = ['active', 'muted', 'not-yet', 'good', 'system-error'] as const
  for (const variant of variants) {
    const { unmount } = render(<Badge variant={variant}>{variant}</Badge>)
    expect(classesOf(screen.getByText(variant))).not.toContain('strawberry')
    unmount()
  }
  for (const tone of ['not-yet', 'good', 'system-error', 'info'] as const) {
    const { unmount } = render(<Notice tone={tone}>{tone}</Notice>)
    expect(classesOf(screen.getByText(tone))).not.toContain('strawberry')
    unmount()
  }
  for (const variant of ['primary', 'secondary', 'quiet'] as const) {
    const { unmount } = render(<Button variant={variant}>Go</Button>)
    expect(classesOf(screen.getByRole('button'))).not.toContain('strawberry')
    unmount()
  }
})

test('an input is labelled, so a teacher can find it by name', () => {
  render(<TextInput label="Class name" />)
  expect(screen.getByLabelText('Class name')).toBeInTheDocument()
})
