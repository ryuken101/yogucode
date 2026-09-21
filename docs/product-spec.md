# Product Spec — Working title: *(TBD — Clarus / Kite / Meridian)*

A classroom platform for after-school coding academies: hosted Python editors,
problem sets, quizzes, and per-concept mastery tracking.

**Owner:** Ken
**First customer:** Magikid (Castle Hill) — Year 4–6 Python class
**Status:** Pre-development spec
**Last updated:** 19 September 2026

---

## 1. Problem

Observed directly while shadowing the Year 4–6 Python class at Magikid.

### 1.1 The presenting symptoms

- Students are hard to keep on task.
- Students don't retain previously taught concepts (e.g. `append()` for adding
  to a list).
- Curriculum keeps re-teaching basics, so progress is slow.

### 1.2 The actual mechanism

The lesson is 90 minutes: ~30–40 min instruction and class discussion, then
~50 min on a single coding problem while the teacher circulates.

One problem cannot serve a class with a wide skill spread:

- **Fast students** finish in ~15 minutes and idle for the rest of the lesson.
- **Slow students** never finish, so they never get the completion that
  consolidates the concept.
- Next term, basics are re-taught for everyone — which bores the fast students
  and still doesn't fix the slow ones, because re-teaching isn't what they
  needed.

This is self-reinforcing. **Idle time and unfinished work are the root cause;
poor retention and slow progress are the downstream effects.**

### 1.3 Secondary observations

- Homework and fortnightly quizzes run through Google Forms — students type
  Python into a plain text box, which doesn't match how they actually write code.
- Students use PyCharm, which has autocomplete. A student may never have typed
  `append` in full — they type `ap` and hit tab. This is a plausible cause of the
  retrieval failure: they recognise the method but can't produce it unaided.
- Flowcharts are taught on paper.

### 1.4 Retention hypothesis — test before building for it

Three different failure modes need different fixes:

| Failure mode | Symptom | Fix |
|---|---|---|
| Never encoded | Doesn't know lists can grow | Upstream — how it's taught |
| Encoded then forgotten | Knew it last month, not now | Spacing / cumulative review |
| Can't retrieve | Recognises `append()`, can't produce it | Retrieval practice without cues |

**Ten-minute test:** ask students to write "add the number 5 to the end of this
list" on paper, no computer, no IDE. Which mode dominates determines whether the
fix is curriculum, spacing, or turning off autocomplete.

---

## 2. Solution

One editor. Three surfaces — classwork, homework, quizzes. One mastery model.

Everything a student does is **an attempt at a tagged problem**. That single
invariant keeps the data model small and means all three surfaces feed one
picture of what each student knows.

### 2.1 Core loop

1. Teacher authors problems, tagged by concept and difficulty.
2. Students work in a browser editor — in class, at home, and in quizzes.
3. Every attempt produces both an outcome (marks, tests passed) and a process
   trace (edits, runs, errors).
4. Mastery per concept is computed per student.
5. Weak concepts resurface automatically in later problem sets and quizzes.
6. Teacher sees what to re-teach next lesson.

### 2.2 Design principles

- **Co-piloting, not surveillance.** The teacher helps a student's code; they
  don't watch a child's screen. This is better pedagogy *and* a far easier
  conversation with parents.
- **Signals, not grids.** A teacher running a room cannot watch ten live
  editors. Default view is "who is stuck right now"; live code is the
  drill-down.
- **Capture always, alert in class, diagnose after.** Three interfaces, one
  data stream.
- **Self-serve or it doesn't work.** A student stuck at minute 20 must be able
  to progress without the teacher, or the bottleneck is unchanged.

---

## 3. Features

### 3.1 Browser code editor — *foundation*

- Monaco editor, Python syntax highlighting.
- Runs Python client-side via Pyodide (see §5.1).
- Output console, error display.
- Work persists across sessions — no lost files between weeks.
- **Completions toggle.** On for classwork and homework, **off for quiz mode.**
  This is the sharpest feature in the product: autocomplete corrupts the
  retrieval signal, and it's a lever PyCharm cannot give the teacher.

### 3.2 Turtle support — *required for Year 4–6*

`import turtle` will not work in Pyodide (stdlib turtle wraps tkinter → Tcl/Tk,
no WASM build). Write a custom shim instead (see §5.2).

Falls out of building it:

- Canvas captured with the submission → visual marking, code and drawing
  side by side.
- Command stream recorded, not pixels → auto-checkable against a reference
  sequence, so turtle problems can have test cases like everything else.
- Class gallery of submitted drawings — strong motivator for this age group.

### 3.3 Problem sets — *the core fix for idle time*

Every lesson has a **ladder**, not a single problem:

- 1–2 × **1-dot** (easy) on today's concept
- 1 × **2-dot** (medium) — today's concept mixed with a prior concept
- 1 × **3-dot** (hard) extension

Everyone starts in the same place; nobody runs out of work.

**Difficulty and concept coverage are independent fields.** Dots = difficulty.
Tags = concepts. Don't conflate them — otherwise you can't author a hard
single-concept problem or a gentle cumulative one, and gentle cumulative
problems are exactly what a struggling student needs.

Dots are an *author's estimate*. After a term of data, recalculate from actual
unaided solve rate.

**Compound problem handling.** If a 3-dot problem needs loops → lists →
conditionals in sequence, a student shaky on loops never reaches the part that
drills lists. They score zero, learn nothing, and you get no diagnostic signal.
Two fixes:

- Break hard problems into independently attemptable parts (a/b/c), each with
  its own concept tag and mark.
- Provide starter code handling earlier steps, so the problem tests the target
  concept rather than everything at once.

### 3.4 Test cases and hints — *makes self-serve possible*

- Each problem carries test cases giving instant pass/fail feedback.
- Frame as **"3 of 5 passing"** and "not yet" — never a red X wall. For 10-year
  olds this is a large motivation and self-correction loop.
- **Hint ladder:** nudge → stronger hint → worked example. Student-unlockable.
- Gate hints behind a short timer or a required run attempt, or students will
  bottom out the ladder instead of thinking.

### 3.5 Homework — *the wedge, build this first*

Replaces Google Forms.

- Students write, run, and test real code instead of typing into a text box.
- Submission with deadline.
- Teacher marks manually with a **fixed rubric** — runs / correct / approach —
  same dimensions every time. Test cases handle correctness objectively, so
  human judgement is only about approach. Freehand marks out of 5 mean a
  student's trend partly measures the marker's mood.
- **Snippet bank** of canned feedback tied to common misconceptions.
- **Mark question-by-question across all students**, not student-by-student.
  Faster, far more consistent, enables feedback reuse. A tracker that takes 90
  minutes a fortnight gets abandoned by November.

Ships useful even if every other hypothesis in this document is wrong, and
generates process data as a byproduct with no monitoring conversation needed.

### 3.6 Quizzes — *fortnightly, start of lesson*

- Mixed MCQ + code-writing, matching the current format.
- **Quiz mode:** completions off, paste detection, full keystroke capture.
- **Misconception-encoded distractors.** Every wrong MCQ option should encode a
  *specific* wrong belief — e.g. for a `range(5)` trace, one option is the
  off-by-one answer, one is what you'd get if you thought range was inclusive,
  one is what you'd get if you thought the body ran once. Store which distractor
  was chosen. Then: "six students think range is inclusive — reteach Tuesday."
  Costs nothing but care in authoring; highest-leverage diagnostic in the product.

### 3.7 Concept tagging and mastery — *do this from day one*

**Every question carries a concept tag.** "14/20" is useless; "misses
loop-tracing in 4 of 5 quizzes, solid on conditionals" is a lesson plan. Cheap
up front, miserable to retrofit.

Keep the taxonomy small — **12–18 tags** for Year 4–6 Python:

```
variables · input/output · type casting · arithmetic · strings · indexing
comparison & boolean logic · conditionals · nesting · while loops · for loops
range · lists · list methods · functions · parameters · return · turtle basics
```

**Lift Magikid's scope and sequence verbatim if one exists** — then mastery data
maps directly onto lessons the boss already thinks in terms of.

Cautions:

- Per-concept mastery is more honest than an aggregate percentage — different
  quizzes have different difficulty, so a raw score trend is mostly noise. Keep
  a few **anchor questions** repeating across quizzes for comparability.
- **Three views of the same model:** teacher gets real data; student gets a
  mastery map where concepts light up; parents get something in between. A line
  chart of grades shown to a 10-year-old is demotivating.

### 3.8 Spaced review — *the actual answer to the retention problem*

If a student misses a concept, resurface it automatically 2–4 weeks later. Turns
the fortnightly quiz from assessment into intervention.

Nearly free once concepts are tagged, but requires one architectural choice:
**build a question bank with tags and difficulty and generate each quiz from
it** — don't author twenty standalone quizzes.

> **Warn the boss before shipping:** interleaving feels worse while it works.
> Mixed practice produces lower in-session performance and more frustration than
> blocked practice, and better retention weeks later. If marks dip in the first
> fortnight, that's the expected signature, not failure. Say this out loud in
> advance or the feature gets killed in week three.

### 3.9 Teacher dashboard — *build after homework works*

**Default view is a stuck-signal layer, not a grid of code:**

- Same error 4+ times
- No run in 5+ minutes
- No typing since lesson start
- Finished early

The teacher currently finds stuck students by luck of walking order — the quiet
kid who's stuck says nothing and gets reached at minute 40. This fixes exactly
that.

Live code view is the **drill-down** when a flag fires, plus the ability to edit
a student's file to demo or unblock.

### 3.10 Session replay — *diagnostic, after class*

Replay an attempt to see where a student stalled and what they tried. Feeds
§3.7 mastery and answers "what does this student need to work on."

> **Test cheaply before building this.** After a lesson, ask the teacher to name
> the three students who struggled and what specifically each got stuck on. Then
> compare to what actually happened. If teachers are already accurate, replay
> solves a problem they don't have — put the effort into homework and quizzes.

### 3.11 Deferred — not in v1

- **LLM problem generation.** Converts authoring into reviewing (~3–5× faster,
  not 50×). Worth building later. When built: constrain generation by concept
  taxonomy, auto-verify by executing the reference solution against generated
  tests, never auto-publish — queue for teacher approval. Best variation is
  on-demand *variants* of an existing problem (same structure, new numbers),
  which is low-risk and directly serves idle fast finishers. Note: generation
  is not a moat — the integration with curriculum, tagging and tracking is.
- **Advanced class support** (pygame, tkinter). See §5.3.
- **Flowchart tooling.** Keep on paper, or shift to plain-English steps as
  comments before coding — same skill, lives in the editor, reusable as
  scaffolding in starter code.
- **Native mobile apps.** This is a laptop product.

---

## 4. Non-goals

- Not a behaviour-monitoring or screen-surveillance tool. OS-level monitoring
  needs device ownership/MDM and is a different company.
- Not a school-district product yet. Procurement, privacy compliance and
  district approval make schools a different business, not a later stage.
- Not a project IDE. This is for **drills** — short problems, test cases,
  instant feedback. Multi-week game projects stay in PyCharm.
- Not an anti-cheat system. Process data makes AI-assisted work visible (a
  solution that appears in one paste has a distinctive shape) — decide what the
  teacher should see, but don't build a policing framing for 10-year-olds.

---

## 5. Technical decisions

### 5.1 Run Python in the browser

**Pyodide** — CPython compiled to WebAssembly, running in a Web Worker.

Removes the hardest infrastructure problem: no container sandboxing, no resource
limits, no per-execution cost, no security surface from executing untrusted code
written by children. Feedback is instant, which matters enormously for this age
group.

Constraint: pure-Python packages work; native extensions mostly don't.

If server-side execution is ever needed, add it as a **separate service**
(Judge0 self-hosted, or gVisor/Firecracker containers). Don't start there.

### 5.2 Turtle shim

Stdlib `turtle` → tkinter → Tcl/Tk → no WASM build. Won't run in Pyodide.

The API surface is small — roughly two dozen functions: `forward` `back` `left`
`right` `penup` `pendown` `goto` `color` `pensize` `circle` `begin_fill`
`end_fill` `speed` `setheading` `home` `clear`. All of them ultimately say "draw
a line from here to there."

**Build:** a Python module injected into the Pyodide environment that implements
those calls and emits drawing commands to a JS canvas. Students write
`import turtle` and it works. Estimated ~1 weekend.

Reference implementations worth reading (different runtimes, don't copy
directly): Skulpt, Brython, Trinket.

> **Verify first:** which turtle functions does the curriculum actually use? If
> it's basic movement and colour, the shim is a weekend. If it uses
> `screen.onkey`, `ontimer`, or event-driven turtle, that's meaningfully more
> work — find out before committing.

### 5.3 The advanced class boundary — out of scope, deliberately

| Library | Browser viability | Decision |
|---|---|---|
| Plain Python | Works in Pyodide | **In scope** |
| `turtle` | Custom shim required | **In scope** |
| `pygame` | Pygbag exists, but different runtime and requires async game loop — student code would differ from desktop | **Out of v1** |
| `tkinter` | No Tcl/Tk in WASM. Only path is server-side + virtual framebuffer + VNC streaming | **Out — not viable solo** |

The boundary is pedagogical as well as technical: the advanced class does
**projects**, this product is for **drills**, and projects have no meaningful
test cases. Advanced class keeps PyCharm for projects, optionally uses this
platform for homework drills and quizzes (plain Python, works fine).

This scope matches the original problem statement exactly — the retention and
idle-time problems are in the foundational class.

*(Pyodide and Pygbag both move fast — re-verify current capability before any
final decision.)*

### 5.4 Event capture schema — get this right early

Process data is append-only and **cannot be backfilled**. Design it first.

```
events
  id
  student_id
  problem_id
  session_id
  type          -- edit | run | error | test_result | hint_shown | submit
  payload       -- JSONB
  client_timestamp
  server_timestamp
```

- **Store edits as diffs, not full snapshots** — a 90-minute session of
  snapshots becomes megabytes.
- **Batch client-side, flush every few seconds.** Never POST per keystroke — it
  will melt the connection in a room of 12 kids on centre wifi.
- **Buffer locally so events survive a disconnect.** Centre and school wifi is
  unreliable; losing a student's session mid-lesson is the kind of bug that
  kills trust in the tool permanently.

Worth reading before finalising: **ProgSnap2**, a standard format for
programming process data — it'll tell you which events are worth capturing.
Also **Codeopticon** (Philip Guo, ~2015), prior art for one tutor monitoring
many learners' code live. Neither is a competitor; both save rediscovering the
obvious.

### 5.5 Real-time transport

WebSockets **only** for live view. Everything else — loading problems,
submitting, dashboards — is plain REST and will be simpler and more reliable.

Start with plain FastAPI WebSocket endpoints and an in-memory room-per-class
map. Add Redis pub/sub only when actually running more than one server process.

---

## 6. Tech stack

The optimal stack for a solo build on a term deadline is **the boring one you
already know**. Every hour learning a framework is an hour not spent writing
problems, which is the real bottleneck.

| Layer | Choice | Why |
|---|---|---|
| Frontend | React + TypeScript + Vite | Already known |
| Editor | **Monaco** | VS Code's editor; real Python support; **can disable completions** for quiz mode |
| | *(CodeMirror 6 as alternative)* | Lighter — better if student laptops are low-end. Check what machines they use. |
| Styling | Tailwind | Fast, pairs well with a tight palette |
| Server state | TanStack Query | |
| Python runtime | **Pyodide** in a Web Worker | §5.1 |
| Backend | **FastAPI** + SQLModel/SQLAlchemy | Already known |
| Database | **Postgres** (JSONB for event payloads) | Handles this scale comfortably |
| Migrations | Alembic | |
| Cache/pubsub | Redis — **only when needed** | Don't add before multi-process |
| Auth | **Clerk or Supabase Auth** | Children's accounts — do not roll your own session management. Zero product value, real risk. |
| Frontend host | Vercel | |
| API host | Fly.io or Railway | |
| DB host | Neon or Supabase | |

**Auth flow note:** needs to work for kids who can't reliably manage passwords —
teacher-generated **class codes** or magic links, not email/password.

**Region:** choose AU or US deliberately. Australian children's data now, a
potential US branch later. Data residency is far easier to get right at the
start than to migrate.

### Deliberately not building

Microservices · Kubernetes · GraphQL · event-streaming infrastructure ·
server-side code execution · LLM generation (v1) · mobile apps

---

## 7. Development timeline

Each phase is usable on its own and can go in front of a real class before the
next one starts. That matters more than any architectural decision here.

**Phase 0 — Before writing code (this week)**

- [ ] Confirm which turtle functions the curriculum uses
- [ ] Confirm what laptops students use (decides Monaco vs CodeMirror)
- [ ] Get Magikid's scope and sequence if one exists → concept taxonomy
- [ ] Baseline measurements (§9)
- [ ] Run the paper retrieval test (§1.4)

**Phase 1 — Auth + class setup** *(~1–2 weeks)*
Teacher accounts, class creation, student accounts via class code, roster.

**Phase 2 — Editor + Pyodide** *(~2 weeks)*
Monaco, run code, output console, error display, persistence. Completions
toggle.

**Phase 3 — Turtle shim** *(~1 week)*
Canvas rendering, command-stream capture. Test against real curriculum problems.

**Phase 4 — Problems + test cases** *(~2 weeks)*
Problem authoring, concept tags, dots, test cases, starter code, hint ladder,
pass/fail UI.

**Phase 5 — Homework: submit + mark** *(~2 weeks)* ← **first release to class**
Assignment, deadlines, submission, rubric marking UI (question-by-question),
snippet bank. **Ship this and use it for a full fortnight before continuing.**

**Phase 6 — Event capture** *(~1–2 weeks)*
Schema, client batching, offline buffer. Invisible to users; enables everything
after.

**Phase 7 — Quizzes** *(~2 weeks)*
MCQ + code, quiz mode (completions off, paste detection), distractor capture,
question bank with generation from tags.

**Phase 8 — Mastery + dashboard** *(~2–3 weeks)*
Per-concept computation, teacher view, student mastery map, parent view.

**Phase 9 — Spaced review** *(~1 week)*
Auto-resurface weak concepts in later sets and quizzes.

**Phase 10 — Live view + replay** *(~2–3 weeks)*
Stuck-signal layer first, live code drill-down second, session replay third.

**Realistic total: ~4–5 months part-time to Phase 8.** Phase 5 is the milestone
that matters — everything before it is prerequisite, everything after is
improvement.

> The software is the easy part. **Writing 100+ good problems** — each with test
> cases, a concept tag, starter code, hints and a worked solution — will take
> longer than the code and is the most likely reason this stalls. Budget for it
> explicitly. Have every teacher contribute into a shared bank rather than
> writing all of them yourself.

---

## 8. Colour palette

Direction: **soft sky and cream** — calm, warm, analog, unhurried.

Every kids' coding platform on the market is saturated primary colours and
cartoon mascots. This reads calm to a student and credible to a parent paying
the invoice — appropriate for a tool whose job is saying "here's where you are,
here's the next step" without making a child anxious about being behind.

```
Sky            #7B96D4    primary — headers, active states, key actions
Sky deep       #5A77B8    hover, emphasis, links
Sky pale       #C4D3EE    fills, selected rows, progress track
Cream          #F7F4ED    page background
Paper          #FFFDF8    cards, editor chrome, raised surfaces
Ink            #2C2A26    body text
Ink soft       #6B665E    secondary text, labels, metadata
Terracotta     #C1633F    accent — highlights, callouts (use sparingly)
Sage           #7D9471    success / tests passing
Amber          #D9A441    "not yet" / partial — NOT red
Rust           #A8503A    errors (system errors only, never student mistakes)
```

**Rules:**

- **Never use red for a student's incorrect answer.** Amber for "not yet",
  sage for correct. Red is reserved for system errors.
- Cream background, not white. Warmer and easier on the eyes for a 90-minute
  lesson.
- Serif for headings, sans for UI and body, monospace for code.
- Generous whitespace; restraint over decoration.
- Take the palette and the restraint — **not** cloud photography or
  serif-on-sky hero composition. Adjacent, not derivative.
- The editor needs its own considered theme in these colours. Don't drop a
  default dark VS Code theme into a cream page.

---

## 9. Success metrics — measure the baseline before building

You can't show improvement without a "before", and after the fact you'll
rationalise whatever happened. Collect these over the next few lessons — no code
required:

1. Minutes fast students spend idle per lesson
2. Homework completion rate
3. Per-concept quiz scores
4. Time the teacher spends marking per fortnight

These four numbers are the baseline, and later they are the pitch deck.

**Definition of success for v1:** idle time measurably down, homework completion
up, and the teacher still using it voluntarily in week 8.

---

## 10. Privacy and configurability

Two constraints that run through the design, cited from the code as "§10".

### Privacy and compliance

Minors' data. Australian Privacy Act and APPs, parental consent, retention
policy. If expanding to the US: COPPA and FERPA. A student is a display name
and nothing else — no email, no date of birth, a last initial rather than a
surname.

The co-piloting framing (§2.2) materially reduces this surface versus screen
monitoring.

### Put bias in config, not code

Concept taxonomy, lesson sequence, difficulty scale, problem bank, mastery
thresholds all live in editable data. **Test: can you configure the product for
Magikid's VEX IQ course without changing code?** Whatever has to be hardcoded
is exactly where the bias lives.
