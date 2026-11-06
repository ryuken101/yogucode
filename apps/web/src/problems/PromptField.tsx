/**
 * A prompt the teacher writes in markdown, with Edit / Preview — the problem's own and each
 * part's (17 Oct 2026: parts had no preview). Read-only shows it rendered.
 *
 * Add code (Ken, 7 Nov 2026) puts a block of Python in at the cursor, as an ordinary markdown
 * fence, so a question can show code without anyone knowing how to write one.
 */

import { useRef, useState } from 'react'
import { Button } from '../components/Button'
import { Dialog } from '../components/Dialog'
import { Textarea } from '../components/Field'
import { Markdown } from '../components/Markdown'
import { CodeSurface } from '../editor/CodeSurface'
import { insertCodeBlock } from './promptCode'

interface Props {
  /** What the field is called, above it. */
  name: string
  /** The textarea's label while editing. */
  label: string
  value: string
  onChange: (value: string) => void
  editable: boolean
  rows?: number
}

export function PromptField({ name, label, value, onChange, editable, rows = 6 }: Props) {
  const [preview, setPreview] = useState(false)
  const box = useRef<HTMLTextAreaElement>(null)
  // Where the code will go, kept from when the dialog opened: the box loses focus to it.
  const [adding, setAdding] = useState<{ start: number; end: number; code: string } | null>(null)

  function openAdd() {
    const start = box.current?.selectionStart ?? value.length
    const end = box.current?.selectionEnd ?? value.length
    setAdding({ start, end, code: value.slice(start, end) })
  }

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-sm font-medium text-grape">{name}</span>
        {editable ? (
          <span className="flex gap-1">
            <Button variant="quiet" onClick={openAdd}>
              Add code
            </Button>
            <Button variant="quiet" onClick={() => setPreview(!preview)}>
              {preview ? 'Edit' : 'Preview'}
            </Button>
          </span>
        ) : null}
      </div>
      {preview || !editable ? (
        <div className="rounded-lg bg-cream/60 px-4 py-2 ring-1 ring-line">
          <Markdown>{value || '*No prompt yet.*'}</Markdown>
        </div>
      ) : (
        <Textarea
          ref={box}
          label={label}
          rows={rows}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {adding ? (
        <Dialog
          open
          wide
          title="Add code"
          onClose={() => setAdding(null)}
          confirm={{
            label: 'Add code',
            disabled: adding.code.trim() === '',
            onConfirm: () => {
              onChange(insertCodeBlock(value, adding.start, adding.end, adding.code))
              setAdding(null)
              setPreview(false)
            },
          }}
        >
          <p className="mb-3 text-muted">Students will see this with colours and line numbers. They can’t run it.</p>
          <div className="h-64 overflow-hidden rounded-lg ring-1 ring-grape/25">
            <CodeSurface
              value={adding.code}
              completions={false}
              onChange={(code) => setAdding((now) => (now ? { ...now, code } : now))}
            />
          </div>
        </Dialog>
      ) : null}
    </div>
  )
}
