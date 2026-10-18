"""A student's classwork: today's ladder, the problems on it, and their attempts.

All `/me/...`, for the reason `documents.py` gives: the subject comes from the session
cookie, so no route here has a student id to point at the wrong child. Assignments are
reached only through a class the child is actively enrolled in (`app.scoping`).

**What a child is sent, and what they are not.** The problem's prompt, starter code and
test cases — hidden ones included, because the tests run in their browser and a test
cannot be run without its expected value — and a custom check's code, for the same reason.
That is the accepted trade-off of running code client-side (spec §4: not an anti-cheat
product). Never sent: the reference solution, and
any hint rung they have not unlocked — with one exception: a "matches my solution" check
(Ken, 17 Oct 2026) has to run the solution in the child's browser, so it carries it,
scrambled (`problem_bank.with_reference`). Examples go as their transcripts only — what
the solution printed, never the solution.

**Saving to a file** (Ken's decision, 17 Oct 2026). The first Save on a problem asks where
in the child's Files to keep it; the attempt is then linked to that file
(`PUT /me/attempts/{id}/file`), and every save of the attempt writes the file too — so the
work is in their Files to find, and to open at home. One way: editing the file in Code
does not change the attempt, which stays what is checked and marked. During a quiz the
file is left alone, as all their files are.

**A shared-file problem is one program across its parts** (17 Oct 2026). Each part keeps
its own attempt — its checks, hints and marks are its own — but the code in them is one
file: it starts from the problem's starter, and saving any of them writes all of them, so
everything downstream that reads `attempt.code` (marking, hand-in, progress) is unchanged.

**The server decides hint unlocks.** A rung opens after enough runs or enough minutes on
the problem, whichever comes first (spec §3.4). `run_count` is counted here, from the
browser's report of each run, and the minutes from the attempt's own `created_at` — so a
child cannot unlock the worked example by editing a request, only by working.

Like documents, nothing here is audited: it is a child's own work on their own attempt.
"""

import uuid
from datetime import UTC, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, model_validator
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.auth.principal import CurrentStudent
from app.classwork import get_ladder, ladder_items, open_attempt
from app.db import get_session
from app.homework import hand_in, is_returned, latest_submissions, set_leaves
from app.models import (
    Assignment,
    AssignmentMode,
    AssignmentNote,
    AssignmentStatus,
    Attempt,
    AttemptStatus,
    DocumentStatus,
    Enrolment,
    EnrolmentStatus,
    Item,
    ItemKind,
    Lesson,
    Mark,
    SetItem,
    StudentDocument,
    SubmissionSource,
)
from app.models.base import utcnow
from app.problem_bank import (
    CompareTest,
    ExampleDoc,
    FunctionTest,
    IoTest,
    LeafDoc,
    ScriptTest,
    TranscriptLine,
    read_document,
    with_reference,
)
from app.quiz import is_running, running_quiz_for
from app.routers.documents import MAX_CONTENT_BYTES
from app.scoping import (
    get_own_attempt,
    get_owned_document,
    get_student_assignment,
    get_student_class,
)

router = APIRouter(prefix="/me", tags=["student work"])

SessionDep = Annotated[AsyncSession, Depends(get_session)]


# --- shapes -------------------------------------------------------------------------


class LadderProblemOut(BaseModel):
    item_id: uuid.UUID
    title: str
    difficulty: int
    part_labels: list[str]
    progress: Literal["not_started", "started", "passing"]


class TodayOut(BaseModel):
    """Today, for one child: their class, the lesson it is on, and its ladder."""

    class_name: str
    lesson_title: str | None
    assignment_id: uuid.UUID | None
    problems: list[LadderProblemOut]


class AttemptOut(BaseModel):
    id: uuid.UUID
    code: str
    status: AttemptStatus
    run_count: int
    last_passed: int | None
    last_total: int | None
    choice: int | None
    # The file in their Files this work is also saved to, once they have chosen one.
    document_id: uuid.UUID | None = None

    @classmethod
    def build(cls, attempt: Attempt) -> "AttemptOut":
        return cls(
            id=attempt.id,
            code=attempt.code,
            document_id=attempt.document_id,
            choice=attempt.choice,
            status=attempt.status,
            run_count=attempt.run_count,
            last_passed=attempt.last_passed,
            last_total=attempt.last_total,
        )


class UnlockedHintOut(BaseModel):
    level: int
    body_md: str


class NextHintOut(BaseModel):
    """The next rung, without its text. `available` is the server's verdict right now."""

    level: int
    available: bool
    runs_needed: int
    seconds_needed: int


def transcripts(examples: list[ExampleDoc]) -> list[list[TranscriptLine]]:
    """The examples a child can watch: those with a run on them, as the run alone."""
    return [example.transcript for example in examples if example.transcript]


class StudentLeafOut(BaseModel):
    item_id: uuid.UUID
    label: str | None
    prompt_md: str
    tests: list[IoTest | FunctionTest | ScriptTest | CompareTest]
    examples: list[list[TranscriptLine]]
    hints: list[UnlockedHintOut]
    next_hint: NextHintOut | None
    attempt: AttemptOut


class StudentProblemOut(BaseModel):
    assignment_id: uuid.UUID
    item_id: uuid.UUID
    kind: ItemKind
    title: str
    prompt_md: str
    difficulty: int
    mode: AssignmentMode
    completions: bool
    # Whether this child may press Check — off during a quiz unless the teacher allowed it.
    checks: bool
    # Multiple choice: the answers' texts, in order — never which is right, never the
    # misconceptions. Those are for the teacher.
    options: list[str]
    # Examples of the whole program, shown above the parts.
    examples: list[list[TranscriptLine]]
    # One file for every part: `file_attempt_id` is the attempt the editor saves to.
    shared_file: bool
    file_attempt_id: uuid.UUID | None
    leaves: list[StudentLeafOut]


class ChoiceIn(BaseModel):
    choice: int = Field(ge=0, lt=8)


class AttemptSaveIn(BaseModel):
    code: str = Field(max_length=MAX_CONTENT_BYTES)


class RunIn(BaseModel):
    """One press of Run (no result) or Check (with a result)."""

    passed: int | None = Field(default=None, ge=0, le=100)
    total: int | None = Field(default=None, ge=0, le=100)

    @model_validator(mode="after")
    def _consistent(self) -> "RunIn":
        if (self.passed is None) != (self.total is None):
            raise ValueError("send both passed and total, or neither")
        if self.passed is not None and self.total is not None and self.passed > self.total:
            raise ValueError("passed cannot be more than total")
        return self


# --- helpers ------------------------------------------------------------------------


def _hint_state(leaf: LeafDoc, attempt: Attempt, hints_on: bool):
    if not hints_on:
        return [], None
    unlocked = [
        UnlockedHintOut(level=level, body_md=hint.body_md)
        for level, hint in enumerate(leaf.hints[: attempt.hints_unlocked], start=1)
    ]
    if attempt.hints_unlocked >= len(leaf.hints):
        return unlocked, None
    nxt = leaf.hints[attempt.hints_unlocked]
    waited = (utcnow() - attempt.created_at).total_seconds()
    return unlocked, NextHintOut(
        level=attempt.hints_unlocked + 1,
        available=attempt.run_count >= nxt.unlock_after_runs or waited >= nxt.unlock_after_seconds,
        runs_needed=max(0, nxt.unlock_after_runs - attempt.run_count),
        seconds_needed=max(0, int(nxt.unlock_after_seconds - waited)),
    )


async def _item_in_assignment(
    session: AsyncSession, principal: CurrentStudent, assignment: Assignment, item_id: uuid.UUID
) -> Item:
    """A top-level problem that is on this assignment's set, or 404."""
    found = (
        await session.exec(
            select(Item)
            .join(SetItem, col(SetItem.item_id) == Item.id)
            .where(
                SetItem.set_id == assignment.set_id,
                Item.id == item_id,
                Item.centre_id == principal.centre_id,
                col(Item.parent_id).is_(None),
            )
        )
    ).one_or_none()
    if found is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="problem not found")
    return found


async def _attempts_for(
    session: AsyncSession, principal: CurrentStudent, assignment_id: uuid.UUID
) -> dict[uuid.UUID, Attempt]:
    rows = (
        await session.exec(
            select(Attempt).where(
                Attempt.assignment_id == assignment_id,
                Attempt.student_id == principal.subject_id,
                Attempt.centre_id == principal.centre_id,
            )
        )
    ).all()
    return {row.item_id: row for row in rows}


async def _writable_attempt(
    session: AsyncSession, principal: CurrentStudent, attempt_id: uuid.UUID
) -> tuple[Attempt, Assignment]:
    """An attempt the child may still change: theirs, in an open assignment of their class,
    and — for homework — not yet returned to them.

    Handing in does *not* lock it: a child may carry on and hand in again until their
    teacher returns the work (Ken's decision). Returning it does.
    """
    attempt = await get_own_attempt(session, principal, attempt_id)
    assignment = await get_student_assignment(session, principal, attempt.assignment_id)
    await _quiz_lock(session, principal, assignment)
    if assignment.mode == AssignmentMode.HOMEWORK and await is_returned(
        session, principal, assignment, principal.subject_id
    ):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Your teacher has given this one back, so it can't be changed now",
        )
    return attempt, assignment


async def _quiz_lock(
    session: AsyncSession, principal: CurrentStudent, assignment: Assignment
) -> None:
    """While the class sits a quiz, the quiz is the only work a child can open or change;
    once its time is up, not even that (Ken's decision: only the quiz is reachable)."""
    running = await running_quiz_for(session, principal)
    if running is not None and running.id != assignment.id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="A quiz is running — finish it first"
        )
    if assignment.mode == AssignmentMode.QUIZ and not is_running(assignment):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Time's up for this quiz")


# --- routes -------------------------------------------------------------------------


@router.get("/lesson", response_model=TodayOut)
async def todays_lesson(principal: CurrentStudent, session: SessionDep) -> TodayOut:
    """The child's class, today's lesson, and its ladder with their progress on each rung."""
    return await _today(session, principal)


async def _today(session: AsyncSession, principal: CurrentStudent) -> TodayOut:
    klass = await get_student_class(session, principal)
    if klass is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="no class")
    empty = TodayOut(class_name=klass.name, lesson_title=None, assignment_id=None, problems=[])
    if klass.current_lesson_id is None:
        return empty
    lesson = await session.get(Lesson, klass.current_lesson_id)
    if lesson is None or lesson.centre_id != principal.centre_id:
        return empty
    empty.lesson_title = lesson.title
    ladder = await get_ladder(session, principal, lesson)
    if ladder is None:
        return empty
    assignment = (
        await session.exec(
            select(Assignment).where(
                Assignment.class_id == klass.id,
                Assignment.set_id == ladder.id,
                Assignment.mode == AssignmentMode.CLASSWORK,
                Assignment.status == AssignmentStatus.OPEN,
                Assignment.centre_id == principal.centre_id,
            )
        )
    ).one_or_none()
    if assignment is None:
        return empty

    attempts = await _attempts_for(session, principal, assignment.id)
    problems = []
    for item in await ladder_items(session, principal, ladder.id):
        parts = (
            await session.exec(
                select(Item)
                .where(Item.parent_id == item.id, Item.centre_id == principal.centre_id)
                .order_by(col(Item.sort_order))
            )
        ).all()
        leaves = list(parts) or [item]
        mine = [attempts[leaf.id] for leaf in leaves if leaf.id in attempts]
        passing = len(mine) == len(leaves) and all(
            a.last_total and a.last_passed == a.last_total for a in mine
        )
        problems.append(
            LadderProblemOut(
                item_id=item.id,
                title=item.title,
                difficulty=item.difficulty,
                part_labels=[p.part_label or "" for p in parts],
                progress="passing" if passing else "started" if mine else "not_started",
            )
        )
    return TodayOut(
        class_name=klass.name,
        lesson_title=lesson.title,
        assignment_id=assignment.id,
        problems=problems,
    )


@router.post("/assignments/{assignment_id}/items/{item_id}/open", response_model=StudentProblemOut)
async def open_problem(
    assignment_id: uuid.UUID, item_id: uuid.UUID, principal: CurrentStudent, session: SessionDep
) -> StudentProblemOut:
    """A problem as the child sees it, with their attempt at each part.

    A POST because the first open creates the attempts — which is also what starts the
    clock the hint ladder's minutes are measured from.
    """
    assignment = await get_student_assignment(session, principal, assignment_id)
    await _quiz_lock(session, principal, assignment)
    item = await _item_in_assignment(session, principal, assignment, item_id)
    doc, part_rows = await read_document(session, principal, item)
    leaf_rows = part_rows or [item]
    leaf_docs: list[tuple[LeafDoc, str | None, str]] = (
        [(part, part.label, part.prompt_md) for part in doc.parts]
        if part_rows
        else [(doc, None, "")]
    )
    # A shared file starts from the problem's starter; per-part code from each part's own.
    starter = item.starter_code if doc.shared_file else None
    attempts = [
        await open_attempt(session, principal, assignment, row, starter=starter)
        for row in leaf_rows
    ]
    await session.commit()

    hints_on = bool(assignment.settings.get("hints", True))
    leaves = []
    for row, (leaf, label, prompt), attempt in zip(leaf_rows, leaf_docs, attempts, strict=True):
        hints, next_hint = _hint_state(leaf, attempt, hints_on)
        leaves.append(
            StudentLeafOut(
                item_id=row.id,
                label=label,
                prompt_md=prompt,
                tests=with_reference(
                    leaf.tests, item.solution_code if doc.shared_file else leaf.solution_code
                ),
                examples=transcripts(leaf.examples),
                hints=hints,
                next_hint=next_hint,
                attempt=AttemptOut.build(attempt),
            )
        )
    return StudentProblemOut(
        assignment_id=assignment.id,
        item_id=item.id,
        kind=item.kind,
        checks=bool(assignment.settings.get("checks", True)),
        options=[option.text for option in doc.options],
        title=item.title,
        prompt_md=doc.prompt_md,
        difficulty=item.difficulty,
        mode=assignment.mode,
        completions=bool(assignment.settings.get("completions", True)),
        examples=transcripts(doc.examples),
        shared_file=doc.shared_file,
        file_attempt_id=attempts[0].id if doc.shared_file else None,
        leaves=leaves,
    )


@router.patch("/attempts/{attempt_id}", response_model=AttemptOut)
async def save_attempt(
    attempt_id: uuid.UUID, body: AttemptSaveIn, principal: CurrentStudent, session: SessionDep
) -> AttemptOut:
    """Autosave. Like a file save, a save that changes nothing writes nothing."""
    attempt, _ = await _writable_attempt(session, principal, attempt_id)
    if body.code != attempt.code:
        for row in await _same_file(session, principal, attempt):
            row.code = body.code
            session.add(row)
        await _write_linked_file(session, principal, attempt, body.code)
        await session.commit()
        await session.refresh(attempt)
    return AttemptOut.build(attempt)


async def _write_linked_file(
    session: AsyncSession, principal: CurrentStudent, attempt: Attempt, code: str
) -> None:
    """Keep the file this work is saved to the same as the work. A file since deleted ends
    the link; a running quiz leaves it alone, since files are locked during one."""
    if attempt.document_id is None:
        return
    document = (
        await session.exec(
            select(StudentDocument).where(
                StudentDocument.id == attempt.document_id,
                StudentDocument.student_id == principal.subject_id,
                StudentDocument.centre_id == principal.centre_id,
            )
        )
    ).one_or_none()
    if document is None or document.status != DocumentStatus.ACTIVE:
        for row in await _same_file(session, principal, attempt):
            row.document_id = None
            session.add(row)
        return
    if await running_quiz_for(session, principal) is not None:
        return
    if document.content != code:
        document.content = code
        session.add(document)


class FileLinkIn(BaseModel):
    """The child's file to keep this work in, or null to stop."""

    document_id: uuid.UUID | None


@router.put("/attempts/{attempt_id}/file", response_model=AttemptOut)
async def link_file(
    attempt_id: uuid.UUID, body: FileLinkIn, principal: CurrentStudent, session: SessionDep
) -> AttemptOut:
    """Save this work to one of the child's own files, from now on (the Save window).

    The file is written straight away with the work as it is. Only a live file of their own
    can be chosen — another child's is a 404, as everywhere.
    """
    attempt, _ = await _writable_attempt(session, principal, attempt_id)
    if body.document_id is not None:
        document = await get_owned_document(session, principal, body.document_id)
        if document.status != DocumentStatus.ACTIVE:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="document not found")
    for row in await _same_file(session, principal, attempt):
        row.document_id = body.document_id
        session.add(row)
    await _write_linked_file(session, principal, attempt, attempt.code)
    await session.commit()
    await session.refresh(attempt)
    return AttemptOut.build(attempt)


async def _same_file(
    session: AsyncSession, principal: CurrentStudent, attempt: Attempt
) -> list[Attempt]:
    """The attempts holding the same file as this one: itself, plus — for a part of a
    shared-file problem — the child's attempts at the other parts in this assignment."""
    item = await session.get(Item, attempt.item_id)
    parent = await session.get(Item, item.parent_id) if item and item.parent_id else None
    if parent is None or not parent.shared_file:
        return [attempt]
    siblings = (
        await session.exec(
            select(Attempt)
            .join(Item, col(Item.id) == Attempt.item_id)
            .where(
                Item.parent_id == parent.id,
                Attempt.assignment_id == attempt.assignment_id,
                Attempt.student_id == principal.subject_id,
                Attempt.centre_id == principal.centre_id,
            )
        )
    ).all()
    return list({row.id: row for row in [attempt, *siblings]}.values())


@router.put("/attempts/{attempt_id}/choice", response_model=AttemptOut)
async def choose(
    attempt_id: uuid.UUID, body: ChoiceIn, principal: CurrentStudent, session: SessionDep
) -> AttemptOut:
    """Pick an answer to a multiple-choice question. Changeable until handed in or time is up."""
    attempt, _ = await _writable_attempt(session, principal, attempt_id)
    item = await session.get(Item, attempt.item_id)
    if item is None or item.kind != ItemKind.MCQ or body.choice >= len(item.options):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="No such answer"
        )
    if attempt.choice != body.choice:
        attempt.choice = body.choice
        session.add(attempt)
        await session.commit()
        await session.refresh(attempt)
    return AttemptOut.build(attempt)


@router.post("/attempts/{attempt_id}/runs", response_model=AttemptOut)
async def record_run(
    attempt_id: uuid.UUID, body: RunIn, principal: CurrentStudent, session: SessionDep
) -> AttemptOut:
    """Count a Run or a Check. A Check also records how many tests passed.

    The result is the browser's word, and is used for the teacher's progress view, never
    for marks: homework is re-run in the teacher's browser at marking time (Phase 5).
    """
    attempt, _ = await _writable_attempt(session, principal, attempt_id)
    attempt.run_count += 1
    if body.total is not None:
        attempt.last_passed = body.passed
        attempt.last_total = body.total
    session.add(attempt)
    await session.commit()
    await session.refresh(attempt)
    return AttemptOut.build(attempt)


@router.post("/attempts/{attempt_id}/hints", response_model=StudentLeafOut)
async def unlock_hint(
    attempt_id: uuid.UUID, principal: CurrentStudent, session: SessionDep
) -> StudentLeafOut:
    """Unlock the next rung, if the child has earned it. Rungs open in order."""
    attempt, assignment = await _writable_attempt(session, principal, attempt_id)
    if not assignment.settings.get("hints", True):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="No hints here")
    # The attempt is the child's own (scoping), and an attempt's item is always in its
    # centre — written by `_open_attempt` from an item that came through scoping.
    leaf = await session.get(Item, attempt.item_id)
    parent = await session.get(Item, leaf.parent_id) if leaf and leaf.parent_id else leaf
    if leaf is None or parent is None:  # pragma: no cover — foreign keys forbid it
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="problem not found")
    doc, part_rows = await read_document(session, principal, parent)
    leaf_doc, label, prompt = (
        next(
            (p, p.label, p.prompt_md)
            for p, row in zip(doc.parts, part_rows, strict=True)
            if row.id == leaf.id
        )
        if leaf.parent_id
        else (doc, None, "")
    )

    _, next_hint = _hint_state(leaf_doc, attempt, hints_on=True)
    if next_hint is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="That was the last hint")
    if not next_hint.available:
        minutes = max(1, round(next_hint.seconds_needed / 60))
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Not yet — try running your code, or wait about {minutes} more "
            f"minute{'s' if minutes != 1 else ''}.",
        )
    attempt.hints_unlocked += 1
    session.add(attempt)
    await session.commit()
    await session.refresh(attempt)

    hints, next_hint = _hint_state(leaf_doc, attempt, hints_on=True)
    return StudentLeafOut(
        item_id=leaf.id,
        label=label,
        prompt_md=prompt,
        tests=with_reference(
            leaf_doc.tests, doc.solution_code if doc.shared_file else leaf_doc.solution_code
        ),
        examples=transcripts(leaf_doc.examples),
        hints=hints,
        next_hint=next_hint,
        attempt=AttemptOut.build(attempt),
    )


# --- homework -----------------------------------------------------------------------
#
# A child sees their homework as a sheet: each problem (each part, for problems with parts),
# how far they have got, whether they have handed in, and — once their teacher returns it —
# a comment and a colour per question. Never a number (spec §3.7): sage for Correct 2,
# amber for anything less.


class FeedbackOut(BaseModel):
    code: str
    # Multiple choice: the answer they picked, in words.
    answer: str | None = None
    comment_md: str
    outcome: Literal["good", "not_yet"]


class SheetLeafOut(BaseModel):
    problem_id: uuid.UUID
    leaf_item_id: uuid.UUID
    title: str
    difficulty: int
    attempt_id: uuid.UUID | None
    progress: Literal["not_started", "started", "passing"]
    handed_in: bool
    changed_since_hand_in: bool
    feedback: FeedbackOut | None


class SheetOut(BaseModel):
    assignment_id: uuid.UUID
    title: str
    due_at: datetime | None
    closed: bool
    returned: bool
    late: bool
    handed_in_at: datetime | None
    note: str | None
    leaves: list[SheetLeafOut]


class HomeworkCardOut(BaseModel):
    assignment_id: uuid.UUID
    mode: AssignmentMode
    title: str
    due_at: datetime | None
    closed: bool
    problems: int
    started: int
    handed_in_at: datetime | None
    changed_since_hand_in: bool
    late: bool
    returned: bool


class HomeOut(BaseModel):
    today: TodayOut
    homework: list[HomeworkCardOut]


class HandInResult(BaseModel):
    attempt_id: uuid.UUID
    passed: int = Field(ge=0, le=100)
    total: int = Field(ge=0, le=100)


class HandInIn(BaseModel):
    results: list[HandInResult] = Field(default_factory=list, max_length=100)


def _answer_text(item: Item, choice: int | None) -> str | None:
    if item.kind != ItemKind.MCQ or choice is None or not 0 <= choice < len(item.options):
        return None
    return str(item.options[choice].get("text", ""))


async def _sheet(
    session: AsyncSession, principal: CurrentStudent, assignment: Assignment
) -> SheetOut:
    leaves = await set_leaves(session, principal, assignment.set_id)
    attempts = await _attempts_for(session, principal, assignment.id)
    mine = [attempts[leaf.leaf.id] for leaf in leaves if leaf.leaf.id in attempts]
    submissions = await latest_submissions(session, principal, [a.id for a in mine])
    hand_ins = [s for s in submissions.values() if s.source == SubmissionSource.HAND_IN]
    returned = await is_returned(session, principal, assignment, principal.subject_id)

    marks: dict[uuid.UUID, Mark] = {}
    note: str | None = None
    if returned:
        # Only *released* marks, and only now: a child must never see a mark their
        # teacher is still deciding on.
        marks = {
            m.attempt_id: m
            for m in (
                await session.exec(
                    select(Mark).where(
                        col(Mark.attempt_id).in_([a.id for a in mine]),
                        col(Mark.released_at).is_not(None),
                    )
                )
            ).all()
        }
        released_note = (
            await session.exec(
                select(AssignmentNote).where(
                    AssignmentNote.assignment_id == assignment.id,
                    AssignmentNote.student_id == principal.subject_id,
                    col(AssignmentNote.released_at).is_not(None),
                )
            )
        ).one_or_none()
        note = released_note.note if released_note and released_note.note else None

    out = []
    for leaf in leaves:
        attempt = attempts.get(leaf.leaf.id)
        submission = submissions.get(attempt.id) if attempt else None
        handed = submission is not None and submission.source == SubmissionSource.HAND_IN
        mark = marks.get(attempt.id) if attempt else None
        # A multiple-choice answer is never shown as "passing": that would give it away.
        passing = bool(
            attempt
            and leaf.leaf.kind != ItemKind.MCQ
            and attempt.last_total
            and attempt.last_passed == attempt.last_total
        )
        out.append(
            SheetLeafOut(
                problem_id=leaf.problem.id,
                leaf_item_id=leaf.leaf.id,
                title=leaf.label,
                difficulty=leaf.leaf.difficulty,
                attempt_id=attempt.id if attempt else None,
                progress="passing" if passing else "started" if attempt else "not_started",
                handed_in=handed,
                changed_since_hand_in=bool(handed and attempt and attempt.code != submission.code),
                feedback=FeedbackOut(
                    code=submission.code if submission else (attempt.code if attempt else ""),
                    answer=_answer_text(leaf.leaf, submission.choice if submission else None),
                    comment_md=mark.comment_md,
                    outcome="good" if mark.correct == 2 else "not_yet",
                )
                if mark
                else None,
            )
        )
    return SheetOut(
        assignment_id=assignment.id,
        title=assignment.title,
        due_at=assignment.due_at,
        closed=assignment.status == AssignmentStatus.CLOSED,
        returned=returned,
        late=any(s.late for s in hand_ins),
        handed_in_at=max((s.submitted_at for s in hand_ins), default=None),
        note=note,
        leaves=out,
    )


async def _student_homework(
    session: AsyncSession, principal: CurrentStudent, assignment_id: uuid.UUID
) -> Assignment:
    assignment = await get_student_assignment(
        session, principal, assignment_id, include_closed=True
    )
    # A quiz's sheet is read the same way: its questions while it runs, its feedback after.
    if assignment.mode not in (AssignmentMode.HOMEWORK, AssignmentMode.QUIZ):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="homework not found")
    return assignment


@router.get("/homework/{assignment_id}", response_model=SheetOut)
async def read_sheet(
    assignment_id: uuid.UUID, principal: CurrentStudent, session: SessionDep
) -> SheetOut:
    assignment = await _student_homework(session, principal, assignment_id)
    return await _sheet(session, principal, assignment)


@router.post("/homework/{assignment_id}/hand-in", response_model=SheetOut)
async def hand_in_sheet(
    assignment_id: uuid.UUID, body: HandInIn, principal: CurrentStudent, session: SessionDep
) -> SheetOut:
    """Hand in the whole sheet. Allowed late; allowed again; not allowed once returned."""
    assignment = await _student_homework(session, principal, assignment_id)
    if assignment.mode != AssignmentMode.HOMEWORK:
        # A quiz is handed in by its clock, for everyone at once.
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="A quiz hands itself in")
    if assignment.status != AssignmentStatus.OPEN:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Your teacher has closed this homework",
        )
    if await is_returned(session, principal, assignment, principal.subject_id):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Your teacher has already given this one back",
        )
    await hand_in(
        session,
        principal,
        assignment,
        {r.attempt_id: (min(r.passed, r.total), r.total) for r in body.results},
    )
    await session.commit()
    return await _sheet(session, principal, assignment)


@router.get("/home", response_model=HomeOut)
async def home(principal: CurrentStudent, session: SessionDep) -> HomeOut:
    """Everything the home screen shows: today's ladder, and homework — due, handed in,
    or given back. Soonest due first; returned work after everything still to do."""
    today = await _today(session, principal)
    klass = await get_student_class(session, principal)
    cards: list[HomeworkCardOut] = []
    if klass is not None:
        rows = (
            await session.exec(
                select(Assignment).where(
                    Assignment.class_id == klass.id,
                    Assignment.centre_id == principal.centre_id,
                    col(Assignment.mode).in_([AssignmentMode.HOMEWORK, AssignmentMode.QUIZ]),
                    col(Assignment.status).in_([AssignmentStatus.OPEN, AssignmentStatus.CLOSED]),
                )
            )
        ).all()
        for assignment in rows:
            sheet = await _sheet(session, principal, assignment)
            if sheet.closed and not sheet.returned:
                continue  # a closed sheet with nothing to give back is not news
            if assignment.mode == AssignmentMode.QUIZ and not sheet.returned:
                continue  # a quiz appears here only once it has been given back
            cards.append(
                HomeworkCardOut(
                    assignment_id=assignment.id,
                    mode=assignment.mode,
                    title=assignment.title,
                    due_at=assignment.due_at,
                    closed=sheet.closed,
                    problems=len(sheet.leaves),
                    started=sum(1 for leaf in sheet.leaves if leaf.progress != "not_started"),
                    handed_in_at=sheet.handed_in_at,
                    changed_since_hand_in=any(leaf.changed_since_hand_in for leaf in sheet.leaves),
                    late=sheet.late,
                    returned=sheet.returned,
                )
            )
    far = datetime.max.replace(tzinfo=UTC)
    cards.sort(key=lambda c: (c.returned, c.due_at or far))
    return HomeOut(today=today, homework=cards)


class StartedProblemOut(BaseModel):
    """A lesson problem the child has opened, for My work's Lessons tab."""

    assignment_id: uuid.UUID
    item_id: uuid.UUID
    lesson_title: str
    title: str
    part_labels: list[str]
    progress: Literal["started", "passing"]
    updated_at: datetime


@router.get("/problems", response_model=list[StartedProblemOut])
async def started_problems(
    principal: CurrentStudent, session: SessionDep
) -> list[StartedProblemOut]:
    """Every lesson problem the child has started, last worked on first (17 Oct 2026).

    So a child can carry on at home with a problem from an earlier lesson: Today only shows
    the class's current one. Classwork only — homework and quizzes have their own tabs.
    Reached through the child's active enrolments and open assignments, as everything is.
    """
    rows = (
        await session.exec(
            select(Attempt, Item, Assignment)
            .join(Item, col(Item.id) == Attempt.item_id)
            .join(Assignment, col(Assignment.id) == Attempt.assignment_id)
            .join(Enrolment, col(Enrolment.class_id) == Assignment.class_id)
            .where(
                Attempt.student_id == principal.subject_id,
                Attempt.centre_id == principal.centre_id,
                Assignment.centre_id == principal.centre_id,
                Assignment.mode == AssignmentMode.CLASSWORK,
                Assignment.status == AssignmentStatus.OPEN,
                Enrolment.student_id == principal.subject_id,
                Enrolment.status == EnrolmentStatus.ACTIVE,
            )
        )
    ).all()
    if not rows:
        return []
    parent_ids = {item.parent_id for _, item, _ in rows if item.parent_id is not None}
    parents = {
        p.id: p
        for p in (
            await session.exec(
                select(Item).where(
                    col(Item.id).in_(parent_ids), Item.centre_id == principal.centre_id
                )
            )
        ).all()
    }
    grouped: dict[tuple[uuid.UUID, uuid.UUID], dict] = {}
    for attempt, item, assignment in rows:
        problem = parents.get(item.parent_id, item) if item.parent_id else item
        entry = grouped.setdefault(
            (assignment.id, problem.id),
            {"assignment": assignment, "problem": problem, "attempts": [], "labels": []},
        )
        entry["attempts"].append(attempt)
        if item.part_label:
            entry["labels"].append(item.part_label)
    out = [
        StartedProblemOut(
            assignment_id=entry["assignment"].id,
            item_id=entry["problem"].id,
            lesson_title=entry["assignment"].title,
            title=entry["problem"].title,
            part_labels=sorted(entry["labels"]),
            progress="passing"
            if all(a.last_total and a.last_passed == a.last_total for a in entry["attempts"])
            else "started",
            updated_at=max(a.updated_at for a in entry["attempts"]),
        )
        for entry in grouped.values()
    ]
    return sorted(out, key=lambda p: p.updated_at, reverse=True)
