/** The marks Skills draws with (see `levels.ts` for why they look as they do). */

import { RotateCcw } from 'lucide-react'
import { FLAG_LABEL, LEVEL_LABEL, type Flag, type Level, type Skill } from './levels'

/** A level as a filled circle: full mint, half mint, a lemon ring, or a grey dash. */
export function LevelDot({ skill, size = 18 }: { skill: Pick<Skill, 'level' | 'confident'>; size?: number }) {
  const r = size / 2 - 1.5
  const c = size / 2
  const faint = skill.confident ? 1 : 0.55
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden style={{ opacity: faint }}>
      {skill.level === 'not_taught' ? (
        <circle cx={c} cy={c} r={r} fill="none" stroke="var(--color-line)" strokeWidth={2} strokeDasharray="3 2" />
      ) : skill.level === 'not_yet' ? (
        <circle cx={c} cy={c} r={r} fill="var(--color-surface)" stroke="var(--color-not-yet)" strokeWidth={2.5} />
      ) : skill.level === 'learning' ? (
        <>
          <circle cx={c} cy={c} r={r} fill="var(--color-surface)" stroke="var(--color-good)" strokeWidth={2} />
          <path d={`M ${c} ${c - r} A ${r} ${r} 0 0 0 ${c} ${c + r} Z`} fill="var(--color-good)" />
        </>
      ) : (
        <circle cx={c} cy={c} r={r} fill="var(--color-good)" stroke="var(--color-good)" strokeWidth={2} />
      )}
    </svg>
  )
}

/** The ⟲ mark, with the reasons as its accessible name. */
export function RevisitMark({ flags, below = false }: { flags: Flag[]; below?: boolean }) {
  if (!flags.length && !below) return null
  const why = flags.length ? flags.map((f) => FLAG_LABEL[f]).join('; ') : 'Something under it needs revisiting'
  return (
    <span role="img" aria-label={`Revisit: ${why}`} title={why} className="inline-flex text-grape">
      <RotateCcw className={flags.length ? 'size-3.5 stroke-[2.75]' : 'size-3 opacity-60'} />
    </span>
  )
}

export function Legend() {
  const shown: Level[] = ['secure', 'learning', 'not_yet', 'not_taught']
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
      {shown.map((level) => (
        <li key={level} className="inline-flex items-center gap-1.5">
          <LevelDot skill={{ level, confident: true }} size={14} />
          {LEVEL_LABEL[level]}
        </li>
      ))}
      <li className="inline-flex items-center gap-1.5">
        <RotateCcw className="size-3.5 stroke-[2.75] text-grape" aria-hidden />
        Revisit
      </li>
      <li>Faded: too early to tell</li>
    </ul>
  )
}
