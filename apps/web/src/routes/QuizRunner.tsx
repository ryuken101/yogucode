/**
 * A quiz, from the child's side: the questions, "I'm finished", and what happens at the end.
 *
 * While it runs this is the only page a child can reach (`RequireStudent` sends them
 * back here), and the top bar holds the class's one clock. "I'm finished" tells the teacher
 * and changes nothing else (Ken, 6 Nov 2026): they can still go back and edit until the quiz
 * ends, and the rest of their account stays closed. When time is up their work has already
 * been handed in — they do not press anything — and the page says so. Once the teacher
 * gives it back, the same page shows the feedback, read-only.
 */

import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { Badge } from '../components/Badge'
import { Button } from '../components/Button'
import { Dialog } from '../components/Dialog'
import { Dots } from '../components/Dots'
import { Notice } from '../components/Notice'
import { useQuizTimeUp } from '../components/useQuizTimeUp'
import { Spinner } from '../components/Spinner'
import { studentLive } from '../collab/socket'
import { hasUnsavedBackup } from '../editor/useAutosave'
import { api, type Schemas } from '../lib/api'
import { messageFor } from '../lib/errors'
import { keys, useActiveQuiz, useSheet } from '../lib/queries'
import { Returned } from './HomeworkSheet'

/** One problem on the list, from its leaves: a problem with parts is several leaves. */
function problemsOf(leaves: Schemas['SheetLeafOut'][]) {
  const problems = new Map<string, Schemas['SheetLeafOut'][]>()
  for (const leaf of leaves) problems.set(leaf.problem_id, [...(problems.get(leaf.problem_id) ?? []), leaf])
  return [...problems.values()].map((parts) => ({
    id: parts[0]!.problem_id,
    title: parts[0]!.problem_title,
    difficulty: parts[0]!.difficulty,
    answered: parts.every((leaf) => leaf.answered),
    started: parts.some((leaf) => leaf.progress !== 'not_started'),
  }))
}

export function QuizRunner() {
  const { assignmentId = '' } = useParams()
  const client = useQueryClient()
  const sheet = useSheet(assignmentId)
  const active = useActiveQuiz()
  const timeUp = useQuizTimeUp(assignmentId)
  const [confirming, setConfirming] = useState(false)
  const [failed, setFailed] = useState<unknown>(null)

  // The end arrives as a push; refresh what the page knows when it does.
  useEffect(
    () =>
      studentLive().onQuiz(() => {
        void client.invalidateQueries({ queryKey: keys.activeQuiz })
        void client.invalidateQueries({ queryKey: keys.sheet(assignmentId) })
      }),
    [client, assignmentId],
  )

  // The timer lost to a restart, or the push missed: the regular check says it's over.
  const running = active.data?.assignment_id === assignmentId ? active.data : null
  const over = !active.isPending && !running
  useEffect(() => {
    if (over) void client.invalidateQueries({ queryKey: keys.sheet(assignmentId) })
  }, [over, client, assignmentId])

  if (sheet.isPending || active.isPending) return <Spinner label="Opening the quiz" />
  if (sheet.error) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-8">
        <Notice tone="system-error">{messageFor(sheet.error)}</Notice>
      </div>
    )
  }

  const data = sheet.data
  const problems = problemsOf(data.leaves)
  const unanswered = problems.filter((problem) => !problem.answered)

  async function setFinished(finished: boolean) {
    setFailed(null)
    try {
      const now = await (finished ? api.finishQuiz(assignmentId) : api.resumeQuiz(assignmentId))
      client.setQueryData(keys.activeQuiz, now)
    } catch (error) {
      setFailed(error)
    }
  }

  // Typing the server never got: the hand-in could not include it, and they should know.
  const lostTyping = data.leaves.some((leaf) => leaf.attempt_id && hasUnsavedBackup(leaf.attempt_id))

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 px-6 py-8">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="min-w-0 break-words font-display font-semibold text-2xl text-grape [overflow-wrap:anywhere]">
          {data.title}
        </h1>
        <Badge variant="muted">Quiz</Badge>
      </div>

      {data.returned ? (
        <Returned sheet={data} />
      ) : running && timeUp ? (
        <Notice tone="info">Time’s up. Saving your work…</Notice>
      ) : running ? (
        <>
          {running.finished ? (
            <Notice tone="info">
              You’ve finished. You can still change your answers until the time is up.
            </Notice>
          ) : (
            <p className="text-sm text-muted">
              Your answers save as you go and are handed in when the time is up. Your teacher can
              see if you leave this page.
            </p>
          )}
          <ol className="flex flex-col gap-2">
            {problems.map((problem, index) => (
              <li key={problem.id}>
                <Link
                  to={`/quiz/${assignmentId}/${problem.id}`}
                  className="flex items-center gap-4 rounded-2xl bg-surface px-5 py-4 ring-1 ring-line hover:ring-grape"
                >
                  <span className="w-6 shrink-0 text-muted">{index + 1}.</span>
                  <Dots value={problem.difficulty} />
                  <span className="min-w-0 break-words font-medium text-grape [overflow-wrap:anywhere]">
                    {problem.title}
                  </span>
                  <span className="ml-auto shrink-0">
                    {/* Never `good`: mint means correct, and this says nothing about that. */}
                    {problem.answered ? (
                      <Badge variant="active">Answered</Badge>
                    ) : problem.started ? (
                      <Badge variant="muted">Started</Badge>
                    ) : null}
                  </span>
                </Link>
              </li>
            ))}
          </ol>
          <div className="flex justify-end">
            {running.finished ? (
              <Button variant="secondary" onClick={() => void setFinished(false)}>
                Go back and edit
              </Button>
            ) : (
              <Button variant="primary" onClick={() => setConfirming(true)}>
                I’m finished
              </Button>
            )}
          </div>
          {failed ? <Notice tone="system-error">{messageFor(failed)}</Notice> : null}
          <Dialog
            open={confirming}
            title="Are you finished?"
            onClose={() => setConfirming(false)}
            confirm={{
              label: 'I’m finished',
              onConfirm: () => {
                setConfirming(false)
                void setFinished(true)
              },
            }}
          >
            {unanswered.length ? (
              <>
                <p>You haven’t answered:</p>
                <ul className="mt-2 list-disc pl-5">
                  {unanswered.map((problem) => (
                    <li key={problem.id}>{problem.title}</li>
                  ))}
                </ul>
                <p className="mt-2">You can still come back and change your answers until the time is up.</p>
              </>
            ) : (
              <p>You can still come back and change your answers until the time is up.</p>
            )}
          </Dialog>
        </>
      ) : (
        <div className="flex flex-col gap-3">
          <Notice tone="good">The quiz has ended, and your answers have been handed in.</Notice>
          {lostTyping ? (
            <Notice tone="info">
              Some of your last changes may not have saved. Tell your teacher.
            </Notice>
          ) : null}
          <p className="text-sm text-muted">Your teacher will give them back when they’ve looked at them.</p>
          <Link to="/home" className="text-sm text-grape-deep">
            ← Home
          </Link>
        </div>
      )}
    </div>
  )
}
