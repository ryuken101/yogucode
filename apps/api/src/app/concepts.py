"""The centre's concept tree (Ken, 21 Nov 2026).

Teachers shape it: sub-skills under any tag, as deep as they like, any tag moved or
deleted with its branch. That includes the built-in tags, which are global rows shared by
every centre and edited only as YAML (`seed/concepts.yaml`). So a teacher never edits a
global row: the centre's **first edit copies the global taxonomy into the centre**
(`own_taxonomy`), and from then on every tag the centre sees is its own.

The copy keeps each key, so `list_visible_concepts`' rule — a centre row replaces the
global row with its key — hides the globals with no other change, and problem files that
name a tag by key still find it. The centre's tags, lesson links and snippets move from
the global rows to the copies in the same transaction. A global added to the YAML later
shows up beside the copies until the next edit copies it too.
"""

import uuid
from collections.abc import Sequence

from sqlalchemy import update
from sqlmodel import col, delete, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.auth.principal import Principal
from app.folders import subtree
from app.models import (
    Concept,
    ConceptStatus,
    FeedbackSnippet,
    Item,
    ItemConcept,
    Lesson,
    LessonConcept,
)
from app.scoping import list_visible_concepts

__all__ = ["ancestors", "branch", "current_ids", "own_taxonomy"]


async def own_taxonomy(session: AsyncSession, centre_id: uuid.UUID) -> dict[uuid.UUID, uuid.UUID]:
    """Copy every global concept the centre has no row for, and move the centre's uses of
    the global rows onto its own. Returns {global id: the centre's id}. Idempotent; flushes,
    never commits — the caller's edit and the copy go together or not at all."""
    globals_ = (
        await session.exec(
            select(Concept).where(
                col(Concept.centre_id).is_(None), Concept.status != ConceptStatus.ARCHIVED
            )
        )
    ).all()
    if not globals_:
        return {}
    by_key = {
        c.key: c
        for c in (await session.exec(select(Concept).where(Concept.centre_id == centre_id))).all()
    }
    fresh: list[tuple[Concept, Concept]] = []
    for original in globals_:
        if original.key not in by_key:
            copy = Concept(
                centre_id=centre_id,
                key=original.key,
                label=original.label,
                sort_order=original.sort_order,
                status=original.status,
            )
            session.add(copy)
            by_key[original.key] = copy
            fresh.append((original, copy))
    await session.flush()

    by_id = {g.id: g for g in globals_}
    for original, copy in fresh:
        parent = by_id.get(original.parent_id) if original.parent_id else None
        if parent is not None:
            copy.parent_id = by_key[parent.key].id
            session.add(copy)

    mapping = {g.id: by_key[g.key].id for g in globals_}
    await _move_uses(session, centre_id, mapping)
    await session.flush()
    return mapping


async def _move_uses(
    session: AsyncSession, centre_id: uuid.UUID, mapping: dict[uuid.UUID, uuid.UUID]
) -> None:
    """The centre's problem tags, lesson links and snippets, from global rows to its own."""
    old = list(mapping)
    tags = (
        await session.exec(
            select(ItemConcept)
            .join(Item, col(Item.id) == ItemConcept.item_id)
            .where(Item.centre_id == centre_id, col(ItemConcept.concept_id).in_(old))
        )
    ).all()
    moved_tags = [(t.item_id, mapping[t.concept_id], t.is_primary) for t in tags]
    links = (
        await session.exec(
            select(LessonConcept)
            .join(Lesson, col(Lesson.id) == LessonConcept.lesson_id)
            .where(Lesson.centre_id == centre_id, col(LessonConcept.concept_id).in_(old))
        )
    ).all()
    moved_links = [(link.lesson_id, mapping[link.concept_id]) for link in links]

    if tags:
        await session.exec(
            delete(ItemConcept).where(
                col(ItemConcept.item_id).in_({t.item_id for t in tags}),
                col(ItemConcept.concept_id).in_(old),
            )
        )
    if links:
        await session.exec(
            delete(LessonConcept).where(
                col(LessonConcept.lesson_id).in_({link.lesson_id for link in links}),
                col(LessonConcept.concept_id).in_(old),
            )
        )
    await session.flush()

    # A problem already tagged with the centre's row for that key keeps one tag, and stays
    # primary if either was.
    existing = (
        {
            (t.item_id, t.concept_id): t
            for t in (
                await session.exec(
                    select(ItemConcept).where(
                        col(ItemConcept.item_id).in_({item for item, _, _ in moved_tags}),
                        col(ItemConcept.concept_id).in_({new for _, new, _ in moved_tags}),
                    )
                )
            ).all()
        }
        if moved_tags
        else {}
    )
    for item_id, concept_id, primary in moved_tags:
        found = existing.get((item_id, concept_id))
        if found is None:
            found = ItemConcept(item_id=item_id, concept_id=concept_id, is_primary=primary)
            existing[(item_id, concept_id)] = found
        else:
            found.is_primary = found.is_primary or primary
        session.add(found)

    linked = (
        {
            (link.lesson_id, link.concept_id)
            for link in (
                await session.exec(
                    select(LessonConcept).where(
                        col(LessonConcept.lesson_id).in_({lesson for lesson, _ in moved_links}),
                    )
                )
            ).all()
        }
        if moved_links
        else set()
    )
    for lesson_id, concept_id in moved_links:
        if (lesson_id, concept_id) not in linked:
            linked.add((lesson_id, concept_id))
            session.add(LessonConcept(lesson_id=lesson_id, concept_id=concept_id))

    for old_id, new_id in mapping.items():
        await session.exec(
            update(FeedbackSnippet)
            .where(
                FeedbackSnippet.centre_id == centre_id,  # type: ignore[arg-type]
                FeedbackSnippet.concept_id == old_id,  # type: ignore[arg-type]
            )
            .values(concept_id=new_id)
        )


def branch(concepts: Sequence[Concept], root: uuid.UUID) -> set[uuid.UUID]:
    """A tag and every sub-skill under it, at any depth."""
    return subtree(concepts, root)


def ancestors(concepts: Sequence[Concept], concept_id: uuid.UUID) -> list[uuid.UUID]:
    """The tag's parent, its parent's parent, … up to the top. Stops at a cycle, which the
    move route refuses, so that only ever guards against bad data."""
    parent_of = {c.id: c.parent_id for c in concepts}
    found: list[uuid.UUID] = []
    current = parent_of.get(concept_id)
    while current is not None and current not in found and current != concept_id:
        found.append(current)
        current = parent_of.get(current)
    return found


async def current_ids(
    session: AsyncSession, principal: Principal, ids: Sequence[uuid.UUID]
) -> dict[uuid.UUID, uuid.UUID] | None:
    """Each id as the centre now sees it, or None if any is not a tag it can see.

    A screen opened before the centre's first tree edit still holds the global rows' ids;
    those map to the centre's copy with the same key, so saving it works rather than
    failing on a tag the teacher can plainly see.
    """
    visible = await list_visible_concepts(session, principal)
    seen = {c.id for c in visible}
    stale = set(ids) - seen
    moved: dict[uuid.UUID, uuid.UUID] = {}
    if stale:
        by_key = {c.key: c.id for c in visible}
        for row in (
            await session.exec(
                select(Concept).where(col(Concept.id).in_(stale), col(Concept.centre_id).is_(None))
            )
        ).all():
            if row.key in by_key:
                moved[row.id] = by_key[row.key]
        if stale - moved.keys():
            return None
    return {i: moved.get(i, i) for i in ids}
