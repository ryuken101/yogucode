/**
 * The binding, against a string-backed stand-in for Monaco's text model.
 *
 * Monaco does not run in jsdom, and what is under test is not Monaco: it is that two
 * editors, each bound to its own Y.Doc, end up with the same text when both people type
 * at once — and that an edit arriving from the other side is never mistaken for, or
 * echoed as, a local one.
 */

import { expect, test } from 'vitest'
import * as Y from 'yjs'
import { MonacoYBinding, type BindableModel } from './monacoBinding'

/** Enough of ITextModel for the binding: offsets ↔ positions, edits, change events. */
class FakeModel implements BindableModel {
  value: string
  private listeners: ((e: { changes: { rangeOffset: number; rangeLength: number; text: string }[] }) => void)[] = []

  constructor(value = '') {
    this.value = value
  }

  getValue() {
    return this.value
  }

  getPositionAt(offset: number) {
    const before = this.value.slice(0, offset).split('\n')
    return { lineNumber: before.length, column: before[before.length - 1]!.length + 1 }
  }

  private offsetAt(line: number, column: number) {
    const lines = this.value.split('\n')
    let offset = 0
    for (let i = 0; i < line - 1; i++) offset += lines[i]!.length + 1
    return offset + column - 1
  }

  applyEdits(
    operations: {
      range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }
      text: string
    }[],
  ) {
    const changes = operations.map((op) => {
      const from = this.offsetAt(op.range.startLineNumber, op.range.startColumn)
      const to = this.offsetAt(op.range.endLineNumber, op.range.endColumn)
      return { rangeOffset: from, rangeLength: to - from, text: op.text }
    })
    for (const c of [...changes].sort((a, b) => b.rangeOffset - a.rangeOffset)) {
      this.value = this.value.slice(0, c.rangeOffset) + c.text + this.value.slice(c.rangeOffset + c.rangeLength)
    }
    this.listeners.forEach((l) => l({ changes }))
  }

  /** A person typing: insert `text` at `offset`. */
  type(offset: number, text: string, remove = 0) {
    this.applyEdits([{ range: this.rangeOf(offset, offset + remove), text }])
  }

  private rangeOf(from: number, to: number) {
    const s = this.getPositionAt(from)
    const e = this.getPositionAt(to)
    return { startLineNumber: s.lineNumber, startColumn: s.column, endLineNumber: e.lineNumber, endColumn: e.column }
  }

  onDidChangeContent(listener: (e: { changes: { rangeOffset: number; rangeLength: number; text: string }[] }) => void) {
    this.listeners.push(listener)
    return { dispose: () => (this.listeners = this.listeners.filter((l) => l !== listener)) }
  }
}

/** Two people, two docs, updates exchanged as the server would relay them. */
function pair(initial: string) {
  const childDoc = new Y.Doc()
  childDoc.getText('code').insert(0, initial)
  const teacherDoc = new Y.Doc()
  Y.applyUpdate(teacherDoc, Y.encodeStateAsUpdate(childDoc))

  const outbox: { to: Y.Doc; update: Uint8Array }[] = []
  childDoc.on('update', (u: Uint8Array, origin: unknown) => origin !== 'remote' && outbox.push({ to: teacherDoc, update: u }))
  teacherDoc.on('update', (u: Uint8Array, origin: unknown) => origin !== 'remote' && outbox.push({ to: childDoc, update: u }))
  const deliver = () => {
    while (outbox.length) {
      const { to, update } = outbox.shift()!
      Y.applyUpdate(to, update, 'remote')
    }
  }

  const child = new FakeModel(initial)
  const teacher = new FakeModel()
  const childBinding = new MonacoYBinding(childDoc.getText('code'), child)
  const teacherBinding = new MonacoYBinding(teacherDoc.getText('code'), teacher)
  return { child, teacher, childBinding, teacherBinding, deliver }
}

test('a late joiner starts from the shared text', () => {
  const { teacher } = pair('print(1)\n')
  expect(teacher.getValue()).toBe('print(1)\n')
})

test('typing on one side appears on the other', () => {
  const { child, teacher, deliver } = pair('numbers = [1, 2, 3]\n')
  child.type(20, 'numbers.append(5)\n')
  deliver()
  expect(teacher.getValue()).toBe('numbers = [1, 2, 3]\nnumbers.append(5)\n')
})

test('two people typing at once converge on the same text', () => {
  const { child, teacher, deliver } = pair('a\nb\n')
  child.type(1, 'XX') // child edits line 1
  teacher.type(3, 'YY') // teacher edits line 2, before seeing the child's edit
  child.type(0, '#', 0)
  teacher.type(2, '', 1) // teacher deletes "b"
  deliver()
  expect(child.getValue()).toBe(teacher.getValue())
  expect(child.getValue()).toContain('XX')
  expect(child.getValue()).toContain('YY')
})

test('an edit from the other side is flagged as remote while it is applied', () => {
  const { child, teacher, childBinding, deliver } = pair('x = 1\n')
  const seen: boolean[] = []
  child.onDidChangeContent(() => seen.push(childBinding.applyingRemote))
  child.type(0, 'y = 2\n') // the child's own typing
  teacher.type(0, '# help\n')
  deliver()
  expect(seen).toEqual([false, true])
})

test('nothing echoes: applying a remote edit sends nothing back', () => {
  const { child, teacher, deliver } = pair('')
  child.type(0, 'hi')
  deliver()
  // If the teacher's binding had echoed the remote edit, delivering again would double it.
  deliver()
  expect(teacher.getValue()).toBe('hi')
  expect(child.getValue()).toBe('hi')
})
