/**
 * A multiple-choice question's options: the text of each, which one is right, and — for
 * each wrong one — the misconception that leads a child to pick it.
 *
 * Spec §3.6 calls this the highest-leverage diagnostic in the product: a wrong option
 * that encodes a *specific* wrong belief turns "4 of 12 got it wrong" into "four of you
 * think range includes the end". So the misconception box sits right next to each wrong
 * answer, and publishing warns (but does not refuse) when one is left empty.
 */

import { Button } from '../components/Button'
import type { Schemas } from '../lib/api'

type Option = Schemas['OptionDoc']

interface Props {
  options: Option[]
  onChange: (options: Option[]) => void
  disabled?: boolean
}

const MAX = 8

export function McqEditor({ options, onChange, disabled }: Props) {
  function update(index: number, patch: Partial<Option>) {
    onChange(options.map((o, i) => (i === index ? { ...o, ...patch } : o)))
  }

  return (
    <fieldset disabled={disabled} className="flex flex-col gap-3">
      <legend className="mb-1 text-sm font-medium text-grape">Options</legend>
      {options.map((option, index) => (
        <div key={index} className="rounded-lg bg-cream/60 p-3 ring-1 ring-line">
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-sm text-grape">
              <input
                type="radio"
                name="correct-option"
                checked={option.correct}
                onChange={() => onChange(options.map((o, i) => ({ ...o, correct: i === index })))}
              />
              Right answer
            </label>
            <input
              aria-label={`Option ${index + 1}`}
              value={option.text}
              onChange={(e) => update(index, { text: e.target.value })}
              placeholder={`Option ${index + 1}`}
              className="flex-1 rounded-lg bg-surface px-3 py-1.5 font-mono text-sm text-grape ring-1 ring-grape/20"
            />
            {disabled ? null : (
              <Button variant="quiet" onClick={() => onChange(options.filter((_, i) => i !== index))}>
                Remove
              </Button>
            )}
          </div>
          {option.correct ? null : (
            <input
              aria-label={`Misconception for option ${index + 1}`}
              value={option.misconception ?? ''}
              onChange={(e) => update(index, { misconception: e.target.value || null })}
              placeholder="Who picks this? e.g. “thinks range includes the end”"
              className="mt-2 w-full rounded-lg bg-surface px-3 py-1.5 text-sm text-grape ring-1 ring-grape/20"
            />
          )}
        </div>
      ))}
      {disabled || options.length >= MAX ? null : (
        <div>
          <Button
            variant="secondary"
            onClick={() => onChange([...options, { text: '', correct: options.length === 0, misconception: null }])}
          >
            Add an option
          </Button>
        </div>
      )}
    </fieldset>
  )
}
