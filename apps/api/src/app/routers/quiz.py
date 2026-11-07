"""Quizzes — set from the class page, started in class, handed in by the clock.

Teacher routes write a quiz as a draft (problems, length, whether Check is allowed), then
**Start** it: every child in the class is switched to it at once (pushed over the live
connection) and the clock runs. **Stop** stops the clock for everyone. A few seconds after
the clock stops, so the last keystrokes save, everyone's work is handed in automatically
(`app/quiz.py`). Marking and giving back are the homework routes (`routers/marking.py`),
which accept quizzes once they have finished.

While a quiz runs: autocomplete and hints are off, Check is off unless the teacher allowed
it, pastes are allowed but reach the teacher's live view, and the quiz is the only thing a
child can change.
"""

import uuid
from datetime import datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, field_validator
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.audit import audit_entry
from app.auth.principal import CurrentStudent, CurrentTeacher, Principal
from app.classwork import check_set_items, ladder_items, newest_version, replace_set_items
from app.config import Settings, get_settings
from app.db import get_session
from app.homework import is_answered, set_leaves
from app.live.hub import hub
from app.models import (
    Assignment,
    AssignmentMode,
    AssignmentStatus,
    Attempt,
    Class,
    ClassStatus,
    Enrolment,
    ItemKind,
    ItemStatus,
    ProblemSet,
    QuizSitting,
)
from app.models.base import utcnow
from app.quiz import (
    finalise_if_due,
    is_running,
    record_away,
    running_quiz_for,
    running_quiz_in_class,
    schedule,
    sitting_for,
)
from app.scoping import get_owned_assignment, get_owned_class, get_owned_student

router = APIRouter(tags=["quiz"])

SessionDep = Annotated[AsyncSession, Depends(get_session)]
SettingsDep = Annotated[Settings, Depends(get_settings)]

MAX_QUESTIONS = 20


def _title_has_words(value: str | None) -> str | None:
    if value is not None and not value.strip():
        raise ValueError("A quiz needs a title")
    return value


class QuizIn(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    item_ids: list[uuid.UUID] = Field(default_factory=list, max_length=MAX_QUESTIONS)
    duration_minutes: int = Field(default=20, ge=1, le=180)
    # Ken's decision: a toggle per quiz, off by default — Run still works.
    checks: bool = False

    _title = field_validator("title")(_title_has_words)


class QuizPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=120)
    item_ids: list[uuid.UUID] | None = Field(default=None, max_length=MAX_QUESTIONS)
    duration_minutes: int | None = Field(default=None, ge=1, le=180)
    checks: bool | None = None

    _title = field_validator("title")(_title_has_words)


class QuizQuestionOut(BaseModel):
    id: uuid.UUID
    title: str
    kind: ItemKind
    difficulty: int
    # As on a ladder or homework: a newer version is offered, never swapped in unasked.
    newer_version_id: uuid.UUID | None
    superseded: bool


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
    # They have pressed "I'm finished". They stay in the quiz, and may still change answers.
    finished: bool


class RunningQuizOut(BaseModel):
    """For the top bar: a quiz running anywhere at the centre, with what it takes to act."""

    id: uuid.UUID
    class_id: uuid.UUID
    class_name: str
    title: str
    ends_at: datetime


class SittingOut(BaseModel):
    """One child's sitting, for the teacher: finished, and how much they left the page."""

    student_id: uuid.UUID
    finished_at: datetime | None
    away_count: int
    away_seconds: int
    away_now: bool


class AnswerOptionOut(BaseModel):
    text: str
    correct: bool


class QuizAnswerOut(BaseModel):
    """What a child has saved for one question, for their teacher's eyes only. It carries the
    answer key, so it must never be served from a `/me` route."""

    item_id: uuid.UUID
    problem_id: uuid.UUID
    title: str
    kind: ItemKind
    prompt_md: str
    attempt_id: uuid.UUID | None
    code: str | None
    choice: int | None
    options: list[AnswerOptionOut]
    answered: bool


class AwayIn(BaseModel):
    away: bool


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
            QuizQuestionOut(
                id=q.id,
                title=q.title,
                kind=q.kind,
                difficulty=q.difficulty,
                newer_version_id=newer.id
                if (newer := await newest_version(session, principal, q))
                else None,
                superseded=q.status == ItemStatus.SUPERSEDED,
            )
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


@router.get("/quizzes/running", response_model=list[RunningQuizOut])
async def running_quizzes(principal: CurrentTeacher, session: SessionDep) -> list[RunningQuizOut]:
    """Every quiz running at this centre, for every teacher and the owner: a class is
    anyone's to cover, so a quiz in any of them is worth knowing about. Before
    `/quizzes/{quiz_id}`, which would otherwise read "running" as an id."""
    rows = (
        await session.exec(
            select(Assignment, Class.name)
            .join(Class, col(Class.id) == Assignment.class_id)
            .where(
                Assignment.centre_id == principal.centre_id,
                Assignment.mode == AssignmentMode.QUIZ,
                Assignment.status == AssignmentStatus.OPEN,
                Class.status == ClassStatus.ACTIVE,
            )
        )
    ).all()
    running = []
    for quiz, class_name in rows:
        if is_running(quiz) and quiz.ends_at is not None:
            running.append(
                RunningQuizOut(
                    id=quiz.id,
                    class_id=quiz.class_id,
                    class_name=class_name,
                    title=quiz.title,
                    ends_at=quiz.ends_at,
                )
            )
        else:
            await finalise_if_due(session, quiz)
    return running


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
        # What is on it may stay, even if a newer version has been published since.
        current = {q.id for q in await ladder_items(session, principal, quiz.set_id)}
        await check_set_items(
            session, principal, body.item_ids, already=current, limit=MAX_QUESTIONS
        )
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
    # Finalises anything past its end, which commits, so it comes before taking the lock.
    await running_quiz_in_class(session, principal.centre_id, quiz.class_id)
    # One at a time per class: two Starts at once queue here, and the second sees the first.
    await session.exec(select(Class).where(Class.id == quiz.class_id).with_for_update())
    if await running_quiz_in_class(session, principal.centre_id, quiz.class_id):
        raise _conflict("Another quiz is running in this class")
    now = utcnow()
    quiz.status = AssignmentStatus.OPEN
    quiz.opens_at = quiz.started_at = now
    quiz.ends_at = now + timedelta(minutes=int(quiz.settings.get("duration_minutes", 20)))
    quiz.hand_in_at = quiz.ends_at + timedelta(seconds=settings.quiz_hand_in_grace_seconds)
    session.add(quiz)
    session.add(audit_entry(principal, "quiz.started", "assignment", quiz.id))
    await session.commit()
    await session.refresh(quiz)
    message = {"type": "quiz_started", "quiz_id": str(quiz.id), "ends_at": quiz.ends_at.isoformat()}
    await hub.to_students(quiz.class_id, message)
    await hub.to_teachers(quiz.class_id, message)
    if settings.quiz_timer:
        schedule(quiz.id, quiz.class_id, quiz.ends_at, quiz.hand_in_at)
    return await _out(session, principal, quiz)


@router.post("/quizzes/{quiz_id}/stop", response_model=QuizOut)
async def stop_quiz(
    quiz_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep, settings: SettingsDep
) -> QuizOut:
    """Stop the clock for everyone. Their work is handed in a few seconds later."""
    quiz = await _owned_quiz(session, principal, quiz_id)
    if not is_running(quiz):
        raise _conflict("This quiz is not running")
    now = utcnow()
    assert quiz.ends_at is not None
    if now < quiz.ends_at:  # past it, the clock has already stopped and the hand-in is coming
        quiz.ends_at = now
        quiz.hand_in_at = now + timedelta(seconds=settings.quiz_hand_in_grace_seconds)
        session.add(quiz)
        session.add(audit_entry(principal, "quiz.stopped", "assignment", quiz.id))
        await session.commit()
        await session.refresh(quiz)
        message = {"type": "quiz_ending", "quiz_id": str(quiz.id), "ends_at": now.isoformat()}
        await hub.to_students(quiz.class_id, message)
        await hub.to_teachers(quiz.class_id, message)
        if settings.quiz_timer:
            schedule(quiz.id, quiz.class_id, now, quiz.hand_in_at, announce=False)
    await finalise_if_due(session, quiz)  # with no grace, it is over now
    await session.refresh(quiz)
    return await _out(session, principal, quiz)


@router.get("/quizzes/{quiz_id}/sittings", response_model=list[SittingOut])
async def quiz_sittings(
    quiz_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep
) -> list[SittingOut]:
    """Who has finished and who left the page: for Live now, and for marking afterwards."""
    quiz = await _owned_quiz(session, principal, quiz_id)
    rows = (
        await session.exec(
            select(QuizSitting).where(
                QuizSitting.assignment_id == quiz.id, QuizSitting.centre_id == principal.centre_id
            )
        )
    ).all()
    return [
        SittingOut(
            student_id=row.student_id,
            finished_at=row.finished_at,
            away_count=row.away_count,
            away_seconds=row.away_seconds,
            away_now=row.left_at is not None,
        )
        for row in rows
    ]


@router.get("/quizzes/{quiz_id}/students/{student_id}/answers", response_model=list[QuizAnswerOut])
async def quiz_answers(
    quiz_id: uuid.UUID, student_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep
) -> list[QuizAnswerOut]:
    """What one child has saved so far, question by question, for the live view to go through.
    The saved copy: the question they have open is also streamed live."""
    quiz = await _owned_quiz(session, principal, quiz_id)
    student = await get_owned_student(session, principal, student_id)
    enrolled = (
        await session.exec(
            select(Enrolment.id).where(
                Enrolment.class_id == quiz.class_id, Enrolment.student_id == student.id
            )
        )
    ).first()
    if enrolled is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="student not found")
    attempts = {
        a.item_id: a
        for a in (
            await session.exec(
                select(Attempt).where(
                    Attempt.assignment_id == quiz.id,
                    Attempt.student_id == student.id,
                    Attempt.centre_id == principal.centre_id,
                )
            )
        ).all()
    }
    answers = []
    for leaf in await set_leaves(session, principal, quiz.set_id):
        attempt = attempts.get(leaf.leaf.id)
        mcq = leaf.leaf.kind == ItemKind.MCQ
        answers.append(
            QuizAnswerOut(
                item_id=leaf.leaf.id,
                problem_id=leaf.problem.id,
                title=leaf.label,
                kind=leaf.leaf.kind,
                prompt_md=leaf.prompt_md,
                attempt_id=attempt.id if attempt else None,
                code=attempt.code if attempt and not mcq else None,
                choice=attempt.choice if attempt else None,
                options=[
                    AnswerOptionOut(
                        text=str(option.get("text", "")), correct=bool(option.get("correct"))
                    )
                    for option in (leaf.leaf.options if mcq else [])
                ],
                answered=is_answered(leaf, attempt),
            )
        )
    return answers


# --- the child's side -----------------------------------------------------------------------


@router.get("/me/quiz", response_model=ActiveQuizOut | None)
async def active_quiz(principal: CurrentStudent, session: SessionDep) -> ActiveQuizOut | None:
    """The quiz this child's class is sitting now, or null. Their pages route to it."""
    quiz = await running_quiz_for(session, principal)
    if quiz is None or quiz.ends_at is None:
        return None
    sitting = (
        await session.exec(
            select(QuizSitting).where(
                QuizSitting.assignment_id == quiz.id,
                QuizSitting.student_id == principal.subject_id,
            )
        )
    ).one_or_none()
    return _active(quiz, finished=bool(sitting and sitting.finished_at))


def _active(quiz: Assignment, *, finished: bool) -> ActiveQuizOut:
    assert quiz.ends_at is not None
    return ActiveQuizOut(
        assignment_id=quiz.id, title=quiz.title, ends_at=quiz.ends_at, finished=finished
    )


async def _my_running_quiz(
    session: AsyncSession, principal: Principal, quiz_id: uuid.UUID
) -> Assignment:
    quiz = await running_quiz_for(session, principal)
    if quiz is None or quiz.id != quiz_id:
        raise _conflict("This quiz is not running")
    return quiz


async def _set_finished(
    session: AsyncSession, principal: Principal, quiz_id: uuid.UUID, *, finished: bool
) -> ActiveQuizOut:
    quiz = await _my_running_quiz(session, principal, quiz_id)
    sitting = await sitting_for(session, quiz, principal.subject_id)
    now = utcnow()
    sitting.finished_at = now if finished else None
    sitting.updated_at = now
    session.add(sitting)
    await session.commit()
    await hub.to_teachers(
        quiz.class_id,
        {"type": "quiz_sitting", "student_id": str(principal.subject_id), "finished": finished},
    )
    return _active(quiz, finished=finished)


@router.post("/me/quiz/{quiz_id}/finish", response_model=ActiveQuizOut)
async def finish_quiz(
    quiz_id: uuid.UUID, principal: CurrentStudent, session: SessionDep
) -> ActiveQuizOut:
    """ "I'm finished" (Ken, 6 Nov 2026). The teacher sees it. Nothing is handed in, and the
    rest of their account stays closed until the quiz ends."""
    return await _set_finished(session, principal, quiz_id, finished=True)


@router.post("/me/quiz/{quiz_id}/resume", response_model=ActiveQuizOut)
async def resume_quiz(
    quiz_id: uuid.UUID, principal: CurrentStudent, session: SessionDep
) -> ActiveQuizOut:
    """ "Go back and edit": no longer finished, until they say so again."""
    return await _set_finished(session, principal, quiz_id, finished=False)


@router.post("/me/quiz/{quiz_id}/away", status_code=status.HTTP_204_NO_CONTENT)
async def report_away(
    quiz_id: uuid.UUID, body: AwayIn, principal: CurrentStudent, session: SessionDep
) -> None:
    """This child's page went out of sight, or came back: the record marking shows."""
    quiz = await _my_running_quiz(session, principal, quiz_id)
    await record_away(session, quiz, principal.subject_id, away=body.away)
    await session.commit()
