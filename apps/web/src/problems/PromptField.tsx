/**
 * A prompt the teacher writes in markdown, with Edit / Preview — the problem's own and each
 * part's (17 Oct 2026: parts had no preview). Read-only shows it rendered.
 */

import { useState } from 'react'
import { Button } from '../components/Button'
import { Textarea } from '../components/Field'
import { Markdown } from '../components/Markdown'

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
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-sm font-medium text-grape">{name}</span>
        {editable ? (
          <Button variant="quiet" onClick={() => setPreview(!preview)}>
            {preview ? 'Edit' : 'Preview'}
          </Button>
        ) : null}
      </div>
      {preview || !editable ? (
        <div className="rounded-lg bg-cream/60 px-4 py-2 ring-1 ring-line">
          <Markdown>{value || '*No prompt yet.*'}</Markdown>
        </div>
      ) : (
        <Textarea
          label={label}
          rows={rows}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </div>
  )
}
