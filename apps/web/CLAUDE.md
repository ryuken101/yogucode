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

**Closing the tab signs you out** (Ken's decision, 10 Oct 2026). Teachers: supabase-js
uses `sessionStorage`. Students: `markStudentTab()` on sign-in (`Join.tsx`), and
`useStudentMe` revokes and reports 401 for a session found in an unmarked tab — every
student page goes through it. Tests default to a marked tab (`test/setup.ts`);
`TabSession.test.tsx` covers the closed-tab case.

Students never talk to Supabase directly; `@supabase/supabase-js` is for teacher auth
only, and the `service_role` key must never appear in this app.

**Teacher auth screens** (email + password since 10 Oct 2026): `/sign-in` (with "Forgot
password?"), `/sign-up` (asks `signupAllowed` before creating a Supabase account),
`/reset-password`, and `/auth/callback`, where every sign-in finishes and the only place
that provisions. `lib/supabase.ts` maps Supabase's error codes to `AuthProblem`s: a wrong
password, an unverified email or an expired link is `not-yet`; only Supabase being
unreachable is `system-error`. `/teachers` is the owner's page (the Classes app's
Teachers tab, shown only to the owner; the API 403s everyone else).

## Two audiences, one app

Teacher pages sit behind `RequireTeacher` and children's behind `RequireStudent`; each guard
puts its pages on the desktop (below). `/join` is outside both: a child gets `JoinShell`
with no navigation, no sign-out and no centre name. The join flow must keep working when
Supabase is unconfigured or unreachable, because it does not use Supabase at all.

**The bare address `/` is the children's front door** (Ken's decision, 8 Oct 2026).
`Landing.tsx` sends a child who is still signed in to `/home` and a teacher with a session
to `/desk`, and otherwise shows the sign-in with a "Teacher? Sign in here" link to
`/sign-in`. `/join` remains as an alias.

## The desktop (`src/desktop/`)

Ken's decisions, 16 Oct 2026; the clickable prototype is the artifact "Yogucode Desktop".

- **Every page belongs to one app** (`apps.ts`: `owns` patterns, `home`, `tabs`). A link or
  `navigate()` anywhere just goes to a URL; `Desktop.tsx` opens that app's window, or brings
  it forward, showing the page. Windows render their page with `<Routes location={win.loc}>`
  over `routes/pages.tsx`, so screens need no desktop code. A new page needs an owner here.
- **The URL is the front window's page.** URL → window in an effect on the location;
  window → URL only inside `act()`, which runs the reducer (`windows.ts`) synchronously and
  navigates from its result. Never navigate from an effect watching the windows: it races
  the location effect and bounces the browser.
- **Teacher and student page lists share no path** — the router would send one audience to
  the other's guard. Hence `/my-files` and `/my-desk` for children.
- **Teachers** drag, resize and snap (local state in `Window.tsx` while dragging, so the page
  inside never re-renders), and the layout saves to `/me/desktop` ~0.8 s after it settles.
  The desktop starts in Live for the class in the top bar. **Children** cannot arrange
  windows, nothing is saved, and only the front window (or its layout group) is mounted —
  two mounted editors would both stream to the live view.
- The front window is a tinted title bar, never a shadow. Windows grow from their dock icon
  (`desktop.css`), with no animation under `prefers-reduced-motion`.
- **Files** (`Finder.tsx`) finds, opens and, since 17 Oct 2026, **organises**, as Finder
  or File Explorer does. It has a right-click menu (`ContextMenu.tsx`), naming in place,
  drag onto a folder or path crumb to move, Duplicate, and Cut/Copy/Paste (the clipboard
  is `clipboard.ts`, and Paste can cross places). The keys are F2, Delete, ⌘C/⌘X/⌘V, ⌘D
  and ⌘⇧N. Every place goes through `fileStore.ts`. A teacher may organise a child's files
  (`/students/{id}/...` writes, audited), but opens a file read-only
  (`routes/ChildFile.tsx`); changing what it says goes through Live's Help. Move rules
  (no folder into itself) live in `lib/folderTree.ts`, shared with the editor's explorer.

**Children sign in with a username and a PIN** (Ken's decision, 11 Oct 2026) — permanent
accounts the teacher creates on the class page (`StudentAccountDialogs.tsx`: Add a
student, Change PIN, Username). No class code and no name picker any more. A PIN is on
the slip when it is set, and since 16 Oct 2026 Show PIN on the roster reveals it again
(`routes/ShowPin.tsx`: one child, hidden after 30 s, audited on the server). Sign-in
errors are `not-yet` (lemon) — a wrong PIN, a lockout, a child in no class — and only an
unreachable server is `system-error`.

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

Checks come in three kinds (`grader.py`): `io` (prints), `function` (returns), and since
17 Oct 2026 **`script`**, the teacher's own Python check for answers that depend on values
the child chose. It gets `run(*inputs)`, which runs the child's program in fresh globals
and returns `(output, variables)`; `check(condition, message)`; and `contains()`. A missing
variable, a crash or too few inputs fail the check in a child's words. A mistake in the
check's own code shows as "tell your teacher" to a child, and as the real error on the
teacher's run (`reveal`, from `toChecks(..., { revealHidden })`). Templates are in
`problems/doc.ts` (`SCRIPT_TEMPLATES`), and YAML files write it as `check: |`.

Besides Run and Check there is **`example`** (`grader.run_example`, 17 Oct 2026). It runs a
program once, typing a list of inputs, and records the conversation as `out`/`in` pieces.
Unlike a check, the `input()` prompt is part of the output. The editor's Check solution
uses it for a problem's examples (`problems/verify.ts`). `components/ExampleRun.tsx` plays
the result back to a child, line by line and key by key, and shows it all at once when
reduced motion is asked for. Its colours are the console's: cream for output, lavender for
what was typed.

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

## Files and folders (My files, My code)

`components/FileExplorer.tsx` is the VS Code-style explorer both pages share: nested
folders, New file / New folder into the selected folder, rename (double-click or F2),
delete with a confirm, HTML5 drag-and-drop to move. `FileTabs` shows **only open files**
(`editor/useOpenTabs.ts`); × closes the tab, never the file. Creating a file writes it
into the cached list straight away so it can open as a tab before the refetch.

**A file's type is its name, as in VS Code** (`lib/fileType.ts`): `.py` (any case) is
Python — coloured and runnable; anything else is plain text, uncoloured, with Run disabled
and a hint to rename. New files are `untitled.py` (server-side default); existing files got
`.py` added by migration `258a4e916260`. Icons follow the type (`FileCode2` / `FileText`).

While a teacher helps, `useLiveDoc().locked` is true and the child's editor is read-only
with a calm `info` banner (Work, ProblemAttempt).

## My code (teachers' own files)

`routes/MyCode.tsx` (`/my-code`, the teacher's Code app) is a teacher's private scratch
files for demonstrating on the projector — the same `FileTabs`, `CodeSurface`, `Console`,
`usePython` and `useAutosave` as `Work.tsx`, but deliberately **no live-view stream and no
event recording** (those are about children). It is a separate page rather than a shared
component so the student page, which carries the live and recorder wiring, stays
untouched. **Present** goes full screen (Fullscreen API, with a fixed-overlay fallback;
Esc or Exit leaves), hides the tabs, and raises the editor to 24px (`CodeSurface`
`fontSize`) and the console to `large`.

## Saving a student's work

`src/editor/useAutosave.ts`: debounced ~2 s, skipped when nothing changed, flushed on file
switch and on `pagehide`. Saving never depends on a button, because a nine-year-old will
not press one and §3.1's promise is "no lost files between weeks", not "if you remember".
There is a Save button anyway (Ken, 17 Oct 2026; `editor/SaveControl.tsx`), plus ⌘/Ctrl+S,
which Monaco hands to `onSave` instead of the browser's Save page. Both are the same
flush. The label is honest: "Unsaved changes" during the wait (the `pending` state), then
"Saving…", then "Saved".

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
