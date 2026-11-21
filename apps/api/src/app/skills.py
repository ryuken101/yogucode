"""How strong a child is on each concept (spec §3.7, Phase 8; Ken, 21 Nov 2026).

Computed on read from attempts, marks and events, like `routers/progress.py`: nothing is
stored, so there is nothing to keep in sync, and changing a rule here re-reads all history.

**Evidence** is one attempt that says something: a mark, a check run, or an answer picked.
An attempt counts toward every tag on its problem (a part with no tags of its own uses its
problem's) and every tag above those in the tree, so Dictionaries learns from .values().
It follows the child, not the class: mastery is the child's, across classes and terms.

- **Outcome** (0–1): the teacher's mark wins once there is one (Correct 0/1/2 → 0, ½, 1);
  until then, the share of checks passing on the last check run, or whether the answer
  picked is right. An attempt with none of these is not evidence.
- **Weight**: how much the child did it on their own. A quiz counts 3, homework 2,
  classwork 1, halved when hints were unlocked or a teacher typed in their editor (Help).
  A quiz still running is not read at all.

**Level**: `secure` needs a weighted success of 0.8 *and* full passes on two different
days — got it once is not got it, which is the retention problem the product exists for.
`learning` is any full pass or a success of a half; `not_yet` is tried without that;
`not_taught` is no evidence and nothing on it set to the class; and `confident` says
whether there is enough evidence (`ENOUGH_WEIGHT`) to trust the level at all.

**Revisit**, each switched on or off per class (`Class.revisit_*`):

- `slipping`: was secure, then missed their latest homework or quiz on it;
- `stuck`: `STUCK_AFTER` tries or more and never a full pass;
- `stale`: secure, but nothing on it for `STALE_DAYS`.

A node also reports whether anything *below* it needs revisiting, so a collapsed branch
never hides a flag.
"""

import uuid
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Literal

from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.concepts import branch
from app.models import (
    Assignment,
    AssignmentMode,
    Attempt,
    Concept,
    ConceptStatus,
    Event,
    EventType,
    Item,
    ItemConcept,
    ItemKind,
    Mark,
    SetItem,
)
from app.quiz import is_running

Level = Literal["not_taught", "not_yet", "learning", "secure"]
Flag = Literal["slipping", "stuck", "stale"]

MODE_WEIGHT = {
    AssignmentMode.CLASSWORK: 1.0,
    AssignmentMode.HOMEWORK: 2.0,
    AssignmentMode.QUIZ: 3.0,
}
HELPED = 0.5
SECURE_SUCCESS = 0.8
SECURE_DAYS = 2
LEARNING_SUCCESS = 0.5
ENOUGH_WEIGHT = 3.0
STUCK_AFTER = 3
STALE_DAYS = 21
INDEPENDENT = (AssignmentMode.HOMEWORK, AssignmentMode.QUIZ)


@dataclass(frozen=True)
class Evidence:
    attempt_id: uuid.UUID
    student_id: uuid.UUID
    assignment_id: uuid.UUID
    assignment_title: str
    mode: AssignmentMode
    item_id: uuid.UUID
    item_title: str
    # The tags on the problem itself; the tree adds what is above them.
    concept_ids: frozenset[uuid.UUID]
    outcome: float
    hints: int
    helped: bool
    marked: bool
    at: datetime

    @property
    def weight(self) -> float:
        base = MODE_WEIGHT[self.mode]
        return base * HELPED if self.hints or self.helped else base

    @property
    def passed(self) -> bool:
        return self.outcome >= 1.0


@dataclass(frozen=True)
class RevisitSettings:
    slipping: bool = True
    stuck: bool = True
    stale: bool = True


@dataclass
class Skill:
    level: Level
    confident: bool
    revisit: list[Flag] = field(default_factory=list)
    # Something under this node needs revisiting.
    below: bool = False
    evidence: int = 0
    last_seen: datetime | None = None


# --- the rules ------------------------------------------------------------------------


def _level(evidence: Sequence[Evidence]) -> Level:
    weight = sum(e.weight for e in evidence)
    success = sum(e.weight * e.outcome for e in evidence) / weight if weight else 0.0
    pass_days = {e.at.date() for e in evidence if e.passed}
    if success >= SECURE_SUCCESS and len(pass_days) >= SECURE_DAYS:
        return "secure"
    if pass_days or success >= LEARNING_SUCCESS:
        return "learning"
    return "not_yet"


def assess(
    evidence: Iterable[Evidence], settings: RevisitSettings, now: datetime, covered: bool
) -> Skill:
    """One child on one concept, from the evidence for it (its branch's, already gathered)."""
    ordered = sorted(evidence, key=lambda e: e.at)
    if not ordered:
        return Skill(level="not_yet" if covered else "not_taught", confident=False)
    level = _level(ordered)
    flags: list[Flag] = []

    if settings.slipping:
        independent = [i for i, e in enumerate(ordered) if e.mode in INDEPENDENT]
        if independent:
            latest = independent[-1]
            earlier = ordered[:latest]
            if not ordered[latest].passed and earlier and _level(earlier) == "secure":
                flags.append("slipping")
    if settings.stuck and len(ordered) >= STUCK_AFTER and not any(e.passed for e in ordered):
        flags.append("stuck")
    if settings.stale and level == "secure" and now - ordered[-1].at > timedelta(days=STALE_DAYS):
        flags.append("stale")

    return Skill(
        level=level,
        confident=sum(e.weight for e in ordered) >= ENOUGH_WEIGHT,
        revisit=flags,
        evidence=len(ordered),
        last_seen=ordered[-1].at,
    )


def skill_tree(
    concepts: Sequence[Concept],
    evidence: Sequence[Evidence],
    covered: set[uuid.UUID],
    settings: RevisitSettings,
    now: datetime,
) -> dict[uuid.UUID, Skill]:
    """Every node of the tree for one child. A node reads its whole branch's evidence, each
    attempt once however many of the branch's tags it carries."""
    branches = {c.id: branch(concepts, c.id) for c in concepts}
    skills = {
        concept_id: assess(
            [e for e in evidence if e.concept_ids & ids], settings, now, bool(covered & ids)
        )
        for concept_id, ids in branches.items()
    }
    for concept_id, ids in branches.items():
        skills[concept_id].below = any(
            skills[other].revisit for other in ids if other != concept_id
        )
    return skills


# --- reading it from the database ----------------------------------------------------


def _outcome(attempt: Attempt, item: Item, mark: Mark | None) -> float | None:
    if mark is not None:
        return mark.correct / 2
    if item.kind == ItemKind.MCQ:
        if attempt.choice is None or not 0 <= attempt.choice < len(item.options):
            return None
        return 1.0 if item.options[attempt.choice].get("correct") else 0.0
    if attempt.last_total:
        return (attempt.last_passed or 0) / attempt.last_total
    return None


async def _live_tags(
    session: AsyncSession, item_ids: Iterable[uuid.UUID]
) -> dict[uuid.UUID, set[uuid.UUID]]:
    """Each item's tags, leaving out any in the Trash."""
    tags: dict[uuid.UUID, set[uuid.UUID]] = {}
    ids = list(set(item_ids))
    if not ids:
        return tags
    for item_id, concept_id in (
        await session.exec(
            select(ItemConcept.item_id, ItemConcept.concept_id)
            .join(Concept, col(Concept.id) == ItemConcept.concept_id)
            .where(col(ItemConcept.item_id).in_(ids), Concept.status != ConceptStatus.ARCHIVED)
        )
    ).all():
        tags.setdefault(item_id, set()).add(concept_id)
    return tags


async def load_evidence(
    session: AsyncSession, centre_id: uuid.UUID, student_ids: Sequence[uuid.UUID], now: datetime
) -> dict[uuid.UUID, list[Evidence]]:
    """Every child's evidence, from every class they have been in at this centre."""
    found: dict[uuid.UUID, list[Evidence]] = {s: [] for s in student_ids}
    if not student_ids:
        return found
    rows = (
        await session.exec(
            select(Attempt, Assignment)
            .join(Assignment, col(Assignment.id) == Attempt.assignment_id)
            .where(
                col(Attempt.student_id).in_(student_ids),
                Attempt.centre_id == centre_id,
                Assignment.centre_id == centre_id,
                col(Assignment.deleted_at).is_(None),
            )
        )
    ).all()
    rows = [(a, assignment) for a, assignment in rows if not is_running(assignment, now)]
    if not rows:
        return found

    attempt_ids = [a.id for a, _ in rows]
    items = {
        i.id: i
        for i in (
            await session.exec(
                select(Item).where(
                    col(Item.id).in_({a.item_id for a, _ in rows}), Item.centre_id == centre_id
                )
            )
        ).all()
    }
    tags = await _live_tags(
        session, [*items, *(i.parent_id for i in items.values() if i.parent_id)]
    )
    marks = {
        m.attempt_id: m
        for m in (
            await session.exec(select(Mark).where(col(Mark.attempt_id).in_(attempt_ids)))
        ).all()
    }
    helped = set(
        (
            await session.exec(
                select(Event.attempt_id)
                .where(col(Event.attempt_id).in_(attempt_ids), Event.type == EventType.TEACHER_EDIT)
                .distinct()
            )
        ).all()
    )

    for attempt, assignment in rows:
        item = items.get(attempt.item_id)
        if item is None:
            continue
        outcome = _outcome(attempt, item, marks.get(attempt.id))
        if outcome is None:
            continue
        # A part with no tags of its own is about what its problem is about.
        concept_ids = tags.get(item.id) or (tags.get(item.parent_id) if item.parent_id else None)
        if not concept_ids:
            continue
        mark = marks.get(attempt.id)
        found[attempt.student_id].append(
            Evidence(
                attempt_id=attempt.id,
                student_id=attempt.student_id,
                assignment_id=assignment.id,
                assignment_title=assignment.title,
                mode=AssignmentMode(assignment.mode),
                item_id=item.id,
                item_title=item.title,
                concept_ids=frozenset(concept_ids),
                outcome=outcome,
                hints=attempt.hints_unlocked,
                helped=attempt.id in helped,
                marked=mark is not None,
                at=mark.updated_at if mark is not None else attempt.updated_at,
            )
        )
    return found


async def class_coverage(
    session: AsyncSession, centre_id: uuid.UUID, class_id: uuid.UUID
) -> set[uuid.UUID]:
    """The tags on anything set to the class — what it has been taught or asked, so a
    concept no child has touched yet reads "not yet" there rather than "not taught"."""
    set_ids = (
        await session.exec(
            select(Assignment.set_id).where(
                Assignment.class_id == class_id,
                Assignment.centre_id == centre_id,
                col(Assignment.deleted_at).is_(None),
            )
        )
    ).all()
    if not set_ids:
        return set()
    item_ids = set(
        (await session.exec(select(SetItem.item_id).where(col(SetItem.set_id).in_(set_ids)))).all()
    )
    parts = (await session.exec(select(Item.id).where(col(Item.parent_id).in_(item_ids)))).all()
    tags = await _live_tags(session, [*item_ids, *parts])
    return set().union(*tags.values()) if tags else set()
