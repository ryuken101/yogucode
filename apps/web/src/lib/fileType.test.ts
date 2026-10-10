import { expect, test } from 'vitest'
import { isPythonFile, languageOf } from './fileType'

test('a file is Python only when its name ends in .py, as in VS Code', () => {
  for (const name of ['squares.py', 'Spiral.PY', ' loops.py ']) expect(isPythonFile(name)).toBe(true)
  for (const name of ['notes', 'notes.txt', 'py', 'squares.py.txt', '', null]) {
    expect(isPythonFile(name)).toBe(false)
  }
  expect(languageOf('a.py')).toBe('python')
  expect(languageOf('a')).toBe('plaintext')
})
