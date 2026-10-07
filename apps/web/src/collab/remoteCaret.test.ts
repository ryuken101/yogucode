/** The other person's caret: drawn at an offset, moved, clamped, and cleared. */

import { expect, test } from 'vitest'
import { RemoteCaret } from './remoteCaret'

function model(text: string) {
  let next = 0
  const live = new Map<string, { startLineNumber: number; startColumn: number }>()
  return {
    live,
    getValueLength: () => text.length,
    getPositionAt(offset: number) {
      const before = text.slice(0, offset).split('\n')
      return { lineNumber: before.length, column: before[before.length - 1]!.length + 1 }
    },
    deltaDecorations(old: string[], decorations: { range: { startLineNumber: number; startColumn: number } }[]) {
      old.forEach((id) => live.delete(id))
      return decorations.map((d) => {
        const id = String(next++)
        live.set(id, d.range)
        return id
      })
    },
  }
}

test('the caret is drawn where the other person is, and moves with them', () => {
  const m = model('ab\ncd\n')
  const caret = new RemoteCaret(m, 'Your teacher')
  caret.show(4)
  expect([...m.live.values()]).toEqual([expect.objectContaining({ startLineNumber: 2, startColumn: 2 })])
  caret.show(1)
  expect([...m.live.values()]).toEqual([expect.objectContaining({ startLineNumber: 1, startColumn: 2 })])
})

test('an offset past the end is clamped, and null clears it', () => {
  const m = model('ab')
  const caret = new RemoteCaret(m, 'Aria')
  caret.show(99)
  expect([...m.live.values()]).toEqual([expect.objectContaining({ startColumn: 3 })])
  caret.show(null)
  expect(m.live.size).toBe(0)
})
