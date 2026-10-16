/**
 * The Monaco editor, wrapped so nothing outside this folder knows it is Monaco.
 *
 * This module is **only ever reached through `React.lazy`** (see `CodeSurface`), because
 * Monaco is around a megabyte and `/join`, the class list and the roster need none of it.
 * On BYOD over centre wifi with twelve children arriving at once, those pages staying
 * light matters more than the editor loading a moment sooner.
 *
 * The workers are bundled by Vite as same-origin files, which also means they satisfy the
 * `require-corp` header the Python runtime needs set — a CDN-hosted Monaco would not.
 */

import { useEffect, useRef } from 'react'
// `editor.api` plus one grammar, rather than the package root: the root is `editor.main`,
// which registers every language Monaco ships and drags in TypeScript, CSS, HTML and JSON
// language workers — about 9 MB of build output for a product that teaches Python.
// See monaco-subpaths.d.ts for why these paths look the way they do.
import * as monaco from 'monaco-editor/editor/editor.api'
import 'monaco-editor/languages/definitions/python/register'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import { OPTIONS, completionOptions, defineTheme } from './theme'

// Python has no language service here — no Pyright, no type checking — so the plain
// editor worker is the only one needed.
self.MonacoEnvironment = { getWorker: () => new EditorWorker() }

defineTheme(monaco)

export interface CodeSurfaceProps {
  value: string
  onChange: (value: string) => void
  /** product-spec §3.1: on for classwork, off for quiz mode in Phase 7. */
  completions?: boolean
  readOnly?: boolean
  /**
   * Take the cursor on mount. Right for a child's one editor; wrong on a page of several
   * (the teacher's problem editor), where each would steal focus from the last.
   */
  autoFocus?: boolean
  /**
   * Each change a person made, as a diff — what the event recorder stores (step 7).
   * Never called for text the page itself put in (`value` changing), only for typing,
   * pasting, undo and the like.
   */
  onEdit?: (changes: EditChange[]) => void
  /** A paste, by length. Large pastes are worth knowing about in a child's process. */
  onPaste?: (chars: number) => void
  /**
   * The editor's text model, once, after it is created — for the live classroom's Yjs
   * binding (`src/collab`). Return a cleanup; it runs when the editor goes.
   */
  onModel?: (model: monaco.editor.ITextModel) => (() => void) | undefined
  /** The cursor moved — its offset in the text. For showing it to the other person. */
  onCursor?: (offset: number) => void
  /**
   * Text size in pixels. The default is the editor's normal 15px; a teacher presenting on
   * the projector (My code's Present mode) turns it up for the back row.
   */
  fontSize?: number
  /** Python colours for a `.py` file; none for anything else (`lib/fileType.ts`). */
  language?: 'python' | 'plaintext'
  /** ⌘/Ctrl+S in the editor — Save, rather than the browser's "Save page". */
  onSave?: () => void
}

export interface EditChange {
  offset: number
  length: number
  text: string
}

export default function MonacoSurface({
  value,
  onChange,
  completions = true,
  readOnly = false,
  autoFocus = true,
  onEdit,
  onPaste,
  onModel,
  onCursor,
  fontSize,
  language = 'python',
  onSave,
}: CodeSurfaceProps) {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  // Held in a ref so the change listener never needs re-attaching, which would lose the
  // undo stack.
  const notify = useRef(onChange)
  notify.current = onChange
  const notifyEdit = useRef(onEdit)
  notifyEdit.current = onEdit
  const notifyPaste = useRef(onPaste)
  notifyPaste.current = onPaste
  const notifyCursor = useRef(onCursor)
  notifyCursor.current = onCursor
  const notifySave = useRef(onSave)
  notifySave.current = onSave
  /** True while the page, not the person, is replacing the text. */
  const applying = useRef(false)

  useEffect(() => {
    if (!host.current) return
    const created = monaco.editor.create(host.current, {
      ...OPTIONS,
      value,
      readOnly,
    })
    created.onDidChangeModelContent((event) => {
      notify.current(created.getValue())
      if (applying.current) return
      notifyEdit.current?.(
        event.changes.map((c) => ({ offset: c.rangeOffset, length: c.rangeLength, text: c.text })),
      )
    })
    created.onDidPaste((event) => {
      const chars = created.getModel()?.getValueLengthInRange(event.range) ?? 0
      notifyPaste.current?.(chars)
    })
    // An action, not `addCommand`: commands are shared by every editor on the page, so the
    // last one mounted would answer for all of them.
    created.addAction({
      id: 'yogucode.save',
      label: 'Save',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => notifySave.current?.(),
    })
    editor.current = created
    if (autoFocus) created.focus()
    created.onDidChangeCursorPosition((event) => {
      const current = created.getModel()
      if (current) notifyCursor.current?.(current.getOffsetAt(event.position))
    })
    const model = created.getModel()
    const unbind = model && onModel ? onModel(model) : undefined

    return () => {
      unbind?.()
      created.getModel()?.dispose()
      created.dispose()
      editor.current = null
    }
    // Deliberately mounted once: `value` is the initial document, and pushing every
    // keystroke back in would fight the editor for cursor position.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Switching file, or restoring saved work — replace the text without remounting, so the
  // editor keeps its layout and the child keeps their scroll position where possible.
  useEffect(() => {
    const current = editor.current
    if (current && value !== current.getValue()) {
      applying.current = true
      current.setValue(value)
      applying.current = false
    }
  }, [value])

  useEffect(() => {
    editor.current?.updateOptions(completionOptions(completions))
  }, [completions])

  useEffect(() => {
    editor.current?.updateOptions({ readOnly })
  }, [readOnly])

  useEffect(() => {
    const model = editor.current?.getModel()
    if (model) monaco.editor.setModelLanguage(model, language)
  }, [language])

  useEffect(() => {
    if (fontSize === undefined) return
    editor.current?.updateOptions({ fontSize, lineHeight: Math.round(fontSize * 1.6) })
  }, [fontSize])

  return <div ref={host} className="h-full w-full" />
}
