/**
 * Stuck signals for a live tile (spec §3.9), from what a child's page has reported.
 *
 * The teacher cannot watch twelve editors; these say where to look:
 *
 * - **same error ×N** — the same Python error four or more times in a row: stuck, and
 *   probably not reading the message;
 * - **no run for 5 min** — connected, editing nothing runnable, or not editing at all;
 * - **pasted** — a large paste (Ken's decision: allowed, recorded, shown to the teacher,
 *   never framed as cheating);
 * - **all passing** — every check passes: finished, and ready for the next rung.
 *
 * Tones follow the palette rule: amber for "worth a look", sage for done, sky for
 * information. Never rust — a stuck child is not an error.
 */

import type { LiveStudent } from '../collab/useLiveClass'

export interface Flag {
  label: string
  tone: 'attention' | 'done' | 'info'
}

export const SAME_ERROR_TIMES = 4
export const IDLE_MS = 5 * 60_000
export const BIG_PASTE_CHARS = 80

export function flagsFor(student: LiveStudent, now = Date.now()): Flag[] {
  if (!student.online) return []
  const flags: Flag[] = []
  const recent = student.recent

  // Same error, several runs in a row (checks in between do not break the streak).
  const errors = recent.filter((s) => s.kind === 'error' || s.kind === 'run')
  let streak = 0
  let last: string | undefined
  for (let i = errors.length - 1; i >= 0; i--) {
    const s = errors[i]!
    if (s.kind === 'run') continue
    if (last === undefined) last = s.text
    if (s.text !== last) break
    streak++
  }
  if (streak >= SAME_ERROR_TIMES) flags.push({ label: `same error ×${streak}`, tone: 'attention' })

  const lastRun = [...recent].reverse().find((s) => s.kind === 'run' || s.kind === 'check')
  const lastActive = Math.max(lastRun?.at ?? 0, student.lastEditAt ?? 0)
  if (lastActive && now - lastActive > IDLE_MS) flags.push({ label: 'quiet for 5 min', tone: 'attention' })

  const paste = [...recent].reverse().find((s) => s.kind === 'paste' && (s.chars ?? 0) >= BIG_PASTE_CHARS)
  if (paste && paste.target === student.focus?.target) {
    flags.push({ label: `pasted ${paste.chars} chars`, tone: 'info' })
  }

  const check = [...recent].reverse().find((s) => s.kind === 'check' && s.target === student.focus?.target)
  if (check && check.total && check.passed === check.total && !check.compile_error) {
    flags.push({ label: 'all passing', tone: 'done' })
  }
  return flags
}
