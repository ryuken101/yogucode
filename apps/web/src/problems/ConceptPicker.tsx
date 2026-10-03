/**
 * Concept tags, with one marked as the main one.
 *
 * Spec §3.7: every question carries a concept tag, and Phase 8 mastery reads the *main*
 * tag to know what a problem mostly tests. Chips toggle membership; the star picks the
 * main one. Picking the first tag makes it main automatically — the common case is a
 * problem about one thing.
 */

import type { Schemas } from '../lib/api'

interface Props {
  concepts: Schemas['ConceptOut'][]
  selected: string[]
  primary: string | null
  onChange: (selected: string[], primary: string | null) => void
  disabled?: boolean
}

export function ConceptPicker({ concepts, selected, primary, onChange, disabled }: Props) {
  function toggle(id: string) {
    if (selected.includes(id)) {
      const rest = selected.filter((other) => other !== id)
      onChange(rest, primary === id ? (rest[0] ?? null) : primary)
    } else {
      onChange([...selected, id], primary ?? id)
    }
  }

  return (
    <fieldset disabled={disabled}>
      <legend className="mb-1.5 text-sm font-medium text-ink">Concepts</legend>
      <div className="flex flex-wrap gap-1.5">
        {concepts.map((concept) => {
          const on = selected.includes(concept.id)
          const main = primary === concept.id
          return (
            <span
              key={concept.id}
              className={`inline-flex items-center rounded-full text-xs ring-1 ${
                on ? 'bg-sky-pale ring-sky' : 'bg-paper ring-ink/15'
              }`}
            >
              <button
                type="button"
                aria-pressed={on}
                onClick={() => toggle(concept.id)}
                className="px-2.5 py-1 text-ink"
              >
                {concept.label}
              </button>
              {on ? (
                <button
                  type="button"
                  aria-label={`Make ${concept.label} the main concept`}
                  aria-pressed={main}
                  onClick={() => onChange(selected, concept.id)}
                  className={`pr-2 ${main ? 'text-sky-deep' : 'text-ink-soft/50 hover:text-ink-soft'}`}
                >
                  ★
                </button>
              ) : null}
            </span>
          )
        })}
      </div>
      {selected.length > 0 ? (
        <p className="mt-1.5 text-xs text-ink-soft">★ marks the main concept.</p>
      ) : null}
    </fieldset>
  )
}
