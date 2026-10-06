"""Lesson ladders, and opening them for a class as classwork.

A lesson's **ladder** is its problem set (spec §3.3): 1–2 one-dot problems on today's
concept, a two-dot mixing in a prior one, a three-dot extension — so that nobody runs out
of work. It belongs to the lesson, not to a class, because every class on the course
climbs the same ladder.

**Classwork opens itself.** When a teacher sets a class's "today's lesson", that lesson's
ladder becomes an open classwork assignment for the class. If the ladder is written after
the lesson was chosen, saving it does the same. Choosing the lesson again later reuses the
same assignment (one per class per ladder), so a child's attempts from last week are where
they left them.

Only published problems can be put on a ladder, and a ladder keeps the exact versions it
was given: a newer version of a problem does not replace an older one under a child
mid-lesson. The teacher swaps it in when they choose to.
"""

import uuid
from collections.abc import Sequence

from fastapi import HTTPException, status
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlmodel import col, delete, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.auth.principal import Principal
from app.models import (
    Assignment,
    AssignmentMode,
    AssignmentStatus,
    Attempt,
    AttemptStatus,
    Class,
    ClassStatus,
    Item,
    ItemStatus,
    Lesson,
    ProblemSet,
    SetItem,
    SetStatus,
)
from app.models.base import new_uuid, utcnow

MAX_LADDER = 12
CLASSWORK_SETTINGS = {"completions": True, "hints": True}


async def get_ladder(
    session: AsyncSession, principal: Principal, lesson: Lesson
) -> ProblemSet | None:
    """The lesson's live ladder set, if it has one. `lesson` came through scoping."""
    return (
        await session.exec(
            select(ProblemSet).where(
                ProblemSet.lesson_id == lesson.id,
                ProblemSet.centre_id == principal.centre_id,
                ProblemSet.status == SetStatus.ACTIVE,
            )
        )
    ).one_or_none()


async def ladder_items(
    session: AsyncSession, principal: Principal, set_id: uuid.UUID
) -> list[Item]:
    """A set's problems, in order. Filtered by centre on the items as well as the set."""
    rows = (
        await session.exec(
            select(Item)
            .join(SetItem, col(SetItem.item_id) == Item.id)
            .where(SetItem.set_id == set_id, Item.centre_id == principal.centre_id)
            .order_by(col(SetItem.sort_order))
        )
    ).all()
    return list(rows)


async def newest_version(session: AsyncSession, principal: Principal, item: Item) -> Item | None:
    """The published version that replaced `item`, following the chain; None if it is current."""
    current = item
    for _ in range(50):  # a chain longer than this is a bug, not a history
        successor = (
            await session.exec(
                select(Item).where(
                    Item.supersedes_id == current.id,
                    Item.centre_id == principal.centre_id,
                    col(Item.status).in_([ItemStatus.PUBLISHED, ItemStatus.SUPERSEDED]),
                )
            )
        ).first()
        if successor is None:
            break
        current = successor
    if current.id == item.id or current.status != ItemStatus.PUBLISHED:
        return None
    return current


def _unprocessable(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=detail)


async def check_set_items(
    session: AsyncSession,
    principal: Principal,
    item_ids: Sequence[uuid.UUID],
    *,
    already: set[uuid.UUID],
    limit: int = MAX_LADDER,
) -> None:
    """Refuse a problem list that cannot go on a set. Shared by ladders and homework.

    Every id must be a top-level problem at this centre that is published — or that is
    `already` on the set, which is how a superseded version stays until it is swapped.
    """
    if len(set(item_ids)) != len(item_ids):
        raise _unprocessable("A problem is on the list twice")
    if len(item_ids) > limit:
        raise _unprocessable(f"A list has at most {limit} problems")
    found = {
        item.id: item
        for item in (
            await session.exec(
                select(Item).where(
                    col(Item.id).in_(list(item_ids)),
                    Item.centre_id == principal.centre_id,
                    col(Item.parent_id).is_(None),
                )
            )
        ).all()
    }
    for item_id in item_ids:
        item = found.get(item_id)
        if item is None:
            # Another centre's problem, or none at all: the same answer as a 404 would give.
            raise _unprocessable("One or more problems are not available")
        if item.status != ItemStatus.PUBLISHED and item_id not in already:
            raise _unprocessable(f"“{item.title}” is not published yet")


async def replace_set_items(
    session: AsyncSession, set_id: uuid.UUID, item_ids: Sequence[uuid.UUID]
) -> None:
    """Make a set's problems exactly `item_ids`, in order. Checked by `check_set_items`."""
    await session.exec(delete(SetItem).where(col(SetItem.set_id) == set_id))  # type: ignore[call-overload]
    session.add_all(
        SetItem(set_id=set_id, item_id=item_id, sort_order=order)
        for order, item_id in enumerate(item_ids)
    )
    await session.flush()


async def set_ladder(
    session: AsyncSession,
    principal: Principal,
    lesson: Lesson,
    item_ids: Sequence[uuid.UUID],
) -> ProblemSet:
    """Replace a lesson's ladder with `item_ids`, in that order. The caller commits."""
    ladder = await get_ladder(session, principal, lesson)
    already = {i.id for i in await ladder_items(session, principal, ladder.id)} if ladder else set()
    await check_set_items(session, principal, item_ids, already=already)

    if ladder is None:
        ladder = ProblemSet(
            centre_id=principal.centre_id,
            title=lesson.title,
            lesson_id=lesson.id,
            created_by=principal.subject_id,
        )
        session.add(ladder)
        await session.flush()
    await replace_set_items(session, ladder.id, item_ids)
    return ladder


async def ensure_classwork(
    session: AsyncSession, principal: Principal, klass: Class
) -> Assignment | None:
    """Open the class's current lesson's ladder as classwork, if there is one to open.

    Idempotent: an existing classwork assignment for this class and ladder is reopened
    rather than duplicated. The caller commits.
    """
    if klass.current_lesson_id is None or klass.status != ClassStatus.ACTIVE:
        return None
    lesson = await session.get(Lesson, klass.current_lesson_id)
    if lesson is None or lesson.centre_id != principal.centre_id:
        return None
    ladder = await get_ladder(session, principal, lesson)
    if ladder is None or not await ladder_items(session, principal, ladder.id):
        return None

    existing = (
        await session.exec(
            select(Assignment).where(
                Assignment.class_id == klass.id,
                Assignment.set_id == ladder.id,
                Assignment.mode == AssignmentMode.CLASSWORK,
                Assignment.centre_id == principal.centre_id,
            )
        )
    ).one_or_none()
    if existing is not None:
        if existing.status != AssignmentStatus.OPEN:
            existing.status = AssignmentStatus.OPEN
            session.add(existing)
        return existing

    assignment = Assignment(
        centre_id=principal.centre_id,
        class_id=klass.id,
        set_id=ladder.id,
        title=lesson.title,
        mode=AssignmentMode.CLASSWORK,
        settings=dict(CLASSWORK_SETTINGS),
        created_by=principal.subject_id,
    )
    session.add(assignment)
    await session.flush()
    return assignment


async def open_classwork_for_lesson(
    session: AsyncSession, principal: Principal, lesson: Lesson
) -> None:
    """After a ladder is saved: open it in every class that is on this lesson today."""
    classes = (
        await session.exec(
            select(Class).where(
                Class.current_lesson_id == lesson.id,
                Class.centre_id == principal.centre_id,
            )
        )
    ).all()
    for klass in classes:
        await ensure_classwork(session, principal, klass)


async def open_attempt(
    session: AsyncSession, principal: Principal, assignment: Assignment, leaf: Item
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
