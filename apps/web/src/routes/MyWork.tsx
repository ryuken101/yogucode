/**
 * A child's Work app (16 Oct 2026): their homework, and their quizzes on the second tab
 * (`?tab=quizzes`). The same cards the home page used to show (`StudentHome.HomeworkCard`).
 */

import { useSearchParams } from 'react-router'
import { EmptyState } from '../components/Card'
import { Notice } from '../components/Notice'
import { Spinner } from '../components/Spinner'
import { messageFor } from '../lib/errors'
import { useHome } from '../lib/queries'
import { HomeworkCard } from './StudentHome'

export function MyWork() {
  const home = useHome()
  const [params] = useSearchParams()
  const quizzes = params.get('tab') === 'quizzes'

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
