/**
 * Answering a multiple-choice question.
 *
 * The chosen answer is shown in sky — "this is the one you picked" — and never in sage or
 * amber: colouring it would tell the child whether they were right, which is the
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
            className={`rounded-xl px-4 py-3 text-left font-mono text-base ring-1 transition disabled:cursor-not-allowed ${
              chosen === index ? 'bg-sky-pale ring-2 ring-sky' : 'bg-paper ring-ink/15 hover:ring-sky'
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
