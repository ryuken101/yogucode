"""Homework: the leaves of a sheet, handing in, and when a sheet is returned.

Shared by the student routes (hand in, see it back), the marking routes and the progress
grids, so that "what counts as handed in", "what is the latest hand-in" and "has this
child had their work back" each have exactly one answer.

**A sheet is handed in whole** (Ken's decision): one Hand in snapshots every problem,
including ones the child never opened — those get an attempt with the starter code, so
the marking screen shows "nothing written" rather than an absence nobody can mark. A child
may hand in again until their work is returned; the newest submission counts.

**Late is a flag, never a refusal.** A Year 4 child's homework is often late for reasons
that are not theirs.

**Returned means locked.** Once a child has released feedback on a sheet — a released
mark on any of its problems, or a released note — that sheet is read-only for them.
Corrections happen in a later ladder or homework (and from Phase 9, automatically).
"""

import uuid
from collections.abc import Iterable, Sequence
from dataclasses import dataclass

from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.auth.principal import Principal
from app.classwork import ladder_items, open_attempt
from app.models import (
    Assignment,
    AssignmentNote,
    Attempt,
    AttemptStatus,
    Item,
    Mark,
    Submission,
    SubmissionSource,
)
from app.models.base import utcnow


@dataclass(frozen=True, slots=True)
class Leaf:
    """One attemptable thing on a sheet: a problem without parts, or one part of one."""

    problem: Item
    leaf: Item

    @property
    def label(self) -> str:
        return (
            f"{self.problem.title} ({self.leaf.part_label})"
            if self.leaf.part_label
            else self.problem.title
        )


async def set_leaves(session: AsyncSession, principal: Principal, set_id: uuid.UUID) -> list[Leaf]:
    """A set's problems, expanded to their parts, in the order a child meets them."""
    problems = await ladder_items(session, principal, set_id)
    if not problems:
        return []
    parts = (
        await session.exec(
            select(Item)
            .where(
                col(Item.parent_id).in_([p.id for p in problems]),
                Item.centre_id == principal.centre_id,
            )
            .order_by(col(Item.sort_order))
        )
    ).all()
    by_parent: dict[uuid.UUID, list[Item]] = {}
    for part in parts:
        by_parent.setdefault(part.parent_id, []).append(part)  # type: ignore[arg-type]
    return [
        Leaf(problem, leaf)
        for problem in problems
        for leaf in (by_parent.get(problem.id) or [problem])
    ]


async def latest_submissions(
    session: AsyncSession, principal: Principal, attempt_ids: Iterable[uuid.UUID]
) -> dict[uuid.UUID, Submission]:
    """The newest submission per attempt — the one that is marked."""
    ids = list(attempt_ids)
    if not ids:
        return {}
    rows = (
        await session.exec(
            select(Submission)
            .where(
                col(Submission.attempt_id).in_(ids),
                Submission.centre_id == principal.centre_id,
            )
            .order_by(col(Submission.submitted_at))
        )
    ).all()
    latest: dict[uuid.UUID, Submission] = {}
    for row in rows:
        latest[row.attempt_id] = row
    return latest


async def released_students(
    session: AsyncSession, principal: Principal, assignment: Assignment
) -> set[uuid.UUID]:
    """Every child on this sheet who has had feedback returned to them."""
    from_marks = (
        await session.exec(
            select(Attempt.student_id)
            .join(Mark, col(Mark.attempt_id) == Attempt.id)
            .where(
                Attempt.assignment_id == assignment.id,
                Attempt.centre_id == principal.centre_id,
                col(Mark.released_at).is_not(None),
            )
        )
    ).all()
    from_notes = (
        await session.exec(
            select(AssignmentNote.student_id).where(
                AssignmentNote.assignment_id == assignment.id,
                AssignmentNote.centre_id == principal.centre_id,
                col(AssignmentNote.released_at).is_not(None),
            )
        )
    ).all()
    return set(from_marks) | set(from_notes)


async def is_returned(
    session: AsyncSession, principal: Principal, assignment: Assignment, student_id: uuid.UUID
) -> bool:
    return student_id in await released_students(session, principal, assignment)


async def hand_in(
    session: AsyncSession,
    principal: Principal,
    assignment: Assignment,
    results: dict[uuid.UUID, tuple[int, int]],
) -> list[Submission]:
    """Snapshot every leaf of the sheet for the calling child. The caller commits.

    `results` is the child's browser's check result per attempt id — informational, shown
    to the teacher next to their own re-run. Ids that are not this child's attempts on this
    sheet are ignored rather than trusted.
    """
    now = utcnow()
    late = assignment.due_at is not None and now > assignment.due_at
    submissions = []
    for leaf in await set_leaves(session, principal, assignment.set_id):
        attempt = await open_attempt(session, principal, assignment, leaf.leaf)
        passed, total = results.get(attempt.id, (None, None))
        submission = Submission(
            centre_id=principal.centre_id,
            attempt_id=attempt.id,
            code=attempt.code,
            passed=passed,
            total=total,
            late=late,
            source=SubmissionSource.HAND_IN,
            submitted_at=now,
        )
        attempt.status = AttemptStatus.SUBMITTED
        session.add_all([submission, attempt])
        submissions.append(submission)
    await session.flush()
    return submissions


def correct_from(passed: int | None, total: int | None) -> int:
    """Rubric Correct from a check run: all pass 2, some 1, none 0 (Ken's decision)."""
    if not total or passed is None:
        return 0
    if passed == total:
        return 2
    return 1 if passed > 0 else 0


def leaf_ids(leaves: Sequence[Leaf]) -> list[uuid.UUID]:
    return [leaf.leaf.id for leaf in leaves]
