/**
 * Difficulty as dots — spec §3.3's 1-dot / 2-dot / 3-dot ladder.
 *
 * Dots rather than words ("easy", "hard") because a child reads a word as a verdict on
 * themselves; three dots is just the next rung. Sky, not a traffic-light scale: a 3-dot
 * problem is not a warning.
 */

const LEVELS = [1, 2, 3] as const

export function Dots({ value }: { value: number }) {
  return (
    <span className="inline-flex gap-0.5" aria-label={`${value} dot${value === 1 ? '' : 's'}`}>
      {LEVELS.map((level) => (
        <span
          key={level}
          aria-hidden
          className={`size-2 rounded-full ${level <= value ? 'bg-sky-deep' : 'bg-sky-pale'}`}
        />
      ))}
    </span>
  )
}

export function DotsPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: number
  onChange: (value: number) => void
  disabled?: boolean
}) {
  return (
    <div role="radiogroup" aria-label="Difficulty" className="inline-flex gap-1">
      {LEVELS.map((level) => (
        <button
          key={level}
          type="button"
          role="radio"
          aria-checked={value === level}
          disabled={disabled}
          onClick={() => onChange(level)}
          className={`rounded-lg px-3 py-1.5 ring-1 transition-colors disabled:opacity-50 ${
            value === level ? 'bg-sky-pale ring-sky' : 'bg-paper ring-ink/15 hover:bg-cream'
          }`}
        >
          <Dots value={level} />
        </button>
      ))}
    </div>
  )
}
