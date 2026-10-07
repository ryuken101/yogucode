"""Quizzes — set from the class page, started in class, handed in by the clock.

Teacher routes write a quiz as a draft (problems, length, whether Check is allowed), then
**Start** it: every child in the class is switched to it at once (pushed over the live
connection) and the clock runs. **Stop** ends it a few seconds later for everyone, so the
last keystrokes autosave. At the end, everyone's work is handed in automatically
(`app/quiz.py`). Marking and giving back are the homework routes (`routers/marking.py`),
which accept quizzes too.

While a quiz runs: autocomplete and hints are off, Check is off unless the teacher allowed
it, pastes are allowed but reach the teacher's live view, and the quiz is the only thing a
child can change.
"""

import uuid
from datetime import datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.audit import audit_entry
from app.auth.principal import CurrentStudent, CurrentTeacher, Principal
from app.classwork import check_set_items, ladder_items, replace_set_items
from app.config import Settings, get_settings
from app.db import get_session
from app.live.hub import hub
from app.models import Assignment, AssignmentMode, AssignmentStatus, ItemKind, ProblemSet
from app.models.base import utcnow
from app.quiz import finalise_if_due, is_running, running_quiz_for, running_quiz_in_class, schedule
from app.scoping import get_owned_assignment, get_owned_class

router = APIRouter(tags=["quiz"])

SessionDep = Annotated[AsyncSession, Depends(get_session)]
SettingsDep = Annotated[Settings, Depends(get_settings)]

MAX_QUESTIONS = 20


class QuizIn(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    item_ids: list[uuid.UUID] = Field(default_factory=list, max_length=MAX_QUESTIONS)
    duration_minutes: int = Field(default=20, ge=1, le=180)
    # Ken's decision: a toggle per quiz, off by default — Run still works.
    checks: bool = False


class QuizPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=120)
    item_ids: list[uuid.UUID] | None = Field(default=None, max_length=MAX_QUESTIONS)
    duration_minutes: int | None = Field(default=None, ge=1, le=180)
    checks: bool | None = None


class QuizQuestionOut(BaseModel):
    id: uuid.UUID
    title: str
    kind: ItemKind
    difficulty: int


class QuizOut(BaseModel):
    id: uuid.UUID
    class_id: uuid.UUID
    title: str
    status: AssignmentStatus
    running: bool
    duration_minutes: int
    checks: bool
    started_at: datetime | None
    ends_at: datetime | None
    released_at: datetime | None
    questions: list[QuizQuestionOut]


class ActiveQuizOut(BaseModel):
    assignment_id: uuid.UUID
    title: str
    ends_at: datetime


def _conflict(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=detail)


async def _owned_quiz(
    session: AsyncSession, principal: Principal, quiz_id: uuid.UUID
) -> Assignment:
    quiz = await get_owned_assignment(session, principal, quiz_id)
    if quiz.mode != AssignmentMode.QUIZ:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="quiz not found")
    await finalise_if_due(session, quiz)
    await session.refresh(quiz)
    return quiz


async def _out(session: AsyncSession, principal: Principal, quiz: Assignment) -> QuizOut:
    questions = await ladder_items(session, principal, quiz.set_id)
    return QuizOut(
        id=quiz.id,
        class_id=quiz.class_id,
        title=quiz.title,
        status=quiz.status,
        running=is_running(quiz),
        duration_minutes=int(quiz.settings.get("duration_minutes", 20)),
        checks=bool(quiz.settings.get("checks", False)),
        started_at=quiz.started_at,
        ends_at=quiz.ends_at,
        released_at=quiz.released_at,
        questions=[
            QuizQuestionOut(id=q.id, title=q.title, kind=q.kind, difficulty=q.difficulty)
            for q in questions
        ],
    )


def _settings(duration_minutes: int, checks: bool) -> dict:
    return {
        "completions": False,
        "hints": False,
        "checks": checks,
        "duration_minutes": duration_minutes,
    }


@router.post(
    "/classes/{class_id}/quizzes", response_model=QuizOut, status_code=status.HTTP_201_CREATED
)
async def create_quiz(
    class_id: uuid.UUID, body: QuizIn, principal: CurrentTeacher, session: SessionDep
) -> QuizOut:
    klass = await get_owned_class(session, principal, class_id)
    await check_set_items(session, principal, body.item_ids, already=set(), limit=MAX_QUESTIONS)
    problem_set = ProblemSet(
        centre_id=principal.centre_id, title=body.title.strip(), created_by=principal.subject_id
    )
    session.add(problem_set)
    await session.flush()
    await replace_set_items(session, problem_set.id, body.item_ids)
    quiz = Assignment(
        centre_id=principal.centre_id,
        class_id=klass.id,
        set_id=problem_set.id,
        title=body.title.strip(),
        mode=AssignmentMode.QUIZ,
        status=AssignmentStatus.DRAFT,
        settings=_settings(body.duration_minutes, body.checks),
        created_by=principal.subject_id,
    )
    session.add(quiz)
    await session.flush()
    session.add(audit_entry(principal, "quiz.created", "assignment", quiz.id, title=quiz.title))
    await session.commit()
    await session.refresh(quiz)
    return await _out(session, principal, quiz)


@router.get("/classes/{class_id}/quizzes", response_model=list[QuizOut])
async def list_quizzes(
    class_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep
) -> list[QuizOut]:
    klass = await get_owned_class(session, principal, class_id)
    await running_quiz_in_class(session, principal.centre_id, klass.id)  # finalise any ended
    rows = (
        await session.exec(
            select(Assignment)
            .where(
                Assignment.class_id == klass.id,
                Assignment.centre_id == principal.centre_id,
                Assignment.mode == AssignmentMode.QUIZ,
                Assignment.status != AssignmentStatus.ARCHIVED,
            )
            .order_by(col(Assignment.id).desc())
        )
    ).all()
    return [await _out(session, principal, row) for row in rows]


@router.get("/quizzes/{quiz_id}", response_model=QuizOut)
async def read_quiz(quiz_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep) -> QuizOut:
    return await _out(session, principal, await _owned_quiz(session, principal, quiz_id))


@router.patch("/quizzes/{quiz_id}", response_model=QuizOut)
async def update_quiz(
    quiz_id: uuid.UUID, body: QuizPatch, principal: CurrentTeacher, session: SessionDep
) -> QuizOut:
    """Edit a draft. A quiz that has started is not changed under the children sitting it."""
    quiz = await _owned_quiz(session, principal, quiz_id)
    if quiz.status != AssignmentStatus.DRAFT:
        raise _conflict("A quiz can only be changed before it starts")
    if body.item_ids is not None:
        await check_set_items(session, principal, body.item_ids, already=set(), limit=MAX_QUESTIONS)
        await replace_set_items(session, quiz.set_id, body.item_ids)
    if body.title is not None:
        quiz.title = body.title.strip()
    quiz.settings = _settings(
        body.duration_minutes or int(quiz.settings.get("duration_minutes", 20)),
        body.checks if body.checks is not None else bool(quiz.settings.get("checks", False)),
    )
    quiz.updated_at = utcnow()
    session.add(quiz)
    session.add(audit_entry(principal, "quiz.updated", "assignment", quiz.id))
    await session.commit()
    await session.refresh(quiz)
    return await _out(session, principal, quiz)


@router.post("/quizzes/{quiz_id}/start", response_model=QuizOut)
async def start_quiz(
    quiz_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep, settings: SettingsDep
) -> QuizOut:
    """Start the clock. Every child in the class is switched to the quiz at once."""
    quiz = await _owned_quiz(session, principal, quiz_id)
    if quiz.status != AssignmentStatus.DRAFT:
        raise _conflict("This quiz has already been run")
    if not await ladder_items(session, principal, quiz.set_id):
        raise _conflict("Add at least one question first")
    if await running_quiz_in_class(session, principal.centre_id, quiz.class_id):
        raise _conflict("Another quiz is running in this class")
    now = utcnow()
    quiz.status = AssignmentStatus.OPEN
    quiz.opens_at = quiz.started_at = now
    quiz.ends_at = now + timedelta(minutes=int(quiz.settings.get("duration_minutes", 20)))
    session.add(quiz)
    session.add(audit_entry(principal, "quiz.started", "assignment", quiz.id))
    await session.commit()
    await session.refresh(quiz)
    message = {"type": "quiz_started", "quiz_id": str(quiz.id), "ends_at": quiz.ends_at.isoformat()}
    await hub.to_students(quiz.class_id, message)
    await hub.to_teachers(quiz.class_id, message)
    if settings.quiz_timer:
        schedule(quiz.id, quiz.ends_at)
    return await _out(session, principal, quiz)


@router.post("/quizzes/{quiz_id}/stop", response_model=QuizOut)
async def stop_quiz(
    quiz_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep, settings: SettingsDep
) -> QuizOut:
    """End the quiz for everyone — after a few seconds' grace, so last keystrokes save."""
    quiz = await _owned_quiz(session, principal, quiz_id)
    if not is_running(quiz):
        raise _conflict("This quiz is not running")
    ends_at = utcnow() + timedelta(seconds=settings.quiz_stop_grace_seconds)
    assert quiz.ends_at is not None
    if ends_at < quiz.ends_at:
        quiz.ends_at = ends_at
        session.add(quiz)
        session.add(audit_entry(principal, "quiz.stopped", "assignment", quiz.id))
        await session.commit()
        await session.refresh(quiz)
        message = {"type": "quiz_ending", "quiz_id": str(quiz.id), "ends_at": ends_at.isoformat()}
        await hub.to_students(quiz.class_id, message)
        await hub.to_teachers(quiz.class_id, message)
        if settings.quiz_timer:
            schedule(quiz.id, ends_at)
    await finalise_if_due(session, quiz)  # with no grace, it is over now
    await session.refresh(quiz)
    return await _out(session, principal, quiz)


# --- the child's side -----------------------------------------------------------------------


@router.get("/me/quiz", response_model=ActiveQuizOut | None)
async def active_quiz(principal: CurrentStudent, session: SessionDep) -> ActiveQuizOut | None:
    """The quiz this child's class is sitting now, or null. Their pages route to it."""
    quiz = await running_quiz_for(session, principal)
    if quiz is None or quiz.ends_at is None:
        return None
    return ActiveQuizOut(assignment_id=quiz.id, title=quiz.title, ends_at=quiz.ends_at)
