"""Quizzes: one clock for the class, and handing everyone's work in when it stops.

A quiz is an assignment with `mode='quiz'` (models/assignments.py). Ken's decisions shape
the rest:

- **One clock for the class.** Start sets `started_at` and `ends_at` for everyone; a
  child who arrives late gets what time is left. Stop does not end it on the spot — it
  moves `ends_at` a few seconds ahead, so every child's last keystrokes autosave first.
- **Work is handed in automatically at the end**, through the same `hand_in` homework
  uses, acting for each child in the class. Exactly once: finalising locks the assignment
  row, and only an open quiz past its end is finalised.
- **While a quiz runs, it is the only thing a child can change** (`running_quiz_for` is
  checked by every student write path). The pages route to it too, but the server is what
  makes it true.

Finalising happens three ways, so it happens even if one fails: on a timer at `ends_at`
(`schedule`), and lazily by any read that notices the end has passed
(`finalise_if_due`) — which is also what catches a quiz whose timer was lost to a restart.
"""

import asyncio
import contextlib
import logging
import uuid
from datetime import datetime

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
)
from app.models.base import utcnow

logger = logging.getLogger(__name__)


def is_running(assignment: Assignment, now: datetime | None = None) -> bool:
    return (
        assignment.mode == AssignmentMode.QUIZ
        and assignment.status == AssignmentStatus.OPEN
        and assignment.ends_at is not None
        and (now or utcnow()) < assignment.ends_at
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
    """Hand in every child's work and close the quiz, if it is open and past its end.

    Idempotent and safe to race: the row is locked, re-read, and only an open quiz is
    closed. Returns True if this call did the closing. Commits.
    """
    if quiz.mode != AssignmentMode.QUIZ or quiz.ends_at is None or utcnow() < quiz.ends_at:
        return False
    locked = (
        await session.exec(select(Assignment).where(Assignment.id == quiz.id).with_for_update())
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
    locked.status = AssignmentStatus.CLOSED
    session.add(locked)
    await session.commit()
    await hub.to_students(locked.class_id, {"type": "quiz_ended", "quiz_id": str(locked.id)})
    await hub.to_teachers(locked.class_id, {"type": "quiz_ended", "quiz_id": str(locked.id)})
    return True


_timers: dict[uuid.UUID, asyncio.Task[None]] = {}


def schedule(quiz_id: uuid.UUID, ends_at: datetime) -> None:
    """Finalise the quiz at `ends_at`, on a fresh session of its own. Replaces any earlier
    timer for the same quiz — Stop brings the end forward."""
    previous = _timers.pop(quiz_id, None)
    if previous is not None:
        previous.cancel()

    async def run() -> None:
        from app.db import async_session_factory

        await asyncio.sleep(max(0.0, (ends_at - utcnow()).total_seconds()))
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
