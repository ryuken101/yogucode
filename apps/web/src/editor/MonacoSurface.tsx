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
}

export default function MonacoSurface({
  value,
  onChange,
  completions = true,
  readOnly = false,
}: CodeSurfaceProps) {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  // Held in a ref so the change listener never needs re-attaching, which would lose the
  // undo stack.
  const notify = useRef(onChange)
  notify.current = onChange

  useEffect(() => {
    if (!host.current) return
    const created = monaco.editor.create(host.current, {
      ...OPTIONS,
      value,
      readOnly,
    })
    created.onDidChangeModelContent(() => notify.current(created.getValue()))
    editor.current = created
    created.focus()

    return () => {
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
    if (current && value !== current.getValue()) current.setValue(value)
  }, [value])

  useEffect(() => {
    editor.current?.updateOptions(completionOptions(completions))
  }, [completions])

  useEffect(() => {
    editor.current?.updateOptions({ readOnly })
  }, [readOnly])

  return <div ref={host} className="h-full w-full" />
}
