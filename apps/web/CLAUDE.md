# apps/web

Frontend conventions. The root `CLAUDE.md` carries the cross-cutting rules; this file
loads only when working under `apps/web`.

## The brand, the palette rule, and where it is enforced

The look is the **Yogucode brand** (Ken's choice, 10 Oct 2026, from the "Yogucode Brand"
design system; it supersedes product-spec §8's sky and cream). `src/theme.css` holds it as
Tailwind v4 theme tokens: `grape` text and primary buttons, `cream` ground, `surface` (white)
cards with `line` hairlines, `strawberry` in small doses, `lemon` as a spark; `muted` is the
brand's muted darkened to pass 4.5:1 on cream. Fredoka (self-hosted,
`@fontsource-variable/fredoka` — no Google Fonts requests from children's browsers) for
everything, system mono for code. Large radii (cards `rounded-3xl`, buttons and panels
`rounded-2xl`), pill badges, hairlines rather than shadows.

`src/components/Brand.tsx` has the marks — `CupMark` (the brand SVG verbatim; also
`public/favicon.svg`), `Wordmark` (`<yogucode>`: letters take the text colour, o's and
brackets always strawberry), `Lockup` and the front-page `Welcome`. Never redraw the cup or
recolour the o's. `public/yogucode-cup.png` exists for emails, which can't show SVG.

One rule is load-bearing and easy to violate by habit: **never red for a student's
incorrect answer.** The state colours are named by role — `not-yet` (lemon fill;
`not-yet-ink` for text on light ground), `good` (mint; `good-ink` for text), and
`system-error` (raspberry), reserved for the app failing. **Strawberry is never a state**:
pink-red on a wrong answer is still red.

That rule is encoded in components rather than left to each screen. `Badge` and `Notice`
take semantic tones (`not-yet`, `good`, `muted`, `system-error`), and the only way to
reach the error colour is to type the words `system-error`, which is long enough to make
you think. `Button` has **no danger variant**: nothing in this product deletes, and the two actions
that feel destructive — rotating a join code, signing a student out — confirm in a
`Dialog` with words instead of being coloured red.

`src/components/palette.test.tsx` (including "strawberry is never a state") and the colour
assertions in `src/routes/Join.test.tsx` fail the build if this slips. Deleting them is
not a way to make a failure go away.

## Structure

- `src/lib/api-types.ts` is **generated** from `apps/api/openapi.json` by
  `npm run api:types`. Never edit it. Regenerate after any API response model changes;
  CI fails if `openapi.json` is stale.
- `src/lib/errors.ts` is the only place that narrows the API's four `detail` shapes.
  Screens read `ApiError`, never a raw body.
- `src/lib/api.ts` is the only place that calls `fetch`. It always sends credentials (the
  student cookie) and attaches a teacher bearer token when there is a session, read fresh
  each request because supabase-js rotates it.
- `src/lib/queries.ts` owns the TanStack Query keys. Mutations invalidate the key they
  affect and no more.

Students never talk to Supabase directly; `@supabase/supabase-js` is for teacher auth
only, and the `service_role` key must never appear in this app.

**Teacher auth screens** (email + password since 10 Oct 2026): `/sign-in` (with "Forgot
password?"), `/sign-up` (asks `signupAllowed` before creating a Supabase account),
`/reset-password`, and `/auth/callback`, where every sign-in finishes and the only place
that provisions. `lib/supabase.ts` maps Supabase's error codes to `AuthProblem`s: a wrong
password, an unverified email or an expired link is `not-yet`; only Supabase being
unreachable is `system-error`. `/teachers` is the owner's page (nav link shown only to
the owner; the API 403s everyone else).

## Two audiences, one app

Teacher routes sit behind `RequireTeacher`, which supplies `AppShell`. `/join` is outside
it: a child gets `JoinShell` with no navigation, no sign-out and no centre name. The join
flow must keep working when Supabase is unconfigured or unreachable, because it does not
use Supabase at all.

**The bare address `/` is the children's front door** (Ken's decision, 8 Oct 2026; it
replaced a QR code on the PIN slips). `Landing.tsx` sends a child who is still signed in
to `/home` and a teacher with a session to `/classes`, and otherwise shows the `/join`
flow with a "Teacher? Sign in here" link to `/sign-in`. `/join` remains as an alias. The
slips and the class page print the site's host so children know what to type.

**The class code never goes in a URL.** `/join` keeps its steps in component state. A code
in a query string lands in browser history on a shared centre laptop, in proxy logs, and
in the `Referer` of the next request — which is also why the API takes it in a POST body.

## Local development and production

In production the API serves this build itself (`apps/api/src/app/server.py`) under one
address, so `/api` is same-origin there too: no CORS, and the student cookie and live
sockets just work. The isolation headers that `vite.config.ts` sets in development are set
by the server in production.

`npm run dev` proxies `/api` to `localhost:8000` (see `vite.config.ts`), so the browser
sees one origin and the API needs no CORS. That changes at step 10, when the two are
genuinely on different domains; `VITE_API_BASE_URL` makes it a config change.

Copy `.env.example` to `.env.local` and fill in the Supabase values. Without them the app
still builds and `/join` still works — only teacher sign-in is unavailable, and it says so.

## The Python runtime

`src/runtime/` runs Python in a Web Worker under Pyodide, self-hosted from
`public/pyodide/` (copied out of node_modules by `scripts/copy-pyodide.mjs`, gitignored,
version pinned in `package.json`).

**The app requires cross-origin isolation**, and `vite.config.ts` sets the two headers for
it. This is not optional decoration: Pyodide's stdin callback is synchronous, so an
interactive `input()` from a worker needs `Atomics.wait` on a `SharedArrayBuffer`, and
interrupting a runaway loop needs `setInterruptBuffer`, which needs the same. Without the
headers `SharedArrayBuffer` is undefined, `crossOriginIsolated` is false, and the editor
says so rather than offering a Run button that would hang. **Vercel needs those headers at
step 10.**

`src/runtime/channel.ts` holds the two shared buffers. Read its comments before changing
either: `postMessage` cannot reach a worker blocked in `Atomics.wait`, and the interrupt
buffer does **not** rescue a program waiting at an `input()` prompt — Pyodide only checks
it while executing Python, so that case goes through the stdin channel's cancel state.
`channel.node.test.ts` covers this across real threads and needs the `node` environment,
declared in a per-file docblock (`environmentMatchGlobs` is silently ignored by Vitest 4).

Output is forwarded as **raw bytes**, not lines. `print("a", end="")` and `input("Name? ")`
both write without a newline, and a line-oriented handler puts the prompt above the cursor
instead of in front of it. The console keeps the newest 200k characters and drops the
oldest, like terminal scrollback.

## The editor

Monaco, behind `React.lazy` in `src/editor/CodeSurface.tsx`. `/join`, the class list and
the roster must never load it — they are the pages twelve children open at once on centre
wifi. It is a ~695 KB gzipped chunk.

Import `monaco-editor/editor/editor.api` plus the one grammar, **never the package root**:
the root is `editor.main`, which registers every language Monaco ships and drags in
TypeScript, CSS, HTML and JSON language workers — about 9 MB of build output to teach
Python. The odd-looking paths are explained in `monaco-subpaths.d.ts`; the package's
`exports` map rewrites `./*` to `./esm/vs/*`.

`src/editor/theme.ts` (`yogucode-night`) is the brand's dark theme rather than a default
VS Code one: a `night` (deep grape) ground, strawberry keywords, lemon strings, mint
built-ins, every colour at least 4.5:1. There is no error colour in it — a student's
unfinished code is not an error, and mistakes appear in the terminal in lemon (`not-yet`)
after they press Run.

**Monaco is uncontrolled after mount.** `value` is the initial document; the editor owns
the text thereafter, which is what keeps typing off the network. Anything mocking
`CodeSurface` must use `defaultValue`, or it is not testing the real contract.

## Saving a student's work

`src/editor/useAutosave.ts`: debounced ~2 s, skipped when nothing changed, flushed on file
switch and on `pagehide`. There is no Save button, because a nine-year-old will not press
one and §3.1's promise is "no lost files between weeks", not "if you remember".

A failed save is the one thing on that screen allowed to be **`system-error`** — it is
genuinely our fault, and a child typing into a page that silently discards their work is
the failure most worth shouting about. Saves are deliberately not retried: the usual cause is a revoked
session, and retrying hides it behind a spinner.

## The live classroom (`src/collab/`)

Each editor's text is a Yjs document, bound to Monaco by `monacoBinding.ts`. That file is
ours, not `y-monaco`: `y-monaco` imports the `monaco-editor` package root, which this
file's Editor section forbids. The binding needs only the text model, so it tests against
a fake model (`monacoBinding.test.ts`), including two people typing at once.

- **One child connection per page** (`studentLive()` in `socket.ts`), opened by
  `RequireStudent` and closed on sign-out. On every reconnect, each open editor resends
  its full state. A teacher's connection (`useLiveClass`) sends its token first and
  **never queues**: a flushed keystroke that beat the token would be read as a failed
  sign-in.
- **An edit that arrives from the teacher is flagged** (`binding.applyingRemote`), and
  recorded as `teacher_edit` rather than as the child's own `edit`.
- **Yjs, the live view and every page that imports them are lazy-loaded.** `/join` must
  not carry them.
- **Quizzes:** `RequireStudent` routes a child to `/quiz/:id` while one runs
  (`useActiveQuiz` plus the `quiz_started` / `quiz_ended` push). The server enforces the
  same thing, so the routing is for the child's benefit, not the security.
