/**
 * "Quiz running", in a teacher's top bar wherever they are (Ken, 6 Nov 2026): for every
 * teacher and the owner, and for any class at the centre, since any class is anyone's to
 * cover. From here they can watch it or stop it without finding the class first.
 */

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { StopQuizDialog } from '../components/QuizControls'
import { timeLeft } from '../lib/dates'
import { useRunningQuizzes } from '../lib/queries'
import type { Schemas } from '../lib/api'
import { Menu } from './Menu'

export function RunningQuizzes() {
  const navigate = useNavigate()
  const running = useRunningQuizzes()
  const [stopping, setStopping] = useState<Schemas['RunningQuizOut'] | null>(null)
  const [, setTick] = useState(0)
  const quizzes = running.data ?? []
  const any = quizzes.length > 0
  useEffect(() => {
    if (!any) return
    const timer = setInterval(() => setTick((n) => n + 1), 1_000)
    return () => clearInterval(timer)
  }, [any])

  const only = quizzes.length === 1 ? quizzes[0] : null
  return (
    <>
      {any ? (
        <Menu
          label="Running quizzes"
          align="right"
          items={quizzes.flatMap((quiz) => [
            {
              label: `Watch ${quiz.title}`,
              detail: `${quiz.class_name} · ${timeLeft(quiz.ends_at)} left`,
              onSelect: () => navigate(`/classes/${quiz.class_id}/live`),
            },
            { label: `Stop ${quiz.title}…`, detail: quiz.class_name, onSelect: () => setStopping(quiz) },
          ])}
        >
          <span aria-hidden className="size-2 shrink-0 rounded-full bg-good" />
          {only ? (
            <>
              <span>Quiz running</span>
              <span className="hidden max-w-40 truncate font-normal text-muted md:inline">{only.class_name}</span>
              <span className="font-mono">{timeLeft(only.ends_at)}</span>
            </>
          ) : (
            <span>{quizzes.length} quizzes running</span>
          )}
        </Menu>
      ) : null}
      {stopping ? (
        <StopQuizDialog
          quiz={{ id: stopping.id, class_id: stopping.class_id, title: stopping.title }}
          open
          onClose={() => setStopping(null)}
        />
      ) : null}
    </>
  )
}
