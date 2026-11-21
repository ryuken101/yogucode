/**
 * How a level looks, everywhere in Skills (Ken, 21 Nov 2026; the rules are
 * `apps/api/src/app/skills.py`).
 *
 * The palette rule holds here as everywhere: mint (`good`) is secure, lemon (`not-yet`) is
 * not yet, and never red. "Learning" is half mint — on its way. A concept nobody has been
 * set yet is grey, so a child never looks behind on something they haven't met. Revisit is
 * a grape ⟲, loud by its shape rather than an alarm colour.
 */

import type { Schemas } from '../lib/api'

export type Skill = Schemas['SkillOut']
export type Level = Skill['level']
export type Flag = Skill['revisit'][number]

export const LEVEL_LABEL: Record<Level, string> = {
  secure: 'Secure',
  learning: 'Learning',
  not_yet: 'Not yet',
  not_taught: 'Not taught yet',
}

export const FLAG_LABEL: Record<Flag, string> = {
  slipping: 'Slipping — had it, then missed it',
  stuck: 'Stuck — several tries, no full pass',
  stale: 'Gone stale — not practised for 3 weeks',
}

/** How full a level bar is. */
export const LEVEL_FILL: Record<Level, number> = { not_taught: 0, not_yet: 0.15, learning: 0.55, secure: 1 }

/** Words for a cell or node, for screen readers and hover. */
export function describe(skill: Skill): string {
  const parts = [LEVEL_LABEL[skill.level]]
  if (skill.level !== 'not_taught' && !skill.confident) parts.push('too early to tell')
  if (skill.revisit.length) parts.push(`revisit (${skill.revisit.join(', ')})`)
  else if (skill.below) parts.push('something under it needs revisiting')
  return parts.join(', ')
}
