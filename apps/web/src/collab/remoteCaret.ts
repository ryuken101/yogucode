/**
 * Someone else's cursor, drawn in an editor: the teacher's in the child's editor while
 * they help, the child's in the teacher's. A thin terracotta caret with a name tag —
 * terracotta is the palette's accent, and it is never a colour that means "wrong".
 *
 * Uses only the text model's own decorations API, so like the binding it needs nothing
 * from Monaco at runtime (see `monacoBinding.ts`).
 */

interface DecoratableModel {
  getPositionAt(offset: number): { lineNumber: number; column: number }
  getValueLength(): number
  deltaDecorations(
    old: string[],
    next: {
      range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }
      options: { beforeContentClassName?: string; hoverMessage?: { value: string }; stickiness?: number }
    }[],
  ): string[]
}

export class RemoteCaret {
  private ids: string[] = []
  private readonly model: DecoratableModel
  private readonly label: string

  constructor(model: DecoratableModel, label: string) {
    this.model = model
    this.label = label
  }

  /** Show the caret at `offset`, or hide it with null. */
  show(offset: number | null): void {
    if (offset === null) {
      this.ids = this.model.deltaDecorations(this.ids, [])
      return
    }
    const at = this.model.getPositionAt(Math.min(offset, this.model.getValueLength()))
    this.ids = this.model.deltaDecorations(this.ids, [
      {
        range: { startLineNumber: at.lineNumber, startColumn: at.column, endLineNumber: at.lineNumber, endColumn: at.column },
        options: { beforeContentClassName: 'remote-caret', hoverMessage: { value: this.label } },
      },
    ])
  }

  dispose(): void {
    this.show(null)
  }
}
