/**
 * Ties a child's sign-in to the tab they signed in from (Ken's decision, 10 Oct 2026):
 * closing the tab means signing in again next time.
 *
 * The student session is an httpOnly cookie, which JavaScript cannot read or scope to a
 * tab — that is its point. So the tab carries a marker in sessionStorage, which the
 * browser drops when the tab closes. A tab that finds a live session but no marker was
 * opened after the child's tab closed (or is a second tab): the screens sign that session
 * out on the server and show the sign-in page. Teachers get the same behaviour from
 * supabase-js storing its session in sessionStorage (`lib/supabase.ts`).
 */

const KEY = 'yogucode.student-tab'

function storage(): Storage | null {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

/** Call when a child signs in from this tab. */
export function markStudentTab(): void {
  storage()?.setItem(KEY, '1')
}

/** True when this tab is the one the child signed in from. */
export function isStudentTab(): boolean {
  return storage()?.getItem(KEY) === '1'
}

export function clearStudentTab(): void {
  storage()?.removeItem(KEY)
}
