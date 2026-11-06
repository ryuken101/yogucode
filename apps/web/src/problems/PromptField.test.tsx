import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { expect, test, vi } from 'vitest'
import { PromptField } from './PromptField'
import { McqEditor } from './McqEditor'

// A plain box stands in for Monaco, which needs a real browser; the page tests never type in it.
vi.mock('../editor/CodeSurface', () => ({
  CodeSurface: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea aria-label="code" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}))

function Field({ initial = '' }: { initial?: string }) {
  const [value, setValue] = useState(initial)
  return (
    <>
      <PromptField name="Prompt" label="Reads" value={value} onChange={setValue} editable />
      <output data-testid="value">{value}</output>
    </>
  )
}

test('Add code puts a block in at the cursor', async () => {
  const user = userEvent.setup()
  render(<Field initial="Before After" />)
  const box = screen.getByLabelText('Reads') as HTMLTextAreaElement
  box.setSelectionRange(7, 7)
  await user.click(screen.getByRole('button', { name: 'Add code' }))
  fireEvent.change(await screen.findByLabelText('code', { selector: 'textarea' }), { target: { value: 'print(1)' } })
  const buttons = screen.getAllByRole('button', { name: 'Add code', hidden: true })
  await user.click(buttons[buttons.length - 1]!)
  expect(screen.getByTestId('value').textContent).toBe('Before \n\n```python\nprint(1)\n```\n\nAfter')
})

test('selected text opens in the dialog, and adding replaces it', async () => {
  const user = userEvent.setup()
  render(<Field initial="See x = 1 here" />)
  const box = screen.getByLabelText('Reads') as HTMLTextAreaElement
  box.setSelectionRange(4, 9)
  await user.click(screen.getByRole('button', { name: 'Add code' }))
  expect(await screen.findByLabelText('code', { selector: 'textarea' })).toHaveValue('x = 1')
  const buttons = screen.getAllByRole('button', { name: 'Add code', hidden: true })
  await user.click(buttons[buttons.length - 1]!)
  expect(screen.getByTestId('value').textContent).toBe('See \n\n```python\nx = 1\n```\n\n here')
})

test('empty code cannot be added', async () => {
  const user = userEvent.setup()
  render(<Field />)
  await user.click(screen.getByRole('button', { name: 'Add code' }))
  fireEvent.change(await screen.findByLabelText('code', { selector: 'textarea' }), { target: { value: '   \n' } })
  const buttons = screen.getAllByRole('button', { name: 'Add code', hidden: true })
  expect(buttons[buttons.length - 1]).toBeDisabled()
})

test('an answer can have several lines, with its indentation', async () => {
  const onChange = vi.fn()
  const text = 'for i in x:\n    print(i)'
  render(<McqEditor options={[{ text, correct: true, misconception: null }]} onChange={onChange} />)
  const answer = screen.getByLabelText('Option 1') as HTMLTextAreaElement
  expect(answer.tagName).toBe('TEXTAREA')
  expect(answer.value).toBe(text)
  expect(answer.rows).toBe(2)
  fireEvent.change(answer, { target: { value: `${text}\n    done()` } })
  expect(onChange.mock.calls[0]![0][0].text).toBe(`${text}\n    done()`)
})
