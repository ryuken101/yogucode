/**
 * A child's Work app (16 Oct 2026): their homework, their quizzes on the second tab
 * (`?tab=quizzes`), and — since 17 Oct 2026 — the lesson problems they have started on the
 * third (`?tab=lessons`), so one from an earlier lesson can be finished at home. Homework
 * and quizzes are the same cards the home page used to show (`StudentHome.HomeworkCard`).
 */

import { Link, useSearchParams } from 'react-router'
import { Badge } from '../components/Badge'
import { EmptyState } from '../components/Card'
import { Notice } from '../components/Notice'
import { Spinner } from '../components/Spinner'
import type { Schemas } from '../lib/api'
import { messageFor } from '../lib/errors'
import { useHome, useStartedProblems } from '../lib/queries'
import { HomeworkCard } from './StudentHome'

export function MyWork() {
  const [params] = useSearchParams()
  const tab = params.get('tab')
  if (tab === 'lessons') return <LessonWork />
  return <Sheets quizzes={tab === 'quizzes'} />
}

function Sheets({ quizzes }: { quizzes: boolean }) {
  const home = useHome()

  if (home.isPending) return <Spinner label="Loading" />
  if (home.error) return <Notice tone="system-error">{messageFor(home.error)}</Notice>

  const cards = home.data.homework.filter((card) => (card.mode === 'quiz') === quizzes)
  if (cards.length === 0) {
    return (
      <EmptyState title={quizzes ? 'No quizzes yet' : 'No homework right now'}>
        {quizzes
          ? 'When your teacher starts a quiz, it opens here.'
          : 'When your teacher sets homework, it shows up here.'}
      </EmptyState>
    )
  }
  return (
    <ul className="flex flex-col gap-2">
      {cards.map((card) => (
        <li key={card.assignment_id}>
          <HomeworkCard card={card} />
        </li>
      ))}
    </ul>
  )
}

/** Lesson problems the child has started, grouped by lesson, last worked on first. */
function LessonWork() {
  const started = useStartedProblems()

  if (started.isPending) return <Spinner label="Loading" />
  if (started.error) return <Notice tone="system-error">{messageFor(started.error)}</Notice>
  if (started.data.length === 0) {
    return (
      <EmptyState title="No lesson work yet">
        Problems you start in a lesson show up here, so you can finish them later — at home too.
      </EmptyState>
    )
  }

  const lessons = new Map<string, Schemas['StartedProblemOut'][]>()
  for (const problem of started.data) {
    const group = lessons.get(problem.assignment_id) ?? []
    group.push(problem)
    lessons.set(problem.assignment_id, group)
  }

  return (
    <div className="flex flex-col gap-5">
      {[...lessons.values()].map((problems) => (
        <section key={problems[0]!.assignment_id} aria-label={problems[0]!.lesson_title}>
          <h2 className="mb-2 font-display text-lg font-semibold text-grape">{problems[0]!.lesson_title}</h2>
          <ul className="flex flex-col gap-2">
            {problems.map((problem) => (
              <li key={problem.item_id}>
                <Link
                  to={`/lesson/${problem.assignment_id}/${problem.item_id}`}
                  className="flex flex-wrap items-center gap-3 rounded-2xl bg-surface px-5 py-4 ring-1 ring-line hover:ring-grape"
                >
                  <span className="font-medium text-grape">{problem.title}</span>
                  {problem.part_labels.length > 0 ? (
                    <span className="text-sm text-muted">
                      Parts {problem.part_labels.map((label) => `(${label})`).join(' ')}
                    </span>
                  ) : null}
                  <span className="ml-auto">
                    {problem.progress === 'passing' ? (
                      <Badge variant="good">All checks passing</Badge>
                    ) : (
                      <Badge variant="active">Keep going</Badge>
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
