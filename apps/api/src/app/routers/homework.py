"""Setting homework — teacher-only, from the class page (Ken's decision).

A homework is a set of published problems given to one class with a due date and time,
and a hints switch. It starts as a **draft** the teacher can rearrange, and becomes visible
to the class the moment they press **Set** — there is no scheduling (Ken's decision).

Once set, the problems are fixed: children have started on them, and changing the sheet
under them would leave attempts on problems no longer on it. The title, due date and
hints stay editable — "I'll give you till Friday" is a normal thing to say.

**Close** stops further hand-ins (it does not hide the sheet), and **reopen** undoes it.
Marking and release live in `routers/marking.py`.
"""

import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import AwareDatetime, BaseModel, Field
from sqlmodel import col, func, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.audit import audit_entry
from app.auth.principal import CurrentTeacher, Principal
from app.classwork import check_set_items, ladder_items, replace_set_items
from app.db import get_session
from app.homework import released_students
from app.models import (
    Assignment,
    AssignmentMode,
    AssignmentStatus,
    Attempt,
    Enrolment,
    EnrolmentStatus,
    ItemStatus,
    Mark,
    ProblemSet,
    Submission,
    SubmissionSource,
)
from app.scoping import get_owned_assignment, get_owned_class

router = APIRouter(tags=["homework"])

SessionDep = Annotated[AsyncSession, Depends(get_session)]

MAX_HOMEWORK = 12


class HomeworkIn(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    item_ids: list[uuid.UUID] = Field(default_factory=list, max_length=MAX_HOMEWORK)
    due_at: AwareDatetime | None = None
    hints: bool = True


class HomeworkPatch(BaseModel):
    """Every field optional — an absent field means "leave it alone"."""

    title: str | None = Field(default=None, min_length=1, max_length=120)
    item_ids: list[uuid.UUID] | None = Field(default=None, max_length=MAX_HOMEWORK)
    due_at: AwareDatetime | None = None
    hints: bool | None = None


class HomeworkProblemOut(BaseModel):
    id: uuid.UUID
    title: str
    difficulty: int
    status: ItemStatus


class HomeworkOut(BaseModel):
    id: uuid.UUID
    class_id: uuid.UUID
    title: str
    status: AssignmentStatus
    due_at: datetime | None
    hints: bool
    released_at: datetime | None
    problems: list[HomeworkProblemOut]
    students: int
    handed_in: int
    marked: int
    returned: int


def _not_homework() -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="homework not found")


def _conflict(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=detail)


async def _owned_homework(
    session: AsyncSession, principal: Principal, assignment_id: uuid.UUID
) -> Assignment:
    assignment = await get_owned_assignment(session, principal, assignment_id)
    if assignment.mode != AssignmentMode.HOMEWORK:
        raise _not_homework()
    return assignment


async def _out(session: AsyncSession, principal: Principal, assignment: Assignment) -> HomeworkOut:
    problems = await ladder_items(session, principal, assignment.set_id)
    students = (
        await session.exec(
            select(func.count()).where(
                Enrolment.class_id == assignment.class_id,
                Enrolment.status == EnrolmentStatus.ACTIVE,
            )
        )
    ).one()
    handed_in = (
        await session.exec(
            select(func.count(func.distinct(Attempt.student_id)))
            .join(Submission, col(Submission.attempt_id) == Attempt.id)
            .where(
                Attempt.assignment_id == assignment.id,
                Submission.source == SubmissionSource.HAND_IN,
            )
        )
    ).one()
    marked = (
        await session.exec(
            select(func.count(func.distinct(Attempt.student_id)))
            .join(Mark, col(Mark.attempt_id) == Attempt.id)
            .where(Attempt.assignment_id == assignment.id)
        )
    ).one()
    returned = len(await released_students(session, principal, assignment))
    return HomeworkOut(
        id=assignment.id,
        class_id=assignment.class_id,
        title=assignment.title,
        status=assignment.status,
        due_at=assignment.due_at,
        hints=bool(assignment.settings.get("hints", True)),
        released_at=assignment.released_at,
        problems=[
            HomeworkProblemOut(id=p.id, title=p.title, difficulty=p.difficulty, status=p.status)
            for p in problems
        ],
        students=students,
        handed_in=handed_in,
        marked=marked,
        returned=returned,
    )


def _audit(principal: Principal, action: str, assignment: Assignment, **payload: object):
    return audit_entry(principal, action, "assignment", assignment.id, **payload)


@router.post(
    "/classes/{class_id}/homework", response_model=HomeworkOut, status_code=status.HTTP_201_CREATED
)
async def create_homework(
    class_id: uuid.UUID, body: HomeworkIn, principal: CurrentTeacher, session: SessionDep
) -> HomeworkOut:
    """Start a homework as a draft. Nothing is visible to the class until it is set."""
    klass = await get_owned_class(session, principal, class_id)
    await check_set_items(session, principal, body.item_ids, already=set(), limit=MAX_HOMEWORK)
    problem_set = ProblemSet(
        centre_id=principal.centre_id, title=body.title.strip(), created_by=principal.subject_id
    )
    session.add(problem_set)
    await session.flush()
    await replace_set_items(session, problem_set.id, body.item_ids)
    assignment = Assignment(
        centre_id=principal.centre_id,
        class_id=klass.id,
        set_id=problem_set.id,
        title=body.title.strip(),
        mode=AssignmentMode.HOMEWORK,
        status=AssignmentStatus.DRAFT,
        due_at=body.due_at,
        settings={"completions": True, "hints": body.hints},
        created_by=principal.subject_id,
    )
    session.add(assignment)
    await session.flush()
    session.add(_audit(principal, "homework.created", assignment, title=assignment.title))
    await session.commit()
    await session.refresh(assignment)
    return await _out(session, principal, assignment)


@router.get("/classes/{class_id}/homework", response_model=list[HomeworkOut])
async def list_homework(
    class_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep
) -> list[HomeworkOut]:
    """The class's homework, newest first. Archived ones are left out."""
    klass = await get_owned_class(session, principal, class_id)
    rows = (
        await session.exec(
            select(Assignment)
            .where(
                Assignment.class_id == klass.id,
                Assignment.centre_id == principal.centre_id,
                Assignment.mode == AssignmentMode.HOMEWORK,
                Assignment.status != AssignmentStatus.ARCHIVED,
            )
            .order_by(col(Assignment.id).desc())
        )
    ).all()
    return [await _out(session, principal, row) for row in rows]


@router.get("/assignments/{assignment_id}", response_model=HomeworkOut)
async def read_homework(
    assignment_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep
) -> HomeworkOut:
    return await _out(session, principal, await _owned_homework(session, principal, assignment_id))


@router.patch("/assignments/{assignment_id}", response_model=HomeworkOut)
async def update_homework(
    assignment_id: uuid.UUID, body: HomeworkPatch, principal: CurrentTeacher, session: SessionDep
) -> HomeworkOut:
    assignment = await _owned_homework(session, principal, assignment_id)
    fields = body.model_dump(exclude_unset=True)
    changed: dict[str, object] = {}

    if body.item_ids is not None:
        if assignment.status != AssignmentStatus.DRAFT:
            raise _conflict("The problems are fixed once homework is set")
        already = {p.id for p in await ladder_items(session, principal, assignment.set_id)}
        await check_set_items(
            session, principal, body.item_ids, already=already, limit=MAX_HOMEWORK
        )
        await replace_set_items(session, assignment.set_id, body.item_ids)
        changed["item_ids"] = [str(i) for i in body.item_ids]
    if body.title is not None and body.title.strip() != assignment.title:
        assignment.title = body.title.strip()
        changed["title"] = assignment.title
    if "due_at" in fields and body.due_at != assignment.due_at:
        assignment.due_at = body.due_at
        changed["due_at"] = body.due_at.isoformat() if body.due_at else None
    if body.hints is not None and body.hints != assignment.settings.get("hints", True):
        # Reassigned, not mutated: SQLAlchemy does not see in-place changes to a JSONB dict.
        assignment.settings = {**assignment.settings, "hints": body.hints}
        changed["hints"] = body.hints

    if changed:
        session.add(assignment)
        session.add(_audit(principal, "homework.updated", assignment, **changed))
        await session.commit()
        await session.refresh(assignment)
    return await _out(session, principal, assignment)


async def _move(
    session: AsyncSession,
    principal: Principal,
    assignment: Assignment,
    allowed_from: AssignmentStatus,
    to: AssignmentStatus,
    action: str,
) -> HomeworkOut:
    if assignment.status == to:
        return await _out(session, principal, assignment)
    if assignment.status != allowed_from:
        raise _conflict(f"This homework is {AssignmentStatus(assignment.status).value}")
    assignment.status = to
    session.add(assignment)
    session.add(_audit(principal, action, assignment))
    await session.commit()
    await session.refresh(assignment)
    return await _out(session, principal, assignment)


@router.post("/assignments/{assignment_id}/set", response_model=HomeworkOut)
async def set_homework(
    assignment_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep
) -> HomeworkOut:
    """Give the draft to the class. It appears for them at once."""
    assignment = await _owned_homework(session, principal, assignment_id)
    if not await ladder_items(session, principal, assignment.set_id):
        raise _conflict("Add at least one problem first")
    if assignment.due_at is None:
        raise _conflict("Choose when it is due first")
    return await _move(
        session,
        principal,
        assignment,
        AssignmentStatus.DRAFT,
        AssignmentStatus.OPEN,
        "homework.set",
    )


@router.post("/assignments/{assignment_id}/close", response_model=HomeworkOut)
async def close_homework(
    assignment_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep
) -> HomeworkOut:
    """Stop further hand-ins. Children can still see the sheet and their feedback."""
    assignment = await _owned_homework(session, principal, assignment_id)
    return await _move(
        session,
        principal,
        assignment,
        AssignmentStatus.OPEN,
        AssignmentStatus.CLOSED,
        "homework.closed",
    )


@router.post("/assignments/{assignment_id}/reopen", response_model=HomeworkOut)
async def reopen_homework(
    assignment_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep
) -> HomeworkOut:
    assignment = await _owned_homework(session, principal, assignment_id)
    return await _move(
        session,
        principal,
        assignment,
        AssignmentStatus.CLOSED,
        AssignmentStatus.OPEN,
        "homework.reopened",
    )
