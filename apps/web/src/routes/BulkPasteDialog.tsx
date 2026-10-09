/**
 * Paste a list of names, read back what it will do, then commit.
 *
 * Two requests, not one, because a pasted name is ambiguous evidence: "Bella N" might be
 * a new child, the Bella N who was here last term, or a genuinely different second Bella
 * N. Getting the first wrong quietly breaks the promise that mastery follows a child
 * across terms; getting the third wrong merges two children's records. So the preview
 * writes nothing, and the teacher sees the verdicts before anything happens.
 *
 * Colour follows the palette rule rather than instinct. A mis-paste is not a system
 * error, so nothing here is system-error: rows that will act are `good`, rows needing a
 * decision are `not-yet`.
 */

import { useState } from 'react'
import { Badge } from '../components/Badge'
import { Button } from '../components/Button'
import { Dialog } from '../components/Dialog'
import { Textarea } from '../components/Field'
import { Notice } from '../components/Notice'
import type { Schemas } from '../lib/api'
import { api } from '../lib/api'
import { ApiError, messageFor } from '../lib/errors'
import { useCommitPaste } from '../lib/queries'

type Entry = Schemas['PreviewEntryOut']
type Action = Schemas['PasteAction']

/** What each verdict means to a teacher, and how it should look. */
const VERDICTS: Record<Action, { label: string; tone: 'good' | 'not-yet' | 'muted' }> = {
  create: { label: 'New student', tone: 'good' },
  enrol_existing: { label: 'Already at the centre', tone: 'good' },
  already_enrolled: { label: 'Already in this class', tone: 'muted' },
  ambiguous: { label: 'Which one?', tone: 'not-yet' },
  duplicate_in_paste: { label: 'Listed twice', tone: 'not-yet' },
  invalid: { label: 'Cannot use', tone: 'not-yet' },
}

/** Verdicts the commit will refuse until the teacher resolves them. */
const BLOCKING: Action[] = ['ambiguous', 'duplicate_in_paste', 'invalid']

export function BulkPasteDialog({
  classId,
  open,
  onClose,
}: {
  classId: string
  open: boolean
  onClose: () => void
}) {
  const [names, setNames] = useState('')
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [chosen, setChosen] = useState<Record<number, string>>({})
  const [previewing, setPreviewing] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const commit = useCommitPaste(classId)

  function reset() {
    setNames('')
    setEntries(null)
    setTruncated(false)
    setChosen({})
    setFailure(null)
    commit.reset()
  }

  async function preview() {
    setFailure(null)
    setPreviewing(true)
    try {
      const result = await api.previewPaste(classId, names)
      setEntries(result.entries)
      setTruncated(result.truncated)
    } catch (error) {
      setFailure(messageFor(error))
    } finally {
      setPreviewing(false)
    }
  }

  /** An ambiguous row is resolved once the teacher has picked which child they meant. */
  function unresolved(list: Entry[]): Entry[] {
    return list.filter(
      (entry, index) =>
        BLOCKING.includes(entry.action) &&
        !(entry.action === 'ambiguous' && chosen[index] !== undefined),
    )
  }

  function submit(list: Entry[]) {
    const payload: Schemas['BulkEntryIn'][] = []
    list.forEach((entry, index) => {
      const picked = chosen[index]
      if (picked) {
        payload.push({ student_id: picked, display_name: null })
        return
      }
      if (BLOCKING.includes(entry.action)) return
      payload.push({ display_name: entry.display_name, student_id: null })
    })
    commit.mutate(payload, {
      onSuccess: () => {
        reset()
        onClose()
      },
    })
  }

  const blocked = entries ? unresolved(entries) : []
  const willAdd = entries
    ? entries.length - blocked.length - entries.filter((e) => e.action === 'already_enrolled').length
    : 0

  return (
    <Dialog
      open={open}
      title="Add several students"
      onClose={() => {
        reset()
        onClose()
      }}
      confirm={
        entries
          ? {
              label: commit.isPending ? 'Adding…' : `Add ${willAdd}`,
              onConfirm: () => submit(entries),
              disabled: commit.isPending || blocked.length > 0 || willAdd === 0,
            }
          : { label: previewing ? 'Checking…' : 'Check names', onConfirm: () => void preview(), disabled: previewing || names.trim() === '' }
      }
    >
      {!entries ? (
        <div className="flex flex-col gap-3">
          <Textarea
            label="One name per line"
            rows={10}
            value={names}
            onChange={(event) => setNames(event.target.value)}
            placeholder={'Aiden C\nBella N\nChen W'}
          />
          <p className="text-xs text-muted">
            A first name and a last initial is enough — it is all we store. Nothing is
            added until you have seen what this will do.
          </p>
          {failure ? <Notice tone="system-error">{failure}</Notice> : null}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {truncated ? (
            <Notice tone="not-yet">
              Only the first names in that paste are shown — add the rest separately.
            </Notice>
          ) : null}

          <ul className="flex max-h-80 flex-col gap-1.5 overflow-y-auto">
            {entries.map((entry, index) => {
              const verdict = VERDICTS[entry.action]
              return (
                <li
                  key={`${entry.line}-${index}`}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-cream px-3 py-2"
                >
                  <span className="text-sm text-grape">{entry.display_name || entry.raw}</span>
                  <Badge variant={verdict.tone === 'muted' ? 'muted' : verdict.tone}>
                    {verdict.label}
                  </Badge>
                  {entry.action === 'ambiguous' ? (
                    <select
                      className="w-full rounded-lg bg-surface px-2 py-1 text-sm ring-1 ring-not-yet"
                      value={chosen[index] ?? ''}
                      onChange={(event) =>
                        setChosen((prev) => ({ ...prev, [index]: event.target.value }))
                      }
                    >
                      <option value="">Pick which {entry.display_name}…</option>
                      {entry.candidates.map((candidate) => (
                        <option key={candidate.student_id} value={candidate.student_id}>
                          {candidate.display_name} ({candidate.status})
                        </option>
                      ))}
                    </select>
                  ) : null}
                  {entry.reason && entry.action !== 'ambiguous' ? (
                    <span className="w-full text-xs text-muted">{entry.reason}</span>
                  ) : null}
                </li>
              )
            })}
          </ul>

          {blocked.length > 0 ? (
            <Notice tone="not-yet">
              {blocked.length} row{blocked.length === 1 ? '' : 's'} still need a decision.
              Nothing is added until every row is resolved.
            </Notice>
          ) : null}

          {commit.error ? (
            <Notice tone="not-yet">
              {messageFor(commit.error)}
              {commit.error instanceof ApiError && commit.error.entries
                ? ` (rows ${commit.error.entries.map((e) => e.index + 1).join(', ')})`
                : ''}
            </Notice>
          ) : null}

          <Button variant="quiet" onClick={() => setEntries(null)}>
            Edit the list
          </Button>
        </div>
      )}
    </Dialog>
  )
}
