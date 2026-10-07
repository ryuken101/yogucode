/**
 * Keep a Monaco text model and a Yjs `Y.Text` saying the same thing, in both directions.
 *
 * This is what lets a teacher watch a child's code keystroke by keystroke and type into it
 * at the same time as the child: both sides edit their own copy, Yjs (a CRDT) merges the
 * edits, and this binding carries them between the copy and the editor.
 *
 * **Ours rather than `y-monaco`**, because `y-monaco` imports the `monaco-editor` package
 * root, which registers every language Monaco ships and costs about 9 MB (see
 * `apps/web/CLAUDE.md`). This needs only the model's own methods, so it imports nothing
 * from Monaco at runtime — just a structural type — and works with a fake model in tests.
 *
 * Two rules keep it from echoing:
 * - local edits go into Y.Text inside a transaction tagged with this binding, and the
 *   Y.Text observer ignores its own transactions;
 * - remote edits are applied to the model with `applyingRemote` set, and the model
 *   listener ignores them. Callers read `applyingRemote` too — it is how an edit that
 *   arrived from a teacher is told apart from the child's own typing.
 */

import type * as Y from 'yjs'

/** The slice of Monaco's ITextModel this needs. */
export interface BindableModel {
  getValue(): string
  getPositionAt(offset: number): { lineNumber: number; column: number }
  applyEdits(
    operations: {
      range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }
      text: string
    }[],
  ): unknown
  onDidChangeContent(
    listener: (event: { changes: readonly { rangeOffset: number; rangeLength: number; text: string }[] }) => void,
  ): { dispose(): void }
}

export class MonacoYBinding {
  /** True while a remote change is being written into the model. */
  applyingRemote = false
  private readonly text: Y.Text
  private readonly model: BindableModel
  private readonly subscription: { dispose(): void }
  private readonly observer: (event: Y.YTextEvent, transaction: Y.Transaction) => void

  constructor(text: Y.Text, model: BindableModel) {
    this.text = text
    this.model = model

    // Start from whatever the shared text says.
    if (model.getValue() !== text.toString()) {
      this.applyRemote([{ from: 0, to: model.getValue().length, text: text.toString() }])
    }

    this.observer = (event, transaction) => {
      if (transaction.origin === this) return
      const edits: { from: number; to: number; text: string }[] = []
      let index = 0 // position in the model as it was before this change
      for (const op of event.delta) {
        if (op.retain !== undefined) index += op.retain
        else if (op.delete !== undefined) {
          edits.push({ from: index, to: index + op.delete, text: '' })
          index += op.delete
        } else if (typeof op.insert === 'string') {
          edits.push({ from: index, to: index, text: op.insert })
        }
      }
      if (edits.length) this.applyRemote(edits)
    }
    text.observe(this.observer)

    this.subscription = model.onDidChangeContent((event) => {
      if (this.applyingRemote) return
      const doc = text.doc
      const apply = () => {
        // Each change is relative to the model before the event; apply right to left so
        // an earlier offset is never moved by a later edit.
        const changes = [...event.changes].sort((a, b) => b.rangeOffset - a.rangeOffset)
        for (const change of changes) {
          if (change.rangeLength) text.delete(change.rangeOffset, change.rangeLength)
          if (change.text) text.insert(change.rangeOffset, change.text)
        }
      }
      if (doc) doc.transact(apply, this)
      else apply()
    })
  }

  private applyRemote(edits: { from: number; to: number; text: string }[]): void {
    const operations = edits.map((edit) => {
      const start = this.model.getPositionAt(edit.from)
      const end = this.model.getPositionAt(edit.to)
      return {
        range: {
          startLineNumber: start.lineNumber,
          startColumn: start.column,
          endLineNumber: end.lineNumber,
          endColumn: end.column,
        },
        text: edit.text,
      }
    })
    this.applyingRemote = true
    try {
      this.model.applyEdits(operations)
    } finally {
      this.applyingRemote = false
    }
  }

  dispose(): void {
    this.text.unobserve(this.observer)
    this.subscription.dispose()
  }
}
