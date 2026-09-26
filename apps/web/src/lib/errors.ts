/**
 * One place that understands what the API puts in `detail`.
 *
 * FastAPI does not enforce a single error envelope, and ours genuinely has four shapes:
 *
 *   1. a plain string        — most 401/403/404/409/429
 *   2. `{code, message}`     — the 403 that means "you have never signed in here"
 *   3. an array of issues    — FastAPI's own 422 for a malformed request body
 *   4. `{message, entries}`  — the bulk-paste 422, which names the rows to fix
 *
 * Narrowing them in each screen would mean four chances per screen to get it wrong, and
 * the failure mode is showing a child or a teacher `[object Object]`. So it happens once,
 * here, and everything downstream reads `ApiError`.
 */

/** The 403 code the API sends when a verified teacher has no `users` row yet. */
export const NOT_PROVISIONED = 'profile_not_provisioned'

/** One rejected row from a bulk-paste 422. Mirrors the router's `problems` list. */
export interface BulkEntryProblem {
  index: number
  action?: string
  reason?: string | null
  candidates?: string[]
}

interface ValidationIssue {
  loc: (string | number)[]
  msg: string
  type: string
}

export class ApiError extends Error {
  readonly status: number
  /** `profile_not_provisioned`, when the API sent a coded 403. */
  readonly code?: string
  /** Rows to fix, when the bulk-paste commit refused the whole submission. */
  readonly entries?: BulkEntryProblem[]
  /** Field-level issues, when FastAPI rejected the request body. */
  readonly issues?: ValidationIssue[]

  constructor(
    status: number,
    message: string,
    extra: { code?: string; entries?: BulkEntryProblem[]; issues?: ValidationIssue[] } = {},
  ) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = extra.code
    this.entries = extra.entries
    this.issues = extra.issues
  }

  /** A teacher has a token but no profile — the web app should call the bootstrap route. */
  get isNotProvisioned(): boolean {
    return this.status === 403 && this.code === NOT_PROVISIONED
  }

  /** Signed out, or a session that is no longer valid. */
  get isUnauthenticated(): boolean {
    return this.status === 401
  }

  /** PIN lockout. Not an error the person can fix by trying harder. */
  get isLockedOut(): boolean {
    return this.status === 429
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Build an ApiError from a failed response body.
 *
 * `body` is whatever `response.json()` produced, or undefined when the body was not JSON
 * at all — a proxy error page or a dropped connection, which has to stay readable rather
 * than throwing a second time while handling the first.
 */
export function toApiError(status: number, body: unknown, fallback: string): ApiError {
  const detail = isRecord(body) ? body.detail : undefined

  if (typeof detail === 'string') {
    return new ApiError(status, detail)
  }

  if (Array.isArray(detail)) {
    const issues = detail as ValidationIssue[]
    const first = issues[0]?.msg
    return new ApiError(status, first ?? fallback, { issues })
  }

  if (isRecord(detail)) {
    const message = typeof detail.message === 'string' ? detail.message : fallback
    const code = typeof detail.code === 'string' ? detail.code : undefined
    const entries = Array.isArray(detail.entries)
      ? (detail.entries as BulkEntryProblem[])
      : undefined
    return new ApiError(status, message, { code, entries })
  }

  return new ApiError(status, fallback)
}

/**
 * What to show a person when something failed.
 *
 * Deliberately never returns a bare status code: "403" tells a teacher nothing, and the
 * API's own messages are already written for the person rather than the developer.
 */
export function messageFor(error: unknown): string {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error && error.message) return error.message
  return 'Something went wrong. Please try again.'
}
