# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Yogucode** (yogucode.com) — a classroom platform for after-school coding academies:
hosted Python editors, problem sets, quizzes, per-concept mastery tracking. First customer
is Magikid Castle Hill's Year 4–6 Python class. Yogucode is the product; the centre (a
customer) keeps its own name in `CENTRE_NAME`.

Two documents drive the work and both are worth reading before a substantial change:

- `docs/product-spec.md` — the product, in the repo.
- `~/Documents/Ken Nguyen/Startup/phase-1-plan.md` — **outside the repo**, by the owner's
  preference. Specs and phase plans live in `~/Documents/Ken Nguyen/Startup/`, not in
  `docs/`. `docs/product-spec.md` is a copy kept versioned with the code.
- **This repo is public.** The repo's spec copy deliberately omits the business sections
  (risks, market, next actions); the full text is
  `~/Documents/Ken Nguyen/Startup/product-spec-repo-full.md`. Strategy, pricing and
  customer notes stay in that folder, never in a commit.

The build is phased (spec §7). Each phase is usable on its own. The plan documents say
*why* a decision was made far more often than the code can; when the two disagree, ask
rather than assume the code is right.

## Environment

Local Postgres 16 via Homebrew — **both** `coding_tool_dev` and `coding_tool_test` must
exist or the test suite fails at the migration fixture. There is no Docker on this
machine. Ordinary `uv run` / `npm run` invocations are in `README.md` and the manifests.

**`alembic downgrade base` drops every table.** Never point it at `coding_tool_dev` — it
holds the signed-in teacher, their classes and their roster, and none of it comes back.
There is no need to: `tests/conftest.py` runs `downgrade base` then `upgrade head` against
`coding_tool_test` on every `pytest` invocation, so a migration is already proven both ways
by the suite. To do it by hand, aim it at the test database explicitly:

```bash
ALEMBIC_DATABASE_URL=postgresql+asyncpg://localhost/coding_tool_test \
  uv run alembic downgrade base && \
ALEMBIC_DATABASE_URL=postgresql+asyncpg://localhost/coding_tool_test \
  uv run alembic upgrade head
```

## Architecture

### Two identity models, one authorisation seam

This is the part that is expensive to get wrong, and it spans several files once built.

**Teachers** authenticate through Supabase Auth (email + password, email verified by link);
the API verifies the JWT against the project's JWKS endpoint. **A Supabase account is not
a teacher** — sign-up there is open to anyone. Only an address the owner invited
(`teacher_invites`, the owner-only `routers/teachers.py`) or one in the bootstrap
`TEACHER_EMAIL_ALLOWLIST` provisions a `users` row (`auth/provisioning.py`); after that
the active `users` row is the per-request gate, so the owner's Remove revokes on the next
request. Supabase's "Confirm email" must stay on: it is what proves an invitee owns the
address. **Students** never touch Supabase. They get an
app-issued opaque session token — `secrets.token_urlsafe(32)`, only its SHA-256 hash
stored in `student_sessions`, delivered as an httpOnly/Secure/SameSite=Lax cookie
(a browser-session cookie: no Max-Age).
Opaque rather than JWT **because it must be revocable**: a teacher kicking a session
(wrong child logged in, laptop left signed in) has to take effect on the next request.

Both resolve through one FastAPI dependency into a common `Principal` carrying
`centre_id`, `kind` (`teacher` | `student`) and subject id. **Every route authorises
against `Principal.centre_id`.** That is the tenancy boundary, and a leak there is a leak
of children's data — the authorisation tests matter more than any other tests in this
repo.

Deliberately *not* putting students in Supabase Auth: it would need synthetic email
identities plus server-held passwords driven by the `service_role` key — more moving
parts and a larger blast radius than an opaque cookie. The spec's "don't roll your own
session management" warning targets password reset, email verification and OAuth, none
of which exist for a student here.

### Data model conventions

All in `apps/api/src/app/models/`. `base.py` explains each; the short version:

- **UUIDv7 primary keys, generated in Python** (`uuid_utils.compat.uuid7`), stored as
  native Postgres `uuid`. Generation stays application-side because Phase 6's offline
  event buffer needs a disconnected laptop to mint non-colliding ids. Do not move this to
  a database default.
- **Status columns are `text` + `CHECK`, never Postgres `ENUM`** — these vocabularies
  will grow and `ALTER TYPE ... ADD VALUE` is awkward inside a migration. Python sees
  them as `StrEnum`; the field needs `sa_type=String` or SQLModel creates a native enum.
- **Timestamps are set in Python, not `func.now()`.** In Postgres `now()` is transaction
  start time, so a row inserted and updated in one transaction would show an unchanged
  `updated_at`. `server_default` is kept only for rows inserted by hand.
- **Archive, never delete.** `status` columns throughout, no cascading deletes. A student
  leaving mid-term must not vaporise a term of history.
- `metadata.naming_convention` is set in `base.py` before any table is defined. Explicit
  `CheckConstraint(name=...)` values are therefore *short* (`"status"`, not
  `"ck_students_status"`) — the convention adds the prefix.
- **A table not imported in `models/__init__.py` is invisible to Alembic.**

Two structural choices that look like duplication and are not: `students` is a separate
table from `users` (no email, no Supabase identity, different PII posture), and students
belong to a **centre**, not a class — enrolments are per-term, which is what lets mastery
follow a child across terms in Phase 8.

**Folders** (11 Oct 2026): `student_folders` / `teacher_folders` (parent_id tree), and
`folder_id` on both file tables. File and folder names are unique **per folder** (partial
unique indexes over `coalesce(folder_id, nil-uuid)`, since NULLs never collide). The rules
live once in `app/folders.py`, mounted twice by `routers/folders.py` (`/me/folders`,
`/teacher/folders`); every lookup filters on centre **and** owner. Deleting a folder
archives its whole branch and files.

**Delete entirely** (owner only, name typed to confirm) is the one exception to
archive-never-delete: `app/erase.py` removes a child's account and all their work, or a
class and its work (accounts and files stay), children-first in foreign-key order. A new
table pointing at `students` or `classes` must be added there. Audit rows stay, with any
`display_name` stripped from an erased child's.

**A problem's parts share one file** (Ken, 17 Oct 2026; `items.shared_file`, set by
"Split into parts"). The parent holds the starter and solution, and every part's checks run
against the whole file. Parts are still separate attempts, but saving any of them writes
the code to all of them (`routers/student_work.py`), so marking and hand-in are unchanged.
Problems made before this keep code per part. **Examples** (`items.examples`) are inputs
the teacher types. The teacher's browser runs the solution with them at Check solution,
and Publish stores the transcripts (`problem_bank.apply_transcripts`). A save keeps the
inputs only, since writing a run back would make it stale. A child is sent the transcript,
never the solution. My work's Lessons tab (`GET /me/problems`) lists lesson problems
already started, because Today shows only the current lesson.

**Help locks the child's editor** (`app/live/hub.py`, `Room.helping`): a teacher's
`{type: "help", on}` locks it; the last helper stopping — or their socket going — unlocks
it, and a reconnecting child is told the current state.

**`teacher_documents`** are a teacher's private "My code" files, scoped to the centre and
`user_id` (`scoping.get_own_teacher_document`): another teacher at the same centre gets a
404. A separate table from `student_documents` for the same reason `users` is separate from
`students`.

**Student accounts are username + PIN** (11 Oct 2026, `routers/join.py`): usernames are
unique system-wide, case-insensitive (`app/usernames.py` suggests them from the name).
Sign-in checks an Argon2id hash; since 16 Oct 2026 (Ken, reversing 11 Oct's hash-only
rule) a Fernet-encrypted copy sits beside it for **Show PIN** — any teacher at the centre,
one child per POST, `no-store`, audited as `pin.viewed`, never in a roster response. The
key is `PIN_ENCRYPTION_KEYS` (a Fly secret, comma-separated for rotation); unset turns
Show PIN off, and a PIN set without it can only be changed. No class code: the defences
are identical refusals for every failure, the per-child lockout, and a per-device limit
on wrong PINs (`app/auth/rate_limit.py`, in memory, failures only). A child in no active class gets a 403 after a correct PIN.

**Closing the app signs everyone out** (Ken's decision, 10 Oct 2026): teachers'
supabase-js session lives in `sessionStorage`; a child's session is tied to the tab they
signed in from by a `sessionStorage` marker (`apps/web/src/lib/tabSession.ts`), and
`useStudentMe` ends a session found in an unmarked tab. A second tab means signing in
again.

**Removing a child from a class** withdraws the enrolment (never deletes it) and revokes
their sessions — a session belongs to the student, not the class, so without that they
would keep working in a class they were taken out of. Archiving a class ("Remove
class") does the same for everyone enrolled in it. **`class_teachers` is
organisation, not permission:** every teacher at the centre can open every class (covering
a lesson must not need someone to add you first). The links drive the class page's
Teachers box (Lead/Assistant, any teacher may edit, at least one Lead kept,
`routers/class_teachers.py`) and `ClassOut.is_mine` for "My classes".

`centre_id` exists on nearly everything even though there is one centre today. Adding
tenancy later means backfilling every table and re-auditing every query.

### Migrations

`migrations/env.py` takes the URL from `DATABASE_URL`, or `ALEMBIC_DATABASE_URL` when
set — the test fixtures use the latter to point migrations at the test database.
`alembic.ini` carries no URL. Post-write hooks run `ruff check --fix` and `ruff format`
over each generated revision, so migrations are never a lint exception. Autogenerate
misses things (CHECK constraints, partial indexes) — read the generated file.

### Tests

`tests/conftest.py` migrates `coding_tool_test` from empty once per session, so a broken
migration fails the test run. Each test gets a session bound to a connection-level
transaction with `join_transaction_mode="create_savepoint"`, so a test's own rollback
(after an expected `IntegrityError`) does not tear down the fixture's transaction. Tests
roll back; they never commit.

`test_models_match_the_migrations` runs `alembic check` — a model changed without a
revision fails CI.

Use `sqlmodel.ext.asyncio.session.AsyncSession`, not SQLAlchemy's; only the former has
`.exec()`.

### Connection pooling

`db.py` uses `poolclass=NullPool`. Staging and production run through Supabase's
Supavisor pooler in transaction mode, which does its own pooling; a second pool on top
exhausts connections under trivial load. For the same reason asyncpg's statement caches
are off (`NO_STATEMENT_CACHE`, also used by `migrations/env.py`): in transaction mode a
statement prepared on one server connection may run on another. This is a known one-time
setup cost, not something to discover from intermittent failures.

### Frontend

The look is the Yogucode brand (Ken's choice, 10 Oct 2026; it supersedes spec §8's sky and
cream). **Never red for a student's incorrect answer** — `not-yet` (lemon) means "not yet",
`good` (mint) means correct, `system-error` (raspberry) is reserved for system errors, and
strawberry — the brand accent — is never a student's state. The rest of the frontend
conventions live in `apps/web/CLAUDE.md`, which loads when working under that directory.

**The UI is a desktop** (Ken's decision, 16 Oct 2026): top bar, app windows, dock, for
teachers and children both. Pages are unchanged; each belongs to one app
(`apps/web/src/desktop/apps.ts`) and opens in its window, and the URL is the front window's
page. A teacher's layout is saved in `desktop_layouts` (`routers/desktop.py`); a child's
windows are fixed full screen and never saved. A new page needs an owning app there, and
the teacher and student page lists (`routes/pages.tsx`) must share no path.

### Production: one app

`app.server:site` mounts the API (`app.main:app`) under `/api` and serves the built
website, adding the cross-origin isolation headers to every response. The `Dockerfile` and
`fly.toml` at the repo root deploy it as **one Fly.io app** (`magikid-code`, Sydney, always
on, one uvicorn worker — the live hub and quiz timers live in process memory).
`release_command` runs `alembic upgrade head` against Supabase on each deploy, upgrade
only. Never run a downgrade against production. **Exactly one machine**: the first
`fly deploy` creates two "for high availability", which would split a class across two
in-memory hubs — deploy with `--ha=false` and keep `fly scale count 1`. Every table has
**row-level security on with no policies** (migration `cce4cbf9b9f0`,
`test_every_table_has_row_level_security`): Supabase serves the public schema to its
`anon` role, and RLS is what keeps children's records unreadable with the public key.
A new table's migration must enable it. Secrets (`DATABASE_URL`, `SUPABASE_URL`,
`TEACHER_EMAIL_ALLOWLIST`, `PIN_ENCRYPTION_KEYS`) are Fly secrets that Ken sets himself;
they never go in the repo or in a chat.

**One public address: yogucode.com.** `CanonicalHost` in `app/server.py` 308s the hosts in
`REDIRECT_HOSTS` (www, the old fly.dev name) to `CANONICAL_HOST`, because sessions are
per host. It only redirects listed hosts — Fly's health check arrives by private IP and
must keep reaching the app. Auth emails come from `no-reply@yogucode.com` through Resend
as Supabase's SMTP (dashboard settings, no code); templates are in `docs/email-templates/`.
The README's "Domain and email" section has the DNS steps.

## Keeping the README current

`README.md` has a **System architecture** section with a diagram and a
"Where development is now" subsection. It is the project's reference point for how the
pieces fit and what exists yet. Update it when a phase completes or when the shape of
the system changes — new service, new boundary, a component moving between layers. It
does not need updating for an ordinary feature within a phase.
