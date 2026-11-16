/**
 * Write or edit one homework for one class: title, problems, due date and time, hints.
 *
 * A draft until **Set homework**, which makes it appear for the class at once (no
 * scheduling, by Ken's decision). After that everything can still change, problems too
 * (Ken, 16 Nov 2026). A change to the problems of a set homework is confirmed first,
 * since children see it at once. Removed work is kept and comes back if the problem is
 * added again. Children who handed in are asked to hand in again.
 */

import { useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { Badge } from '../components/Badge'
import { Button } from '../components/Button'
import { Card, PageHeader } from '../components/Card'
import { TextInput } from '../components/Field'
import { Notice } from '../components/Notice'
import { Spinner } from '../components/Spinner'
import { api, type Schemas } from '../lib/api'
import { formatDue, fromLocalInput, isPast, toLocalInput } from '../lib/dates'
import { messageFor } from '../lib/errors'
import { useClass, useHomework, useHomeworkMutation } from '../lib/queries'
import { ProblemListEditor, type ProblemRow } from '../problems/ProblemListEditor'

interface Draft {
  title: string
  rows: ProblemRow[]
  due: string
  hints: boolean
}

function fromHomework(homework: Schemas['HomeworkOut']): Draft {
  return {
    title: homework.title,
    rows: homework.problems.map((p) => ({
      id: p.id,
      title: p.title,
      difficulty: p.difficulty,
      newerVersionId: p.newer_version_id ?? null,
      superseded: p.status !== 'published',
    })),
    due: toLocalInput(homework.due_at),
    hints: homework.hints,
  }
}

export function HomeworkBuilder() {
  const { classId = '', assignmentId } = useParams()
  const navigate = useNavigate()
  const klass = useClass(classId)
  const existing = useHomework(assignmentId ?? null)
  const [edited, setDraft] = useState<Draft | null>(null)
  const [confirming, setConfirming] = useState(false)
  const draft: Draft | null =
    edited ?? (existing.data ? fromHomework(existing.data) : assignmentId ? null : {
      title: '',
      rows: [],
      due: '',
      hints: true,
    })

  const save = useHomeworkMutation(classId, async (d: Draft) => {
    const body = {
      title: d.title.trim(),
      due_at: fromLocalInput(d.due),
      hints: d.hints,
    }
    if (!assignmentId) {
      return api.createHomework(classId, { ...body, item_ids: d.rows.map((r) => r.id) })
    }
    return api.updateHomework(assignmentId, { ...body, item_ids: d.rows.map((r) => r.id) })
  })
  const setIt = useHomeworkMutation(classId, (id: string) => api.setHomework(id))

  if (assignmentId && existing.isPending) return <Spinner label="Loading homework" />
  if (existing.error) return <Notice tone="system-error">{messageFor(existing.error)}</Notice>
  if (!draft) return null

  const status = existing.data?.status ?? 'draft'
  const isSet = status !== 'draft'
  const before = existing.data?.problems.map((p) => p.id) ?? []
  const after = draft.rows.map((r) => r.id)
  const added = after.filter((id) => !before.includes(id))
  const removed = before.filter((id) => !after.includes(id))
  const problemsChanged = before.join() !== after.join()
  const update = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch })
  const back = () => navigate(`/classes/${classId}`)
  // A due date being chosen must be in the future; one already set may fall due (the
  // server's rule too, 23 Oct 2026).
  const dueChanged = !existing.data || toLocalInput(existing.data.due_at) !== draft.due
  const pastDue = Boolean(draft.due) && dueChanged && isPast(fromLocalInput(draft.due))
  const ready = draft.title.trim() && draft.rows.length > 0 && draft.due && !pastDue

  async function saveDraft() {
    if (isSet && problemsChanged && !confirming) {
      setConfirming(true)
      return
    }
    setConfirming(false)
    const saved = await save.mutateAsync(draft!)
    setDraft(null)
    if (!assignmentId) navigate(`/classes/${classId}/homework/${saved.id}`, { replace: true })
  }

  async function saveAndSet() {
    const saved = await save.mutateAsync(draft!)
    await setIt.mutateAsync(saved.id)
    // Stay with the class's work, and say it happened (23 Oct 2026).
    navigate(`/classes/${classId}/work`, {
      state: { notice: `“${saved.title}” is set — children can see it now.` },
    })
  }

  const error = save.error ?? setIt.error

  return (
    <>
      <PageHeader title={assignmentId ? 'Homework' : 'New homework'}>
        {klass.data ? <span className="text-sm text-muted">{klass.data.name}</span> : null}
        {status === 'draft' ? <Badge variant="active">Draft</Badge> : null}
        {status === 'open' ? <Badge variant="good">Set</Badge> : null}
        {status === 'closed' ? <Badge variant="muted">Closed</Badge> : null}
      </PageHeader>

      <Card className="mb-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextInput
            label="Title"
            value={draft.title}
            maxLength={120}
            placeholder="Lists practice"
            onChange={(e) => update({ title: e.target.value })}
          />
          <TextInput
            label="Due"
            type="datetime-local"
            value={draft.due}
            onChange={(e) => update({ due: e.target.value })}
            hint={
              !draft.due ? 'Choose a day and time' : pastDue ? 'That time has passed. Choose one in the future.' : null
            }
          />
        </div>
        <label className="mt-4 flex items-center gap-2 text-sm text-grape">
          <input
            type="checkbox"
            checked={draft.hints}
            onChange={(e) => update({ hints: e.target.checked })}
          />
          Hints available (unlocked after a few runs or minutes, as in class)
        </label>
        {draft.due ? (
          <p className="mt-2 text-sm text-muted">
            Students will see: due {formatDue(fromLocalInput(draft.due))}
          </p>
        ) : null}
      </Card>

      <Card className="mb-6">
        <h2 className="mb-3 font-display font-semibold text-lg text-grape">Problems</h2>
        {isSet ? (
          <p className="mb-3 text-sm text-muted">
            Students already have this homework, so they’ll see any change as soon as you save.
          </p>
        ) : null}
        <ProblemListEditor
          rows={draft.rows}
          onChange={(rows) => {
            setConfirming(false)
            update({ rows })
          }}
          empty="No problems yet. Two or three is plenty for a week."
        />
      </Card>

      {confirming ? (
        <div
          role="status"
          className="mb-4 rounded-2xl bg-grape-pale/40 px-4 py-3 text-sm text-grape ring-1 ring-grape/20"
        >
          <p className="font-medium">Change the problems on a homework students already have?</p>
          <ul className="mt-1 list-disc pl-5">
            <li>Students will see the change straight away.</li>
            {removed.length > 0 ? (
              <li>
                Work on a problem you take off is kept, and comes back if you add the problem
                again.
              </li>
            ) : null}
            {added.length > 0 ? (
              <li>Students who have handed in will be asked to hand in again.</li>
            ) : null}
            {added.length > 0 && existing.data && existing.data.returned > 0 ? (
              <li>
                {existing.data.returned === 1
                  ? '1 student already has their work back and can’t do the new problems.'
                  : `${existing.data.returned} students already have their work back and can’t do the new problems.`}
              </li>
            ) : null}
          </ul>
          <div className="mt-3 flex gap-2">
            <Button variant="primary" disabled={save.isPending} onClick={() => void saveDraft()}>
              Save changes
            </Button>
            <Button variant="quiet" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="mb-4">
          <Notice tone="not-yet">{messageFor(error)}</Notice>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button variant="quiet" onClick={back}>
          Back to the class
        </Button>
        <Button
          variant="secondary"
          disabled={
            save.isPending ||
            !draft.title.trim() ||
            edited === null ||
            confirming ||
            (isSet && draft.rows.length === 0)
          }
          onClick={() => void saveDraft()}
        >
          {isSet ? 'Save changes' : 'Save draft'}
        </Button>
        {status === 'draft' ? (
          <Button
            variant="primary"
            disabled={!ready || save.isPending || setIt.isPending}
            onClick={() => void saveAndSet()}
          >
            Set homework
          </Button>
        ) : null}
      </div>
    </>
  )
}
