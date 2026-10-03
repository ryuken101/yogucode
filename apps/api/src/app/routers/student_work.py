"""A student's classwork: today's ladder, the problems on it, and their attempts.

All `/me/...`, for the reason `documents.py` gives: the subject comes from the session
cookie, so no route here has a student id to point at the wrong child. Assignments are
reached only through a class the child is actively enrolled in (`app.scoping`).

**What a child is sent, and what they are not.** The problem's prompt, starter code and
test cases — hidden ones included, because the tests run in their browser and a test
cannot be run without its expected value. That is the accepted trade-off of running code
client-side (spec §4: not an anti-cheat product). Never sent: the reference solution, and
any hint rung they have not unlocked.

**The server decides hint unlocks.** A rung opens after enough runs or enough minutes on
the problem, whichever comes first (spec §3.4). `run_count` is counted here, from the
browser's report of each run, and the minutes from the attempt's own `created_at` — so a
child cannot unlock the worked example by editing a request, only by working.

Like documents, nothing here is audited: it is a child's own work on their own attempt.
"""

import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, model_validator
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.auth.principal import CurrentStudent
from app.classwork import get_ladder, ladder_items
from app.db import get_session
from app.models import (
    Assignment,
    AssignmentMode,
    AssignmentStatus,
    Attempt,
    AttemptStatus,
    Item,
    Lesson,
    SetItem,
)
from app.models.base import new_uuid, utcnow
from app.problem_bank import FunctionTest, IoTest, LeafDoc, read_document
from app.routers.documents import MAX_CONTENT_BYTES
from app.scoping import get_own_attempt, get_student_assignment, get_student_class

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

    @classmethod
    def build(cls, attempt: Attempt) -> "AttemptOut":
        return cls(
            id=attempt.id,
            code=attempt.code,
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


class StudentLeafOut(BaseModel):
    item_id: uuid.UUID
    label: str | None
    prompt_md: str
    tests: list[IoTest | FunctionTest]
    hints: list[UnlockedHintOut]
    next_hint: NextHintOut | None
    attempt: AttemptOut


class StudentProblemOut(BaseModel):
    assignment_id: uuid.UUID
    item_id: uuid.UUID
    title: str
    prompt_md: str
    difficulty: int
    mode: AssignmentMode
    completions: bool
    leaves: list[StudentLeafOut]


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


async def _open_attempt(
    session: AsyncSession, principal: CurrentStudent, assignment: Assignment, leaf: Item
) -> Attempt:
    """The child's attempt at a leaf, created with the starter code on first open.

    `ON CONFLICT DO NOTHING` rather than check-then-insert: a child with the problem open
    in two tabs opens it twice at once, and the second must find the first's row rather
    than fail on the unique constraint.
    """
    await session.exec(
        pg_insert(Attempt)  # type: ignore[call-overload]
        .values(
            id=new_uuid(),
            centre_id=principal.centre_id,
            student_id=principal.subject_id,
            assignment_id=assignment.id,
            item_id=leaf.id,
            code=leaf.starter_code,
            status=AttemptStatus.IN_PROGRESS,
            run_count=0,
            hints_unlocked=0,
            created_at=utcnow(),
            updated_at=utcnow(),
        )
        .on_conflict_do_nothing(constraint="uq_attempts_assignment_item_student")
    )
    return (
        await session.exec(
            select(Attempt).where(
                Attempt.assignment_id == assignment.id,
                Attempt.item_id == leaf.id,
                Attempt.student_id == principal.subject_id,
            )
        )
    ).one()


async def _writable_attempt(
    session: AsyncSession, principal: CurrentStudent, attempt_id: uuid.UUID
) -> tuple[Attempt, Assignment]:
    """An attempt the child may still change: theirs, in an open assignment of their class."""
    attempt = await get_own_attempt(session, principal, attempt_id)
    assignment = await get_student_assignment(session, principal, attempt.assignment_id)
    if attempt.status != AttemptStatus.IN_PROGRESS:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="You have handed this one in"
        )
    return attempt, assignment


# --- routes -------------------------------------------------------------------------


@router.get("/lesson", response_model=TodayOut)
async def todays_lesson(principal: CurrentStudent, session: SessionDep) -> TodayOut:
    """The child's class, today's lesson, and its ladder with their progress on each rung."""
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
    item = await _item_in_assignment(session, principal, assignment, item_id)
    doc, part_rows = await read_document(session, principal, item)
    leaf_rows = part_rows or [item]
    leaf_docs: list[tuple[LeafDoc, str | None, str]] = (
        [(part, part.label, part.prompt_md) for part in doc.parts]
        if part_rows
        else [(doc, None, "")]
    )
    attempts = [await _open_attempt(session, principal, assignment, row) for row in leaf_rows]
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
                tests=leaf.tests,
                hints=hints,
                next_hint=next_hint,
                attempt=AttemptOut.build(attempt),
            )
        )
    return StudentProblemOut(
        assignment_id=assignment.id,
        item_id=item.id,
        title=item.title,
        prompt_md=doc.prompt_md,
        difficulty=item.difficulty,
        mode=assignment.mode,
        completions=bool(assignment.settings.get("completions", True)),
        leaves=leaves,
    )


@router.patch("/attempts/{attempt_id}", response_model=AttemptOut)
async def save_attempt(
    attempt_id: uuid.UUID, body: AttemptSaveIn, principal: CurrentStudent, session: SessionDep
) -> AttemptOut:
    """Autosave. Like a file save, a save that changes nothing writes nothing."""
    attempt, _ = await _writable_attempt(session, principal, attempt_id)
    if body.code != attempt.code:
        attempt.code = body.code
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
        tests=leaf_doc.tests,
        hints=hints,
        next_hint=next_hint,
        attempt=AttemptOut.build(attempt),
    )
