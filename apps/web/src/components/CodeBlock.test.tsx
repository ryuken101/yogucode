import { render, screen, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { CodeBlock } from './CodeBlock'
import { Markdown } from './Markdown'

test('a number for every line, blank ones too, and the indentation survives', () => {
  const { container } = render(<CodeBlock source={'if x:\n\n    print(x)\n'} />)
  expect(within(screen.getByTestId('line-numbers')).getAllByText(/\d/).map((n) => n.textContent)).toEqual(['1', '2', '3'])
  expect(container.querySelector('code')?.textContent).toBe('if x:\n\n    print(x)')
})

test('a python block in a prompt gets numbers and colours', () => {
  const { container } = render(<Markdown>{'Look:\n\n```python\nprint(1)\n```'}</Markdown>)
  expect(screen.getByTestId('line-numbers')).toHaveTextContent('1')
  expect(screen.getByText('print')).toHaveStyle({ color: '#FF5C8A' })
  expect(container.querySelector('code')?.textContent).toBe('print(1)')
})

test('a block with no language stays plain: that is usually a program’s output', () => {
  render(<Markdown>{'```\n1\n2\n```'}</Markdown>)
  expect(screen.queryByTestId('line-numbers')).not.toBeInTheDocument()
  expect(screen.getByText(/1\s+2/)).toBeInTheDocument()
})

test('HTML in code is shown as text, never put on the page', () => {
  const { container } = render(<Markdown>{'```python\n<img src=x onerror=alert(1)>\n```'}</Markdown>)
  expect(container.querySelector('img')).toBeNull()
  expect(container.querySelector('code')?.textContent).toContain('<img src=x')
})

test('inline code keeps its highlight, and a plain block does not get one', () => {
  const { container } = render(<Markdown>{'Use `print`.\n\n```\n1\n```'}</Markdown>)
  expect(container.querySelector('p code')?.className).toContain('bg-grape-pale')
  expect(container.querySelector('pre')?.className).toContain('[&_code]:bg-transparent')
})
