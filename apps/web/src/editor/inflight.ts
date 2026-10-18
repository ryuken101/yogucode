/**
 * Saves on their way to the server, from every editor on the page. Opening a child's work
 * waits for these first (`afterSaves`), so a window closed mid-save and reopened at once
 * reads what was just written, not the copy before it (bug, 17 Oct 2026).
 *
 * Its own module so `lib/queries.ts` and `editor/useAutosave.ts` need not import each other.
 */

const inflight = new Set<Promise<unknown>>()

/** Track a save until it settles. */
export function track(save: Promise<unknown>): void {
  inflight.add(save)
  const done = () => inflight.delete(save)
  void save.then(done, done)
}

export function afterSaves(): Promise<unknown> {
  return Promise.allSettled([...inflight])
}
