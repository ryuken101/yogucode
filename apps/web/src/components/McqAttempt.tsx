/**
 * Answering a multiple-choice question.
 *
 * The chosen answer is shown in grape — "this is the one you picked" — and never in `good`
 * or `not-yet`: colouring it would tell the child whether they were right, which is the
 * teacher's to say when the work is given back. The choice saves as soon as it is made,
 * and can be changed until the work is handed in or the quiz ends.
 */

import { useState } from 'react'
import { Notice } from './Notice'

interface Props {
  options: string[]
  initial: number | null
  onChoose: (choice: number) => Promise<unknown>
  disabled?: boolean
}

export function McqAttempt({ options, initial, onChoose, disabled = false }: Props) {
  const [chosen, setChosen] = useState<number | null>(initial)
  const [failed, setFailed] = useState(false)

  return (
    <div className="flex flex-col gap-2">
      <div role="radiogroup" aria-label="Answers" className="flex flex-col gap-2">
        {options.map((text, index) => (
          <button
            key={index}
            type="button"
            role="radio"
            aria-checked={chosen === index}
            disabled={disabled}
            onClick={() => {
              const previous = chosen
              setChosen(index)
              setFailed(false)
              onChoose(index).catch(() => {
                setChosen(previous)
                setFailed(true)
              })
            }}
            className={`rounded-2xl px-4 py-3 text-left font-mono text-base ring-1 transition disabled:cursor-not-allowed ${
              chosen === index ? 'bg-grape-pale ring-2 ring-grape' : 'bg-surface ring-grape/20 hover:ring-grape'
            }`}
          >
            {text}
          </button>
        ))}
      </div>
      {failed ? <Notice tone="system-error">That answer didn’t save. Try again.</Notice> : null}
    </div>
  )
}
