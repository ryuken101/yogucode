import { expect, test } from 'vitest'
import { insertCodeBlock } from './promptCode'

const BLOCK = '```python\nprint(1)\n```'

test('into an empty prompt, just the block', () => {
  expect(insertCodeBlock('', 0, 0, 'print(1)')).toBe(BLOCK)
})

test('at the cursor, with blank lines around it', () => {
  const value = 'What prints?And why?'
  expect(insertCodeBlock(value, 12, 12, 'print(1)')).toBe(`What prints?\n\n${BLOCK}\n\nAnd why?`)
})

test('existing blank lines are not doubled', () => {
  expect(insertCodeBlock('Top\n\n\n\nEnd', 5, 5, 'print(1)')).toBe(`Top\n\n${BLOCK}\n\nEnd`)
})

test('a selection is replaced', () => {
  expect(insertCodeBlock('See print(1) here', 4, 12, 'print(1)')).toBe(`See \n\n${BLOCK}\n\n here`)
})

test('indentation stays, and trailing blank lines go', () => {
  expect(insertCodeBlock('', 0, 0, 'if x:\n    y()\n\n')).toBe('```python\nif x:\n    y()\n```')
})

test('code with backticks in it gets a longer fence, so it cannot close itself', () => {
  expect(insertCodeBlock('', 0, 0, 's = "```"')).toBe('````python\ns = "```"\n````')
})
