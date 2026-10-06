"""Progress — what a teacher reads at a glance (step 10).

Two grids, both students × problems, both refresh-to-update (live is Phase 10):

- **A homework**: who has not started, who is working, who has every check passing, who
  has handed in, who is marked, whose work is back. "Who hasn't done their homework" is the
  question it exists to answer in one look.
- **Today's ladder**: who is on which rung, and who has finished early. Spec §1.2's whole
  problem is the fast finisher idling for 35 minutes; this is the first place a teacher
  can see one without walking the room.

And one page per child: their homework this term, with the marks the teacher gave. The
teacher's view of the numbers — a child never sees them.

All of it is built from attempts, submissions and marks; there is nothing to keep in sync.
"""

import uuid
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.auth.principal import CurrentTeacher, Principal
from app.classwork import get_ladder, ladder_items
from app.db import get_session
from app.homework import latest_submissions, released_students, set_leaves
from app.models import (
    Assignment,
    AssignmentMode,
    Attempt,
    Class,
    EnrolmentStatus,
    Item,
    Lesson,
    Mark,
    SubmissionSource,
)
from app.scoping import (
    get_owned_assignment,
    get_owned_class,
    get_owned_student,
    list_class_roster,
)

router = APIRouter(tags=["progress"])

SessionDep = Annotated[AsyncSession, Depends(get_session)]

CellStatus = Literal["not_started", "started", "passing", "handed_in", "marked", "returned"]


class GridColumnOut(BaseModel):
    item_id: uuid.UUID
    title: str
    difficulty: int


class GridCellOut(BaseModel):
    status: CellStatus
    late: bool = False


class GridRowOut(BaseModel):
    student_id: uuid.UUID
    display_name: str
    cells: list[GridCellOut]
    # Today's ladder only: every rung passing.
    finished: bool = False


class GridOut(BaseModel):
    title: str | None
    assignment_id: uuid.UUID | None
    columns: list[GridColumnOut]
    rows: list[GridRowOut]


class HistoryQuestionOut(BaseModel):
    title: str
    correct: int | None
    approach: int | None
    released: bool


class HistoryEntryOut(BaseModel):
    assignment_id: uuid.UUID
    title: str
    class_name: str
    due_at: datetime | None
    handed_in_at: datetime | None
    late: bool
    questions: list[HistoryQuestionOut]


class StudentHistoryOut(BaseModel):
    student_id: uuid.UUID
    display_name: str
    homework: list[HistoryEntryOut]


def _passing(attempt: Attempt | None) -> bool:
    return bool(attempt and attempt.last_total and attempt.last_passed == attempt.last_total)


async def _active_roster(session: AsyncSession, principal: Principal, class_id: uuid.UUID):
    return [
        student
        for enrolment, student in await list_class_roster(session, principal, class_id)
        if enrolment.status == EnrolmentStatus.ACTIVE
    ]


async def _attempts(session: AsyncSession, principal: Principal, assignment_id: uuid.UUID):
    return (
        await session.exec(
            select(Attempt).where(
                Attempt.assignment_id == assignment_id,
                Attempt.centre_id == principal.centre_id,
            )
        )
    ).all()


@router.get("/assignments/{assignment_id}/grid", response_model=GridOut)
async def homework_grid(
    assignment_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep
) -> GridOut:
    assignment = await get_owned_assignment(session, principal, assignment_id)
    leaves = await set_leaves(session, principal, assignment.set_id)
    attempts = await _attempts(session, principal, assignment.id)
    by_key = {(a.student_id, a.item_id): a for a in attempts}
    submissions = await latest_submissions(session, principal, [a.id for a in attempts])
    marked = (
        set(
            (
                await session.exec(
                    select(Mark.attempt_id).where(
                        col(Mark.attempt_id).in_([a.id for a in attempts])
                    )
                )
            ).all()
        )
        if attempts
        else set()
    )
    returned = await released_students(session, principal, assignment)

    rows = []
    for student in await _active_roster(session, principal, assignment.class_id):
        cells = []
        for leaf in leaves:
            attempt = by_key.get((student.id, leaf.leaf.id))
            submission = submissions.get(attempt.id) if attempt else None
            handed = submission is not None and submission.source == SubmissionSource.HAND_IN
            status: CellStatus = "not_started"
            if attempt is not None and attempt.id in marked:
                status = "returned" if student.id in returned else "marked"
            elif handed:
                status = "handed_in"
            elif _passing(attempt):
                status = "passing"
            elif attempt is not None:
                status = "started"
            cells.append(GridCellOut(status=status, late=bool(handed and submission.late)))
        rows.append(
            GridRowOut(student_id=student.id, display_name=student.display_name, cells=cells)
        )
    return GridOut(
        title=assignment.title,
        assignment_id=assignment.id,
        columns=[
            GridColumnOut(item_id=leaf.leaf.id, title=leaf.label, difficulty=leaf.leaf.difficulty)
            for leaf in leaves
        ],
        rows=rows,
    )


@router.get("/classes/{class_id}/today", response_model=GridOut)
async def today_grid(
    class_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep
) -> GridOut:
    """Today's ladder, per child. A problem counts as passing when all its parts do."""
    klass = await get_owned_class(session, principal, class_id)
    empty = GridOut(title=None, assignment_id=None, columns=[], rows=[])
    if klass.current_lesson_id is None:
        return empty
    lesson = await session.get(Lesson, klass.current_lesson_id)
    if lesson is None or lesson.centre_id != principal.centre_id:
        return empty
    ladder = await get_ladder(session, principal, lesson)
    assignment = (
        (
            await session.exec(
                select(Assignment).where(
                    Assignment.class_id == klass.id,
                    Assignment.set_id == ladder.id,
                    Assignment.mode == AssignmentMode.CLASSWORK,
                )
            )
        ).one_or_none()
        if ladder
        else None
    )
    problems = await ladder_items(session, principal, ladder.id) if ladder else []
    empty.title = lesson.title
    if assignment is None or not problems:
        return empty

    leaves = await set_leaves(session, principal, assignment.set_id)
    leaves_of: dict[uuid.UUID, list[Item]] = {}
    for leaf in leaves:
        leaves_of.setdefault(leaf.problem.id, []).append(leaf.leaf)
    attempts = await _attempts(session, principal, assignment.id)
    by_key = {(a.student_id, a.item_id): a for a in attempts}

    rows = []
    for student in await _active_roster(session, principal, klass.id):
        cells = []
        for problem in problems:
            parts = [by_key.get((student.id, leaf.id)) for leaf in leaves_of[problem.id]]
            if all(_passing(a) for a in parts):
                status: CellStatus = "passing"
            elif any(a is not None for a in parts):
                status = "started"
            else:
                status = "not_started"
            cells.append(GridCellOut(status=status))
        rows.append(
            GridRowOut(
                student_id=student.id,
                display_name=student.display_name,
                cells=cells,
                finished=all(c.status == "passing" for c in cells),
            )
        )
    return GridOut(
        title=lesson.title,
        assignment_id=assignment.id,
        columns=[
            GridColumnOut(item_id=p.id, title=p.title, difficulty=p.difficulty) for p in problems
        ],
        rows=rows,
    )


@router.get("/students/{student_id}/history", response_model=StudentHistoryOut)
async def student_history(
    student_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep
) -> StudentHistoryOut:
    """A child's homework across every class they have been in, newest first."""
    student = await get_owned_student(session, principal, student_id)
    assignments = (
        await session.exec(
            select(Assignment, Class)
            .join(Class, col(Class.id) == Assignment.class_id)
            .join(Attempt, col(Attempt.assignment_id) == Assignment.id)
            .where(
                Attempt.student_id == student.id,
                Assignment.centre_id == principal.centre_id,
                Assignment.mode == AssignmentMode.HOMEWORK,
            )
            .distinct()
            .order_by(col(Assignment.id).desc())
        )
    ).all()

    homework = []
    for assignment, klass in assignments:
        leaves = await set_leaves(session, principal, assignment.set_id)
        attempts = {
            a.item_id: a
            for a in await _attempts(session, principal, assignment.id)
            if a.student_id == student.id
        }
        submissions = await latest_submissions(
            session, principal, [a.id for a in attempts.values()]
        )
        hand_ins = [s for s in submissions.values() if s.source == SubmissionSource.HAND_IN]
        marks = (
            {
                m.attempt_id: m
                for m in (
                    await session.exec(
                        select(Mark).where(
                            col(Mark.attempt_id).in_([a.id for a in attempts.values()])
                        )
                    )
                ).all()
            }
            if attempts
            else {}
        )
        questions = []
        for leaf in leaves:
            attempt = attempts.get(leaf.leaf.id)
            mark = marks.get(attempt.id) if attempt else None
            questions.append(
                HistoryQuestionOut(
                    title=leaf.label,
                    correct=mark.correct if mark else None,
                    approach=mark.approach if mark else None,
                    released=bool(mark and mark.released_at),
                )
            )
        homework.append(
            HistoryEntryOut(
                assignment_id=assignment.id,
                title=assignment.title,
                class_name=klass.name,
                due_at=assignment.due_at,
                handed_in_at=max((s.submitted_at for s in hand_ins), default=None),
                late=any(s.late for s in hand_ins),
                questions=questions,
            )
        )
    return StudentHistoryOut(
        student_id=student.id, display_name=student.display_name, homework=homework
    )
