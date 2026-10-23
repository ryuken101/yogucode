/**
 * Dates as a child or a parent reads them: "Thu 16 Oct, 4:00 pm".
 *
 * Formatted in the viewer's own time zone, which for this product is Sydney. The server
 * stores and compares instants (UTC); only display is local.
 */

const DUE = new Intl.DateTimeFormat('en-AU', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
})

const DUE_WITH_YEAR = new Intl.DateTimeFormat('en-AU', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})

/** The year is shown only when it isn't this one: 1 Jan 2020 read as next January before
 * 23 Oct 2026. */
export function formatDue(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return 'No due date'
  const date = new Date(iso)
  const format = date.getFullYear() === now.getFullYear() ? DUE : DUE_WITH_YEAR
  return format.format(date).replace(/\s?(am|pm)$/i, (m) => m.toLowerCase())
}

export function isPast(iso: string | null | undefined, now = Date.now()): boolean {
  return Boolean(iso && new Date(iso).getTime() < now)
}

/** An ISO instant as the value a `<input type="datetime-local">` expects, in local time. */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** A `datetime-local` value (local, no zone) as an ISO instant with the zone attached. */
export function fromLocalInput(value: string): string | null {
  if (!value) return null
  return new Date(value).toISOString()
}

/** "14:32" — the minutes and seconds left on a quiz's clock, never below zero. */
export function timeLeft(endsAt: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.ceil((new Date(endsAt).getTime() - now) / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** Whole days until something in the Trash is deleted for good (never below 0). */
export function daysLeft(purgeAfter: string, now = Date.now()): number {
  return Math.max(0, Math.ceil((new Date(purgeAfter).getTime() - now) / 86_400_000))
}

