# Coding-teaching-tool

Classroom platform for after-school coding academies with a browser-based Python editor
and per-concept mastery tracking.

The product is specified in [`docs/product-spec.md`](docs/product-spec.md). Phase 1 —
auth, centres, classes and roster — is the current work.

## Layout

```
apps/api/    FastAPI + SQLModel + Alembic, uv-managed
apps/web/    Vite + React + TypeScript + Tailwind v4
docs/        product spec
```

## System architecture

A React app talks to a FastAPI service over plain REST; the service owns a single
Postgres database. There are no microservices, no queues, no Redis and no server-side
code execution — student Python runs in the browser under Pyodide from Phase 2, which
removes sandboxing, resource limits and per-execution cost from the problem entirely.

Everything is hosted in or near Sydney. The data is Australian children's records, and
region is far easier to choose now than to migrate later.

```mermaid
flowchart TB
    subgraph browser["Browser — centre laptop, or home for homework"]
        teacher["Teacher<br/>class list · roster · PIN reset"]
        student["Student<br/>/join · editor from Phase 2"]
    end

    subgraph webapp["apps/web · Vite + React + TS — Vercel"]
        shell["App shell · TanStack Query · theme.css palette"]
    end

    subgraph apisvc["apps/api · FastAPI + SQLModel — Fly.io syd"]
        seam["get_current_principal()<br/><b>one seam, two verifiers</b>"]
        routes["Routers — centres · classes · roster · join · auth"]
    end

    auth["Supabase Auth<br/>magic link → JWT"]
    db[("Supabase Postgres · ap-southeast-2<br/>via Supavisor, transaction mode")]

    teacher -- "1 magic link" --> auth
    auth -- "2 JWT" --> teacher
    teacher --> shell
    student --> shell
    shell -- "Bearer JWT" --> seam
    shell -- "opaque session cookie<br/>httpOnly · Secure · SameSite=Lax" --> seam
    seam -. "verify signature<br/>against JWKS" .-> auth
    seam -- "Principal{centre_id, kind, subject}" --> routes
    routes -- "every query scoped by centre_id" --> db
```

### Two identity models, one authorisation seam

A Year 4 student has no email address and cannot be relied on to remember a password, so
teachers and students authenticate by different routes that converge on one object.

**Teachers** sign in through Supabase Auth by magic link. The browser holds the JWT; the
API verifies it against the project's JWKS endpoint. Only asymmetric algorithms are
accepted — the legacy HS256 shared secret is deliberately not implemented, because
accepting both families is where JWT algorithm-confusion bugs live. The key cache
refreshes on an unknown `kid` as well as on a timer, which is how a key rotation is
picked up without a redeploy, and those refreshes are rate-limited so a forged `kid`
cannot be used to drive traffic at Supabase.

Sign-in is gated by an email allowlist in config — without it, anyone who can request a
magic link on a public staging URL would provision a tenant. The allowlist is checked on
every request rather than only at signup, so removing an address actually revokes access.

**One academy is one centre.** The centre named in config is created by whoever signs in
first, who becomes its owner; every allowlisted teacher after that joins the same centre
as a teacher. A second teacher signing in must never produce a second tenant — they would
silently be unable to see each other's classes, and merging afterwards means moving rows
across the very boundary this design exists to keep intact. Provisioning happens only in
`POST /auth/teacher/session`, called once by the web app after the magic-link callback;
the auth dependency itself never writes.

**Students** never touch Supabase. A teacher builds the roster, sets each student's PIN
and hands out slips; the student picks their name behind a class join code and enters the
PIN. The API verifies the PIN against an Argon2id hash and mints an opaque session token,
storing only its SHA-256 hash and returning the token as an httpOnly cookie.

The session is opaque rather than a JWT for one reason: **it has to be revocable.** A
teacher kicking a session — wrong child logged in, laptop left signed in — must take
effect on the next request, not whenever a token happens to expire. Two clocks bound it:
12 hours absolute, so a session does not outlive the day on a shared centre laptop, and
90 minutes idle, so an abandoned laptop logs itself out. It still survives a browser
restart mid-lesson.

Both paths resolve into a `Principal` carrying `centre_id`, `kind` and subject id, and
every route authorises against `Principal.centre_id`. That is the tenancy boundary, and
it is the single most important thing in the system: a leak there is a leak of children's
data.

Four digits is a weak secret against the internet and an adequate one against the actual
adversary, a classmate — who also needs a valid class code and a roster entry. Lockout
after five failed attempts, per-IP rate limiting, and rejection of `0000`/`1234`/`1111`/
`1212` carry the rest.

### Data model

```mermaid
erDiagram
    centres ||--o{ users : employs
    centres ||--o{ classes : runs
    centres ||--o{ students : enrols
    centres ||--o{ concepts : "may override"
    centres ||--o{ audit_log : records
    classes ||--o{ class_teachers : "taught by"
    users   ||--o{ class_teachers : teaches
    classes ||--o{ enrolments : contains
    students ||--o{ enrolments : "joined via"
    classes ||--o{ class_join_codes : "found by"
    students ||--|| student_credentials : "PIN"
    students ||--o{ student_sessions : "signed in"
    concepts ||--o{ concepts : "parent of"
```

A **centre** is the tenancy root. It exists in an MVP serving one class because adding a
tenancy column later means backfilling every table and re-auditing every query.

**Students are not users.** Different identity model, different PII posture, different
lifecycle. Merging them would force nullable `email` and `supabase_user_id` on every row
and muddy every authorisation check. A student carries a display name and nothing else —
no email, no date of birth, no surname where a first name and last initial will do. Data
never collected never has to be protected, disclosed, or deleted.

**A student belongs to a centre, not to a class,** and is enrolled in classes term by
term. This is what lets mastery follow a child across terms in Phase 8. The alternative
resets a child's history every term.

**Nothing is deleted.** `status` columns throughout; withdrawal and archival are state
changes. `audit_log` records teacher actions on children's records — PIN resets, roster
changes, archival — because the Privacy Act makes them worth having and they cannot be
reconstructed afterwards.

**Primary keys are UUIDv7, generated in Python.** Time-sortable, so ids carry creation
order, and client-generatable, which Phase 6's offline event buffer needs: a laptop that
drops off centre wifi mid-lesson must be able to mint non-colliding event ids and flush
them later.

**The concept taxonomy is a table plus a YAML loader, not a hardcoded list.** Next term's
content is unconfirmed, so the content is deferred — but the mechanism is not. Swapping
the taxonomy must be a config edit, not a migration.

### Where development is now

Phase 1 of the plan in `~/Documents/Ken Nguyen/Startup/phase-1-plan.md`, which runs as
eleven steps. Backend is steps 1–8, frontend is 9, and 10–11 ship it.

| Step | | State |
|---|---|---|
| 1 | Scaffold + CI | **Done** |
| 2 | Database, models, first migration | **Done** |
| 3 | Teacher auth — JWKS verification, `Principal`, first-sign-in provisioning | **Done** |
| 4 | Centre + class CRUD | **Done** |
| 5 | Roster management, bulk name entry | Next |
| 6 | Join codes — 6 chars, unambiguous alphabet, rotate and revoke | Not started |
| 7 | Student PIN login — Argon2id, lockout, rate limiting | Not started |
| 8 | Concepts table + YAML seed loader | Not started |
| 9 | Frontend — four screens in the §8 palette | Not started |
| 10 | Deploy — Supabase `ap-southeast-2`, Fly.io `syd`, Vercel | Not started |
| 11 | Verify the join flow on a real centre laptop | Not started |

**What exists today:** the monorepo, CI, the eleven tables as one Alembic revision that
migrates clean from empty and downgrades back, teacher authentication (JWKS verification
with key caching, the `Principal` seam, `POST /auth/teacher/session`, `GET /auth/me`),
and class CRUD scoped to the centre — `GET /centre` plus create, list, read, rename,
archive and unarchive under `/classes`.

The tenancy boundary is now enforced rather than merely asserted. Every centre-owned
lookup goes through `src/app/scoping.py`; a router that wrote its own `select(Class)`
would be a bug. Deleting the filter fails three tests and only those, which is how we
know they have teeth.

The teacher half of the auth seam is real; the student half is a branch that refuses
until step 7. There is still no roster or join-code route, and no screens. The diagram
above is therefore partly the *designed* system: everything past step 4 is specified but
unbuilt.

Teacher auth is tested against a locally generated EC keypair and a stubbed JWKS
endpoint, so the cryptography is real but the issuer is not. Pointing it at the real
project at step 10 is a `SUPABASE_URL` change.

**Nothing is deployed.** No Supabase project, Fly app or Vercel project exists. Both
databases are local Postgres 16.

Phases 2–10 in `docs/product-spec.md` §7 add the Pyodide editor, the turtle shim, problems
and test cases, homework marking, event capture, quizzes, mastery and the teacher
dashboard. Phase 5 — homework submit and mark — is the milestone that matters; everything
before it is prerequisite.

## Local development

Requires [uv](https://docs.astral.sh/uv/), Node 22+, and PostgreSQL 16.

```bash
brew install postgresql@16
brew services start postgresql@16
createdb coding_tool_dev
createdb coding_tool_test
```

### API

```bash
cd apps/api
cp .env.example .env
uv sync
uv run alembic upgrade head
uv run uvicorn app.main:app --reload
```

Checks: `uv run ruff check .`, `uv run ruff format --check .`, `uv run pytest`.

The test suite migrates `coding_tool_test` from empty on every run and asserts the
models still match the migrations, so a schema change without a revision fails the
build.

After changing a model:

```bash
uv run alembic revision --autogenerate -m "what changed"
```

Ruff runs over the generated file automatically. Read it before committing —
autogenerate does not always get constraints right.

### Web

```bash
cd apps/web
npm install
npm run dev
```

Checks: `npm run typecheck`, `npm run test`, `npm run build`.

The §8 palette lives in `src/theme.css` as Tailwind theme tokens. One rule from the
spec is load-bearing: **never red for a student's incorrect answer** — amber means "not
yet", sage means correct, and rust is only for system errors.

### Database access

Homebrew's Postgres listens on a local unix socket and trusts the macOS account, so
there is no host, port, user or password to supply. This is also why `.env` carries a
bare `postgresql+asyncpg://localhost/coding_tool_dev` with no credentials in it.

```bash
psql -d coding_tool_dev       # develop against this one
psql -d coding_tool_test      # dropped and re-migrated by every pytest run — keep nothing here
```

Inside `psql`:

| | |
|---|---|
| `\dt` | list tables |
| `\d students` | one table — columns, indexes, CHECK constraints, foreign keys |
| `\di` | indexes |
| `\x` | toggle expanded rows, which makes wide rows readable |
| `\q` | quit |

`\d <table>` is the one that earns its keep: it is how you confirm a migration actually
created the constraint you meant, rather than trusting that autogenerate noticed.

Without opening the shell:

```bash
psql -d coding_tool_dev -c "select * from centres;"
psql -d coding_tool_dev -f script.sql
psql -d coding_tool_dev -tAc "select relname, n_live_tup from pg_stat_user_tables order by relname;"
```

A GUI is worth it once there is real data — TablePlus, Postico and DBeaver all connect
on `localhost:5432`, database `coding_tool_dev`, user is your macOS account, no
password. **Postman is not one of these**: it is an HTTP client and does not speak the
Postgres wire protocol. It is the right tool for the API from step 3 onward, and the
wrong tool for the database.

If the server stops answering:

```bash
brew services list                  # postgresql@16 should read "started"
brew services restart postgresql@16
```

#### On committing this

Documenting local access is not a disclosure. There is nothing secret in it: the
database is a socket on one laptop, reachable only by whoever is already logged into
that laptop, and it holds no data.

Three lines to hold as that stops being true:

- **Credentials never enter the repo.** The Supabase connection string, its password and
  the `service_role` key belong in `apps/api/.env` (gitignored) and in Fly.io and Vercel
  secrets. `.env.example` carries names and empty values only — keep it that way.
- **Direct psql against production bypasses `audit_log`.** That table exists because
  teacher actions on children's records are worth being able to reconstruct. A manual
  `UPDATE` leaves no trace of who did it or why. Prefer reading through the app, and
  when a manual fix is genuinely needed, write down what was run.
- **Production holds children's records.** Under the Privacy Act, a `select *` on
  `students` is a different act from one on `centres`. Pull what a task needs, not the
  table, and do not take extracts off the machine.
