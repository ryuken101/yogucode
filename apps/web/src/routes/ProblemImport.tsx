/**
 * Import problems from a YAML file — preview first, then apply.
 *
 * The preview is the dry run the API offers (`apply: false`): it says, per problem,
 * whether it would be created, update its draft, start a new version, or be left alone,
 * and which entries have errors. "Import" is offered only for an error-free file, because
 * the API applies nothing otherwise — half an import is harder to reason about than none.
 *
 * Imported problems arrive as drafts. "Check & publish all" in the bank finishes the job,
 * because publishing needs each solution run in a browser.
 */

import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Badge } from '../components/Badge'
import { Button } from '../components/Button'
import { Card, PageHeader } from '../components/Card'
import { Textarea } from '../components/Field'
import { Notice } from '../components/Notice'
import { api, type Schemas } from '../lib/api'
import { messageFor } from '../lib/errors'
import { keys } from '../lib/queries'

const ACTION: Record<
  Schemas['ImportEntryOut']['action'],
  { label: string; variant: 'active' | 'good' | 'muted' | 'not-yet' }
> = {
  create: { label: 'New', variant: 'active' },
  update_draft: { label: 'Updates its draft', variant: 'active' },
  new_version: { label: 'New version', variant: 'active' },
  unchanged: { label: 'No change', variant: 'muted' },
  error: { label: 'Needs fixing', variant: 'not-yet' },
}

export function ProblemImport() {
  const navigate = useNavigate()
  const client = useQueryClient()
  const [text, setText] = useState('')
  const [report, setReport] = useState<Schemas['ImportReportOut'] | null>(null)
  const [previewedText, setPreviewedText] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<unknown>(null)

  async function send(apply: boolean) {
    setPending(true)
    setError(null)
    try {
      const result = await api.importProblems(text, apply)
      setReport(result)
      setPreviewedText(text)
      if (result.applied) await client.invalidateQueries({ queryKey: keys.allProblems })
    } catch (caught) {
      setError(caught)
    } finally {
      setPending(false)
    }
  }

  const entries = report?.entries ?? []
  const changes = entries.filter((e) => e.action !== 'unchanged' && e.action !== 'error').length
  const canApply =
    report !== null &&
    !report.applied &&
    report.error === null &&
    previewedText === text &&
    entries.every((e) => e.action !== 'error') &&
    changes > 0

  return (
    <>
      <PageHeader title="Import problems" />
      <Card className="mb-6">
        <div className="flex flex-col gap-3">
          <label className="text-sm text-ink">
            <span className="mb-1.5 block font-medium">Choose a .yaml file…</span>
            <input
              type="file"
              accept=".yaml,.yml,text/yaml"
              onChange={async (event) => {
                const file = event.target.files?.[0]
                if (file) setText(await file.text())
              }}
            />
          </label>
          <Textarea
            label="…or paste it here"
            rows={12}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <div className="flex gap-2">
            <Button
              variant="secondary"
              disabled={pending || !text.trim()}
              onClick={() => void send(false)}
            >
              Preview
            </Button>
            <Button variant="primary" disabled={pending || !canApply} onClick={() => void send(true)}>
              Import {changes || ''} problem{changes === 1 ? '' : 's'}
            </Button>
          </div>
          <p className="text-xs text-ink-soft">
            The format is described at the top of <code>seed/starter-problems.yaml</code>.
            Nothing is published by importing.
          </p>
        </div>
      </Card>

      {error ? <Notice tone="system-error">{messageFor(error)}</Notice> : null}
      {report?.error ? <Notice tone="not-yet">{report.error}</Notice> : null}
      {report?.applied ? (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <Notice tone="good">Imported. The problems are drafts until they are checked.</Notice>
          <Button variant="primary" onClick={() => navigate('/problems')}>
            Go to the bank to check and publish
          </Button>
        </div>
      ) : null}
      {/* A re-import of a file already in the bank changes nothing, so Import has nothing
          to do. Say so — a disabled button with no reason reads as a broken page. */}
      {report && !report.applied && !report.error && entries.length > 0 && changes === 0 &&
      entries.every((e) => e.action === 'unchanged') ? (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <Notice tone="info">
            Every problem in this file is already in the bank, unchanged — there is nothing
            new to import.
          </Notice>
          <Button variant="secondary" onClick={() => navigate('/problems')}>
            Go to the bank
          </Button>
        </div>
      ) : null}

      {entries.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {entries.map((entry) => (
            <li key={entry.key} className="rounded-xl bg-paper px-5 py-3 ring-1 ring-ink/10">
              <div className="flex flex-wrap items-center gap-3">
                <Badge variant={ACTION[entry.action].variant}>{ACTION[entry.action].label}</Badge>
                <span className="font-medium text-ink">{entry.title}</span>
                <code className="text-xs text-ink-soft">{entry.key}</code>
              </div>
              {entry.error ? <p className="mt-1 text-sm text-ink">{entry.error}</p> : null}
              {entry.publish_problems.length ? (
                <ul className="mt-1 list-disc pl-5 text-sm text-ink-soft">
                  {entry.publish_problems.map((gap) => (
                    <li key={gap}>{gap}</li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  )
}
