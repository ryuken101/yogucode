/**
 * The Work app for a class (16 Oct 2026): its homework and its quizzes, one tab each
 * (`?tab=quizzes`). These were cards on the class page; the desktop gives them their own
 * window so a teacher can set work beside the problem library.
 */

import { useState } from 'react'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import { Badge } from '../components/Badge'
import { Button } from '../components/Button'
import { Card } from '../components/Card'
import { Notice } from '../components/Notice'
import { Spinner } from '../components/Spinner'
import { TrashDialog } from '../components/TrashDialog'
import { api } from '../lib/api'
import { formatDue } from '../lib/dates'
import { messageFor } from '../lib/errors'
import {
  useClassHomework,
  useClassQuizzes,
  useHomeworkMutation,
  useQuizMutation,
  useTrashAction,
} from '../lib/queries'

export function ClassWork() {
  const { classId = '' } = useParams()
  const [params] = useSearchParams()
  return params.get('tab') === 'quizzes' ? <QuizzesCard classId={classId} /> : <HomeworkCard classId={classId} />
}

/**
 * The class's homework: what is set, when it is due, how many have handed it in and been
 * marked. One line each, with the next thing to do with it — set a draft, mark a set one.
 */
export function HomeworkCard({ classId }: { classId: string }) {
  const navigate = useNavigate()
  const homework = useClassHomework(classId)
  const close = useHomeworkMutation(classId, (id: string) => api.closeHomework(id))
  const reopen = useHomeworkMutation(classId, (id: string) => api.reopenHomework(id))
  // "Set — children can see it now", from the homework page that just set it (23 Oct 2026).
  const notice = (useLocation().state as { notice?: string } | null)?.notice
  const [deleting, setDeleting] = useState<{ id: string; title: string } | null>(null)
  const trash = useTrashAction()

  return (
    <Card className="mb-6">
      {notice ? (
        <div className="mb-3">
          <Notice tone="good">{notice}</Notice>
        </div>
      ) : null}
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-display font-semibold text-lg text-grape">Homework</h2>
        <Button variant="secondary" onClick={() => navigate(`/classes/${classId}/homework/new`)}>
          New homework
        </Button>
      </div>
      {homework.isPending ? <Spinner label="Loading homework" /> : null}
      {homework.data && homework.data.length === 0 ? (
        <p className="text-sm text-muted">None yet.</p>
      ) : null}
      <ul className="flex flex-col gap-2">
        {(homework.data ?? []).map((hw) => (
          <li
            key={hw.id}
            className="flex flex-wrap items-center gap-3 rounded-lg bg-cream/60 px-4 py-2.5 ring-1 ring-line"
          >
            <span className="font-medium text-grape">{hw.title}</span>
            {hw.status === 'draft' ? <Badge variant="active">Draft</Badge> : null}
            {hw.status === 'closed' ? <Badge variant="muted">Closed</Badge> : null}
            <span className="text-sm text-muted">due {formatDue(hw.due_at)}</span>
            {hw.status !== 'draft' ? (
              <span className="text-sm text-muted">
                {hw.handed_in}/{hw.students} handed in · {hw.marked} marked
                {hw.returned ? ` · ${hw.returned} given back` : ''}
              </span>
            ) : null}
            <span className="ml-auto flex gap-1">
              <Button variant="quiet" onClick={() => navigate(`/classes/${classId}/homework/${hw.id}`)}>
                {hw.status === 'draft' ? 'Edit' : 'Details'}
              </Button>
              {hw.status !== 'draft' ? (
                <Button variant="primary" onClick={() => navigate(`/assignments/${hw.id}/mark`)}>
                  Mark
                </Button>
              ) : null}
              {hw.status === 'open' ? (
                <Button variant="quiet" onClick={() => close.mutate(hw.id)}>
                  Close
                </Button>
              ) : null}
              {hw.status === 'closed' ? (
                <Button variant="quiet" onClick={() => reopen.mutate(hw.id)}>
                  Reopen
                </Button>
              ) : null}
              <Button variant="quiet" onClick={() => setDeleting({ id: hw.id, title: hw.title })}>
                Delete
              </Button>
            </span>
          </li>
        ))}
      </ul>
      {homework.error ? <Notice tone="system-error">{messageFor(homework.error)}</Notice> : null}
      <TrashDialog
        open={deleting !== null}
        name={deleting ? `“${deleting.title}”` : ''}
        note="Children’s answers and marks on it go with it, and come back if you restore it."
        busy={trash.isPending}
        error={trash.error ? messageFor(trash.error) : null}
        onClose={() => {
          trash.reset()
          setDeleting(null)
        }}
        onConfirm={() =>
          deleting &&
          trash.mutate(
            { action: 'trash', kind: 'homework', id: deleting.id },
            { onSuccess: () => setDeleting(null) },
          )
        }
      />
    </Card>
  )
}

/**
 * The class's quizzes. A draft is started from here or from its own page; starting one
 * switches every child to it and opens the live view, where it is watched and stopped.
 */
export function QuizzesCard({ classId }: { classId: string }) {
  const navigate = useNavigate()
  const quizzes = useClassQuizzes(classId)
  const start = useQuizMutation(classId, (id: string) => api.startQuiz(id))
  const running = (quizzes.data ?? []).some((q) => q.running)
  const [deleting, setDeleting] = useState<{ id: string; title: string } | null>(null)
  const trash = useTrashAction()

  return (
    <Card className="mb-6">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-display font-semibold text-lg text-grape">Quizzes</h2>
        <Button variant="secondary" onClick={() => navigate(`/classes/${classId}/quizzes/new`)}>
          New quiz
        </Button>
      </div>
      {quizzes.data && quizzes.data.length === 0 ? <p className="text-sm text-muted">None yet.</p> : null}
      <ul className="flex flex-col gap-2">
        {(quizzes.data ?? []).map((quiz) => (
          <li
            key={quiz.id}
            className="flex flex-wrap items-center gap-3 rounded-lg bg-cream/60 px-4 py-2.5 ring-1 ring-line"
          >
            <span className="font-medium text-grape">{quiz.title}</span>
            <span className="text-sm text-muted">
              {quiz.questions.length} question{quiz.questions.length === 1 ? '' : 's'} · {quiz.duration_minutes} min
            </span>
            {quiz.status === 'draft' ? <Badge variant="active">Draft</Badge> : null}
            {quiz.running ? <Badge variant="good">Running</Badge> : null}
            {quiz.status === 'closed' ? <Badge variant="muted">Finished</Badge> : null}
            <span className="ml-auto flex gap-1">
              <Button variant="quiet" onClick={() => navigate(`/classes/${classId}/quizzes/${quiz.id}`)}>
                {quiz.status === 'draft' ? 'Edit' : 'Details'}
              </Button>
              {quiz.status === 'draft' ? (
                <Button
                  variant="primary"
                  disabled={running || start.isPending || quiz.questions.length === 0}
                  onClick={() =>
                    start.mutate(quiz.id, { onSuccess: () => navigate(`/classes/${classId}/live`) })
                  }
                >
                  Start
                </Button>
              ) : null}
              {quiz.running ? (
                <Button variant="primary" onClick={() => navigate(`/classes/${classId}/live`)}>
                  Watch
                </Button>
              ) : null}
              {quiz.status === 'closed' ? (
                <Button variant="primary" onClick={() => navigate(`/assignments/${quiz.id}/mark`)}>
                  Mark
                </Button>
              ) : null}
              {!quiz.running ? (
                <Button variant="quiet" onClick={() => setDeleting({ id: quiz.id, title: quiz.title })}>
                  Delete
                </Button>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      {start.error ? <Notice tone="not-yet">{messageFor(start.error)}</Notice> : null}
      <TrashDialog
        open={deleting !== null}
        name={deleting ? `“${deleting.title}”` : ''}
        note="Children’s answers and marks on it go with it, and come back if you restore it."
        busy={trash.isPending}
        error={trash.error ? messageFor(trash.error) : null}
        onClose={() => {
          trash.reset()
          setDeleting(null)
        }}
        onConfirm={() =>
          deleting &&
          trash.mutate(
            { action: 'trash', kind: 'homework', id: deleting.id },
            { onSuccess: () => setDeleting(null) },
          )
        }
      />
    </Card>
  )
}
