/**
 * Write a quiz for one class: its questions (code problems and multiple choice from the
 * bank), how long it runs, and whether children may press Check.
 *
 * A quiz stays a draft until you **Start** it, in class: every child is switched to it at
 * once and the clock runs (one clock for the class — Ken's decision). Starting from here
 * takes you to the live view, where you watch it. While it runs this page offers the same
 * two things, Watch and Stop, and marking only once it has finished.
 */

import { useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { Badge } from '../components/Badge'
import { Button } from '../components/Button'
import { Card, PageHeader } from '../components/Card'
import { TextInput } from '../components/Field'
import { Notice } from '../components/Notice'
import { StartQuizDialog, StopQuizButton } from '../components/QuizControls'
import { Spinner } from '../components/Spinner'
import { api, type Schemas } from '../lib/api'
import { messageFor } from '../lib/errors'
import { useClass, useQuiz, useQuizMutation } from '../lib/queries'
import { ProblemListEditor, type ProblemRow } from '../problems/ProblemListEditor'

interface Draft {
  title: string
  rows: ProblemRow[]
  /** As typed: clearing the field to type a new number must not put anything else there. */
  minutes: string
  checks: boolean
}

const DEFAULT_MINUTES = 20

/** The length a quiz will have, from what is in the field: whole minutes, 1 to 180. */
function minutesFrom(typed: string): number {
  if (typed.trim() === '') return DEFAULT_MINUTES
  return Math.max(1, Math.min(180, Number.parseInt(typed, 10) || 1))
}

function fromQuiz(quiz: Schemas['QuizOut']): Draft {
  return {
    title: quiz.title,
    rows: quiz.questions.map((q) => ({
      id: q.id,
      title: q.title,
      difficulty: q.difficulty,
      newerVersionId: q.newer_version_id,
      superseded: q.superseded,
    })),
    minutes: String(quiz.duration_minutes),
    checks: quiz.checks,
  }
}

export function QuizBuilder() {
  const { classId = '', quizId: routeQuizId } = useParams()
  // Saved but not yet navigated to: a Start refused after the save must not make a second
  // quiz on the next press.
  const [savedId, setSavedId] = useState<string | undefined>(undefined)
  const quizId = routeQuizId ?? savedId
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
        : { title: '', rows: [], minutes: String(DEFAULT_MINUTES), checks: false })

  const save = useQuizMutation(classId, async (d: Draft) => {
    const body = {
      title: d.title.trim(),
      item_ids: d.rows.map((r) => r.id),
      duration_minutes: minutesFrom(d.minutes),
      checks: d.checks,
    }
    return quizId ? api.updateQuiz(quizId, body) : api.createQuiz(classId, body)
  })
  const start = useQuizMutation(classId, (id: string) => api.startQuiz(id))
  const [confirming, setConfirming] = useState(false)

  if (quizId && existing.isPending) return <Spinner label="Loading quiz" />
  if (existing.error) return <Notice tone="system-error">{messageFor(existing.error)}</Notice>
  if (!draft) return null

  const status = existing.data?.status ?? 'draft'
  const locked = status !== 'draft'
  const update = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch })
  const ready = draft.title.trim() && draft.rows.length > 0

  async function saveDraft() {
    try {
      const saved = await save.mutateAsync(draft!)
      setSavedId(saved.id)
      setDraft(null)
      if (!routeQuizId) navigate(`/classes/${classId}/quizzes/${saved.id}`, { replace: true })
    } catch {
      // Shown from `save.error`.
    }
  }

  async function startNow() {
    setConfirming(false)
    try {
      const saved = edited || !quizId ? await save.mutateAsync(draft!) : existing.data!
      setSavedId(saved.id)
      setDraft(null)
      await start.mutateAsync(saved.id)
      navigate(`/classes/${classId}/live`)
    } catch {
      // Shown from `save.error` or `start.error`.
    }
  }

  const error = save.error ?? start.error

  return (
    <>
      <PageHeader title={quizId ? 'Quiz' : 'New quiz'}>
        {klass.data ? <span className="text-sm text-muted">{klass.data.name}</span> : null}
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
            inputMode="numeric"
            maxLength={3}
            value={draft.minutes}
            disabled={locked}
            onChange={(e) => update({ minutes: e.target.value.replace(/\D/g, '') })}
            onBlur={() => update({ minutes: String(minutesFrom(draft.minutes)) })}
          />
        </div>
        <label className="mt-4 flex items-center gap-2 text-sm text-grape">
          <input
            type="checkbox"
            checked={draft.checks}
            disabled={locked}
            onChange={(e) => update({ checks: e.target.checked })}
          />
          Let students press Check (see “N of M passing”) during the quiz
        </label>
        <p className="mt-2 text-sm text-muted">
          During the quiz, autocomplete and hints are off and pastes are flagged on your live
          view. Students can still Run their code.
        </p>
      </Card>

      <Card className="mb-6">
        <h2 className="mb-3 font-display font-semibold text-lg text-grape">Questions</h2>
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
              onClick={() => setConfirming(true)}
            >
              Start the quiz now
            </Button>
          </>
        )}
        {existing.data?.running ? (
          <>
            <Button variant="primary" onClick={() => navigate(`/classes/${classId}/live`)}>
              Watch
            </Button>
            <StopQuizButton quiz={existing.data} />
          </>
        ) : null}
        {status === 'closed' && existing.data ? (
          <Button variant="primary" onClick={() => navigate(`/assignments/${existing.data.id}/mark`)}>
            Mark
          </Button>
        ) : null}
      </div>

      <StartQuizDialog
        open={confirming}
        title={draft.title.trim()}
        minutes={minutesFrom(draft.minutes)}
        busy={save.isPending || start.isPending}
        onClose={() => setConfirming(false)}
        onStart={() => void startNow()}
      />
    </>
  )
}
