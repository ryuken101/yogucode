/**
 * The hint ladder: nudge → stronger hint → worked example (spec §3.4).
 *
 * Each rung unlocks after a number of runs *or* a number of minutes, whichever comes
 * first. The gate is what stops a child bottoming out the ladder instead of thinking.
 */

import { Button } from '../components/Button'
import { TextInput, Textarea } from '../components/Field'
import type { HintDoc } from './doc'

const RUNGS = ['Nudge', 'Stronger hint', 'Worked example']

interface Props {
  hints: HintDoc[]
  onChange: (hints: HintDoc[]) => void
  disabled?: boolean
}

export function HintsEditor({ hints, onChange, disabled }: Props) {
  function update(index: number, next: HintDoc) {
    onChange(hints.map((hint, i) => (i === index ? next : hint)))
  }

  return (
    <div className="flex flex-col gap-3">
      {hints.map((hint, index) => (
        <div key={index} className="rounded-lg bg-cream/60 p-3 ring-1 ring-line">
          <Textarea
            label={RUNGS[index]}
            rows={3}
            value={hint.body_md}
            disabled={disabled}
            onChange={(event) => update(index, { ...hint, body_md: event.target.value })}
          />
          <div className="mt-2 flex flex-wrap items-end gap-3">
            <div className="w-36">
              <TextInput
                label="Unlocks after runs"
                type="number"
                min={0}
                max={50}
                value={hint.unlock_after_runs}
                disabled={disabled}
                onChange={(event) =>
                  update(index, { ...hint, unlock_after_runs: Number(event.target.value) })
                }
              />
            </div>
            <span className="pb-2 text-sm text-muted">or</span>
            <div className="w-36">
              <TextInput
                label="…or minutes"
                type="number"
                min={0}
                max={60}
                value={Math.round(hint.unlock_after_seconds / 60)}
                disabled={disabled}
                onChange={(event) =>
                  update(index, {
                    ...hint,
                    unlock_after_seconds: Number(event.target.value) * 60,
                  })
                }
              />
            </div>
            {disabled ? null : (
              <Button
                variant="quiet"
                onClick={() => onChange(hints.filter((_, i) => i !== index))}
              >
                Remove
              </Button>
            )}
          </div>
        </div>
      ))}
      {disabled || hints.length >= 3 ? null : (
        <div>
          <Button
            variant="secondary"
            onClick={() =>
              onChange([
                ...hints,
                { body_md: '', unlock_after_runs: hints.length + 1, unlock_after_seconds: 120 * (hints.length + 1) },
              ])
            }
          >
            Add {RUNGS[hints.length].toLowerCase()}
          </Button>
        </div>
      )}
    </div>
  )
}
