import { expect, test } from 'vitest'
import { tokenizePython, tokenLines, type TokenKind } from './pythonTokens'

const kindOf = (source: string, text: string): TokenKind | undefined =>
  tokenizePython(source).find((t) => t.text.includes(text))?.kind

const SAMPLES = [
  'for i in range(3):\n    print(i)\n',
  '# only a comment',
  'x = "unclosed',
  "s = '''across\nlines'''\nprint(s)",
  'name = f"hi {x}"  # greet\n\n\n  y = 1_000 + 0x1F - .5\t!',
  '€ 🙂 weird = ¬ `tick`',
  '',
  '"""never closed\nstill going',
]

test('joining the tokens always gives back the source exactly', () => {
  for (const source of SAMPLES) {
    expect(tokenizePython(source).map((t) => t.text).join('')).toBe(source)
    expect(tokenLines(source).map((line) => line.map((t) => t.text).join('')).join('\n')).toBe(source)
  }
})

test('words are coloured by what they are', () => {
  const source = 'for i in range(3):\n    print(True, 2.5, "hi", value)  # note'
  expect(kindOf(source, 'for')).toBe('keyword')
  expect(kindOf(source, 'range')).toBe('builtin')
  expect(kindOf(source, 'True')).toBe('constant')
  expect(kindOf(source, '2.5')).toBe('number')
  expect(kindOf(source, '"hi"')).toBe('string')
  expect(kindOf(source, 'value')).toBe('plain')
  expect(kindOf(source, '# note')).toBe('comment')
})

test('a keyword inside a string or comment, or inside a name, is not a keyword', () => {
  expect(tokenizePython('x = "for in if"').filter((t) => t.kind === 'keyword')).toEqual([])
  expect(tokenizePython('# for in if').filter((t) => t.kind === 'keyword')).toEqual([])
  expect(tokenizePython('format_for = information').filter((t) => t.kind === 'keyword')).toEqual([])
})

test('a triple-quoted string holds together across lines', () => {
  const lines = tokenLines('s = """one\nfor two\nthree"""\nfor x in y: pass')
  expect(lines[1]).toEqual([{ kind: 'string', text: 'for two' }])
  expect(lines[3]![0]).toEqual({ kind: 'keyword', text: 'for' })
})
