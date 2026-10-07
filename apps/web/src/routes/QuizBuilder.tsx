/**
 * Write a quiz for one class: its questions (code problems and multiple choice from the
 * bank), how long it runs, and whether children may press Check.
 *
 * A quiz stays a draft until you **Start** it, in class: every child is switched to it at
 * once and the clock runs (one clock for the class — Ken's decision). Starting from here
 * takes you to the live view, where you watch it and can stop it.
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
import { messageFor } from '../lib/errors'
import { useClass, useQuiz, useQuizMutation } from '../lib/queries'
import { ProblemListEditor, type ProblemRow } from '../problems/ProblemListEditor'

interface Draft {
  title: string
  rows: ProblemRow[]
  minutes: number
  checks: boolean
}

function fromQuiz(quiz: Schemas['QuizOut']): Draft {
  return {
    title: quiz.title,
    rows: quiz.questions.map((q) => ({
      id: q.id,
      title: q.title,
      difficulty: q.difficulty,
      newerVersionId: null,
      superseded: false,
    })),
    minutes: quiz.duration_minutes,
    checks: quiz.checks,
  }
}

export function QuizBuilder() {
  const { classId = '', quizId } = useParams()
  const navigate = useNavigate()
  const klass = useClass(classId)
  const existing = useQuiz(quizId ?? null)
  const [edited, setDraft] = useState<Draft | null>(null)
  const draft: Draft | null =
    edited ??
    (existing.data
      ? fromQuiz(existing.data)
      : quizId
        ? null
        : { title: '', rows: [], minutes: 20, checks: false })

  const save = useQuizMutation(classId, async (d: Draft) => {
    const body = {
      title: d.title.trim(),
      item_ids: d.rows.map((r) => r.id),
      duration_minutes: d.minutes,
      checks: d.checks,
    }
    return quizId ? api.updateQuiz(quizId, body) : api.createQuiz(classId, body)
  })
  const start = useQuizMutation(classId, (id: string) => api.startQuiz(id))

  if (quizId && existing.isPending) return <Spinner label="Loading quiz" />
  if (existing.error) return <Notice tone="system-error">{messageFor(existing.error)}</Notice>
  if (!draft) return null

  const status = existing.data?.status ?? 'draft'
  const locked = status !== 'draft'
  const update = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch })
  const ready = draft.title.trim() && draft.rows.length > 0

  async function saveDraft() {
    const saved = await save.mutateAsync(draft!)
    setDraft(null)
    if (!quizId) navigate(`/classes/${classId}/quizzes/${saved.id}`, { replace: true })
  }

  async function startNow() {
    const saved = edited || !quizId ? await save.mutateAsync(draft!) : existing.data!
    await start.mutateAsync(saved.id)
    navigate(`/classes/${classId}/live`)
  }

  const error = save.error ?? start.error

  return (
    <>
      <PageHeader title={quizId ? 'Quiz' : 'New quiz'}>
        {klass.data ? <span className="text-sm text-ink-soft">{klass.data.name}</span> : null}
        {status === 'draft' ? <Badge variant="active">Draft</Badge> : null}
        {existing.data?.running ? <Badge variant="good">Running</Badge> : null}
        {status === 'closed' ? <Badge variant="muted">Finished</Badge> : null}
      </PageHeader>

      <Card className="mb-6">
        <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
          <TextInput
            label="Title"
            value={draft.title}
            maxLength={120}
            disabled={locked}
            placeholder="Fortnight 3 quiz"
            onChange={(e) => update({ title: e.target.value })}
          />
          <TextInput
            label="Length (minutes)"
            type="number"
            min={1}
            max={180}
            value={draft.minutes}
            disabled={locked}
            onChange={(e) => update({ minutes: Math.max(1, Math.min(180, Number(e.target.value) || 1)) })}
          />
        </div>
        <label className="mt-4 flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={draft.checks}
            disabled={locked}
            onChange={(e) => update({ checks: e.target.checked })}
          />
          Let students press Check (see “N of M passing”) during the quiz
        </label>
        <p className="mt-2 text-sm text-ink-soft">
          During the quiz, autocomplete and hints are off and pastes are flagged on your live
          view. Students can still Run their code.
        </p>
      </Card>

      <Card className="mb-6">
        <h2 className="mb-3 font-serif text-lg text-ink">Questions</h2>
        <ProblemListEditor
          rows={draft.rows}
          onChange={(rows) => update({ rows })}
          disabled={locked}
          limit={20}
          empty="No questions yet. Add code problems and multiple-choice questions from the bank."
        />
      </Card>

      {error ? (
        <div className="mb-4">
          <Notice tone="not-yet">{messageFor(error)}</Notice>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button variant="quiet" onClick={() => navigate(`/classes/${classId}`)}>
          Back to the class
        </Button>
        {locked ? null : (
          <>
            <Button
              variant="secondary"
              disabled={save.isPending || !draft.title.trim() || (quizId !== undefined && edited === null)}
              onClick={() => void saveDraft()}
            >
              Save draft
            </Button>
            <Button
              variant="primary"
              disabled={!ready || save.isPending || start.isPending}
              onClick={() => void startNow()}
            >
              Start the quiz now
            </Button>
          </>
        )}
        {existing.data && existing.data.status !== 'draft' ? (
          <Button variant="primary" onClick={() => navigate(`/assignments/${existing.data.id}/mark`)}>
            Mark
          </Button>
        ) : null}
      </div>
    </>
  )
}
