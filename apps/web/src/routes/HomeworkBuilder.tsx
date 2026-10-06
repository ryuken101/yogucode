/**
 * Write or edit one homework for one class: title, problems, due date and time, hints.
 *
 * A draft until **Set homework**, which makes it appear for the class at once (no
 * scheduling, by Ken's decision). After that the problems are fixed — children have
 * started on them — but the title, due date and hints can still change.
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
import { formatDue, fromLocalInput, toLocalInput } from '../lib/dates'
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
      newerVersionId: null,
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
    const fixed = existing.data && existing.data.status !== 'draft'
    return api.updateHomework(
      assignmentId,
      fixed ? body : { ...body, item_ids: d.rows.map((r) => r.id) },
    )
  })
  const setIt = useHomeworkMutation(classId, (id: string) => api.setHomework(id))

  if (assignmentId && existing.isPending) return <Spinner label="Loading homework" />
  if (existing.error) return <Notice tone="system-error">{messageFor(existing.error)}</Notice>
  if (!draft) return null

  const status = existing.data?.status ?? 'draft'
  const fixed = status !== 'draft'
  const update = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch })
  const back = () => navigate(`/classes/${classId}`)
  const ready = draft.title.trim() && draft.rows.length > 0 && draft.due

  async function saveDraft() {
    const saved = await save.mutateAsync(draft!)
    setDraft(null)
    if (!assignmentId) navigate(`/classes/${classId}/homework/${saved.id}`, { replace: true })
  }

  async function saveAndSet() {
    const saved = await save.mutateAsync(draft!)
    await setIt.mutateAsync(saved.id)
    back()
  }

  const error = save.error ?? setIt.error

  return (
    <>
      <PageHeader title={assignmentId ? 'Homework' : 'New homework'}>
        {klass.data ? <span className="text-sm text-ink-soft">{klass.data.name}</span> : null}
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
            hint={draft.due ? null : 'Choose a day and time'}
          />
        </div>
        <label className="mt-4 flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={draft.hints}
            onChange={(e) => update({ hints: e.target.checked })}
          />
          Hints available (unlocked after a few runs or minutes, as in class)
        </label>
        {draft.due ? (
          <p className="mt-2 text-sm text-ink-soft">
            Students will see: due {formatDue(fromLocalInput(draft.due))}
          </p>
        ) : null}
      </Card>

      <Card className="mb-6">
        <h2 className="mb-3 font-serif text-lg text-ink">Problems</h2>
        {fixed ? (
          <p className="mb-3 text-sm text-ink-soft">
            The problems are fixed now that students have this homework.
          </p>
        ) : null}
        <ProblemListEditor
          rows={draft.rows}
          onChange={(rows) => update({ rows })}
          disabled={fixed}
          empty="No problems yet. Two or three is plenty for a week."
        />
      </Card>

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
          disabled={save.isPending || !draft.title.trim() || edited === null}
          onClick={() => void saveDraft()}
        >
          {fixed ? 'Save changes' : 'Save draft'}
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
