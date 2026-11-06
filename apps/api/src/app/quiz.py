"""Quizzes: one clock for the class, and handing everyone's work in when it stops.

A quiz is an assignment with `mode='quiz'` (models/assignments.py). Ken's decisions shape
the rest:

- **One clock for the class.** Start sets `started_at` and `ends_at` for everyone; a
  child who arrives late gets what time is left.
- **The clock and the hand-in are two moments.** At `ends_at`, by running out or by Stop,
  the clock reads 0:00: every child's page locks and sends what they last typed. At
  `hand_in_at`, a few seconds later, the work is handed in. Until then saves are still
  accepted. A hand-in at the instant of 0:00 cost children their last typing (6 Nov 2026).
- **Work is handed in automatically**, through the same `hand_in` homework uses, acting
  for each child in the class. Exactly once: finalising locks the assignment row, re-reads
  it, and only an open quiz past its hand-in is finalised.
- **While a quiz runs, it is the only thing a child can change** (`running_quiz_for` is
  checked by every student write path). The pages route to it too, but the server is what
  makes it true.

Finalising happens two ways, so it happens even if one fails: on a timer (`schedule`), and
lazily by any read that notices the hand-in has passed (`finalise_if_due`) — which is also
what catches a quiz whose timer was lost to a restart.
"""

import asyncio
import contextlib
import logging
import uuid
from datetime import datetime

from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.auth.principal import Principal
from app.homework import hand_in
from app.live.hub import hub
from app.models import (
    Assignment,
    AssignmentMode,
    AssignmentStatus,
    Class,
    Enrolment,
    EnrolmentStatus,
    QuizSitting,
)
from app.models.base import new_uuid, utcnow

logger = logging.getLogger(__name__)


def hand_in_time(assignment: Assignment) -> datetime | None:
    """When the work is handed in. `hand_in_at` is empty on a quiz started before it existed."""
    return assignment.hand_in_at or assignment.ends_at


def is_running(assignment: Assignment, now: datetime | None = None) -> bool:
    """Open and not yet handed in: the clock may read 0:00, but saves are still landing."""
    deadline = hand_in_time(assignment)
    return (
        assignment.mode == AssignmentMode.QUIZ
        and assignment.status == AssignmentStatus.OPEN
        and deadline is not None
        and (now or utcnow()) < deadline
    )


async def running_quiz_in_class(
    session: AsyncSession, centre_id: uuid.UUID, class_id: uuid.UUID
) -> Assignment | None:
    """The quiz this class is sitting right now, if any (finalising one that has ended)."""
    open_quizzes = (
        await session.exec(
            select(Assignment).where(
                Assignment.class_id == class_id,
                Assignment.centre_id == centre_id,
                Assignment.mode == AssignmentMode.QUIZ,
                Assignment.status == AssignmentStatus.OPEN,
            )
        )
    ).all()
    running = None
    for quiz in open_quizzes:
        if is_running(quiz):
            running = quiz
        else:
            await finalise_if_due(session, quiz)
    return running


async def running_quiz_for(session: AsyncSession, principal: Principal) -> Assignment | None:
    """The quiz a signed-in child's class is sitting, if any. Lock-down hangs off this."""
    class_ids = (
        await session.exec(
            select(Enrolment.class_id)
            .join(Class, col(Class.id) == Enrolment.class_id)
            .where(
                Enrolment.student_id == principal.subject_id,
                Enrolment.status == EnrolmentStatus.ACTIVE,
                Class.centre_id == principal.centre_id,
            )
        )
    ).all()
    for class_id in class_ids:
        quiz = await running_quiz_in_class(session, principal.centre_id, class_id)
        if quiz is not None:
            return quiz
    return None


async def finalise_if_due(session: AsyncSession, quiz: Assignment) -> bool:
    """Hand in every child's work and close the quiz, if it is open and past its hand-in.

    Idempotent and safe to race: the row is locked, re-read, and only an open quiz is
    closed. `populate_existing` is what makes it a re-read: without it the session returns
    the copy it already holds, still "open", and a second caller hands everything in again.
    Returns True if this call did the closing. Commits.
    """
    deadline = hand_in_time(quiz)
    if quiz.mode != AssignmentMode.QUIZ or deadline is None or utcnow() < deadline:
        return False
    locked = (
        await session.exec(
            select(Assignment)
            .where(Assignment.id == quiz.id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    ).one()
    if locked.status != AssignmentStatus.OPEN:
        await session.commit()
        return False

    students = (
        await session.exec(
            select(Enrolment.student_id).where(
                Enrolment.class_id == locked.class_id,
                Enrolment.status == EnrolmentStatus.ACTIVE,
            )
        )
    ).all()
    for student_id in students:
        # Acting for each child: `hand_in` only reads the principal's centre and subject.
        as_child = Principal(kind="student", subject_id=student_id, centre_id=locked.centre_id)
        await hand_in(session, as_child, locked, {})
    await _end_absences(session, locked)
    locked.status = AssignmentStatus.CLOSED
    session.add(locked)
    await session.commit()
    await hub.to_students(locked.class_id, {"type": "quiz_ended", "quiz_id": str(locked.id)})
    await hub.to_teachers(locked.class_id, {"type": "quiz_ended", "quiz_id": str(locked.id)})
    return True


async def hand_in_for_removed_child(
    session: AsyncSession, centre_id: uuid.UUID, class_id: uuid.UUID, student_id: uuid.UUID
) -> None:
    """A child is taken out of a class mid-quiz: what they have saved is handed in now, since
    `finalise_if_due` only reaches children still enrolled (Ken, 6 Nov 2026). The caller commits.
    """
    quiz = await running_quiz_in_class(session, centre_id, class_id)
    if quiz is not None:
        as_child = Principal(kind="student", subject_id=student_id, centre_id=centre_id)
        await hand_in(session, as_child, quiz, {})
        await close_absence(session, quiz, student_id)


# --- one child's sitting: "I'm finished", and leaving the page ------------------------------


async def sitting_for(
    session: AsyncSession, quiz: Assignment, student_id: uuid.UUID
) -> QuizSitting:
    """This child's row, created if need be and locked: two tabs may report at once."""
    await session.exec(
        pg_insert(QuizSitting)
        .values(
            id=new_uuid(),
            centre_id=quiz.centre_id,
            assignment_id=quiz.id,
            student_id=student_id,
            away_count=0,
            away_seconds=0,
        )
        .on_conflict_do_nothing(constraint="uq_quiz_sittings_assignment_student")
    )
    return (
        await session.exec(
            select(QuizSitting)
            .where(QuizSitting.assignment_id == quiz.id, QuizSitting.student_id == student_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    ).one()


def _join_absence(sitting: QuizSitting, quiz: Assignment, now: datetime) -> None:
    """Count the absence in progress, up to the end of the clock at most: time after 0:00
    isn't time spent away from a quiz."""
    if sitting.left_at is None:
        return
    until = min(now, quiz.ends_at) if quiz.ends_at is not None else now
    sitting.away_seconds += max(0, round((until - sitting.left_at).total_seconds()))
    sitting.left_at = None


async def record_away(
    session: AsyncSession, quiz: Assignment, student_id: uuid.UUID, *, away: bool
) -> None:
    """They left the page, or came back. Timed by the server's clock. The caller commits."""
    sitting = await sitting_for(session, quiz, student_id)
    now = utcnow()
    if away and sitting.left_at is None:
        sitting.left_at = now
        sitting.away_count += 1
    elif not away:
        _join_absence(sitting, quiz, now)
    sitting.updated_at = now
    session.add(sitting)


async def close_absence(session: AsyncSession, quiz: Assignment, student_id: uuid.UUID) -> None:
    sitting = (
        await session.exec(
            select(QuizSitting).where(
                QuizSitting.assignment_id == quiz.id, QuizSitting.student_id == student_id
            )
        )
    ).one_or_none()
    if sitting is not None and sitting.left_at is not None:
        _join_absence(sitting, quiz, utcnow())
        session.add(sitting)


async def _end_absences(session: AsyncSession, quiz: Assignment) -> None:
    """A child still away when the quiz closes never reports coming back."""
    away = (
        await session.exec(
            select(QuizSitting).where(
                QuizSitting.assignment_id == quiz.id, col(QuizSitting.left_at).is_not(None)
            )
        )
    ).all()
    now = utcnow()
    for sitting in away:
        _join_absence(sitting, quiz, now)
        session.add(sitting)


_timers: dict[uuid.UUID, asyncio.Task[None]] = {}


def schedule(
    quiz_id: uuid.UUID,
    class_id: uuid.UUID,
    ends_at: datetime,
    hand_in_at: datetime,
    *,
    announce: bool = True,
) -> None:
    """Say the clock has stopped at `ends_at` and finalise at `hand_in_at`, on a fresh session
    of its own. Replaces any earlier timer for the same quiz — Stop brings the end forward,
    and has already said so, hence `announce=False`."""
    previous = _timers.pop(quiz_id, None)
    if previous is not None:
        previous.cancel()

    async def run() -> None:
        from app.db import async_session_factory

        await asyncio.sleep(max(0.0, (ends_at - utcnow()).total_seconds()))
        if announce:
            message = {
                "type": "quiz_ending",
                "quiz_id": str(quiz_id),
                "ends_at": ends_at.isoformat(),
            }
            await hub.to_students(class_id, message)
            await hub.to_teachers(class_id, message)
        await asyncio.sleep(max(0.0, (hand_in_at - utcnow()).total_seconds()))
        try:
            async with async_session_factory() as session:
                quiz = await session.get(Assignment, quiz_id)
                if quiz is not None:
                    await finalise_if_due(session, quiz)
        except Exception:  # a lost timer is caught by the lazy path; say so in the log
            logger.exception("quiz %s: timed finalise failed", quiz_id)
        finally:
            _timers.pop(quiz_id, None)

    _timers[quiz_id] = asyncio.get_running_loop().create_task(run())


def cancel_all() -> None:
    for task in _timers.values():
        with contextlib.suppress(Exception):
            task.cancel()
    _timers.clear()
