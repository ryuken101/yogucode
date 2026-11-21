"""Skills — how strong each child is on each concept (Ken, 21 Nov 2026; `app/skills.py`).

Teacher-only, and every route reads through `app.scoping`: these are children's results.

- **The class grid**: children down, the tree's top-level concepts across, each cell that
  concept's whole branch. It answers "what should I reteach" and "who needs help".
- **One child's tree**: every node, with its level and why it needs revisiting. One child
  at a time, by Ken's choice: a tree for the whole class would be too crowded to read.
- **The evidence** behind one node: which lessons, homework and quizzes said so.
- **The class's revisit switches**: which signs count, per class.

A child's levels come from all their work at the centre, not only this class's: mastery is
theirs and follows them across terms. The class decides only the switches, and which
untouched concepts read "not yet" rather than "not taught".
"""

import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.audit import audit_entry
from app.auth.principal import CurrentTeacher
from app.concepts import branch
from app.db import get_session
from app.models import Class, Enrolment
from app.models.base import utcnow
from app.scoping import get_owned_class, get_owned_student, list_class_roster, list_visible_concepts
from app.skills import (
    Evidence,
    Flag,
    Level,
    RevisitSettings,
    Skill,
    class_coverage,
    load_evidence,
    skill_tree,
)

router = APIRouter(tags=["skills"])

SessionDep = Annotated[AsyncSession, Depends(get_session)]


class RevisitSettingsOut(BaseModel):
    slipping: bool
    stuck: bool
    stale: bool

    @classmethod
    def build(cls, klass: Class) -> "RevisitSettingsOut":
        return cls(
            slipping=klass.revisit_slipping, stuck=klass.revisit_stuck, stale=klass.revisit_stale
        )


class RevisitSettingsPatch(BaseModel):
    slipping: bool | None = None
    stuck: bool | None = None
    stale: bool | None = None


class SkillOut(BaseModel):
    level: Level
    # Enough evidence to trust the level.
    confident: bool
    revisit: list[Flag]
    # Something under this concept needs revisiting.
    below: bool
    evidence: int
    last_seen: datetime | None

    @classmethod
    def build(cls, skill: Skill) -> "SkillOut":
        return cls(
            level=skill.level,
            confident=skill.confident,
            revisit=skill.revisit,
            below=skill.below,
            evidence=skill.evidence,
            last_seen=skill.last_seen,
        )


class SkillColumnOut(BaseModel):
    concept_id: uuid.UUID
    label: str


class SkillRowOut(BaseModel):
    student_id: uuid.UUID
    display_name: str
    cells: list[SkillOut]


class ClassSkillsOut(BaseModel):
    columns: list[SkillColumnOut]
    rows: list[SkillRowOut]
    settings: RevisitSettingsOut


class SkillNodeOut(SkillOut):
    concept_id: uuid.UUID
    label: str
    parent_id: uuid.UUID | None
    sort_order: int


class StudentSkillsOut(BaseModel):
    student_id: uuid.UUID
    display_name: str
    nodes: list[SkillNodeOut]
    settings: RevisitSettingsOut


class EvidenceOut(BaseModel):
    attempt_id: uuid.UUID
    assignment_id: uuid.UUID
    assignment_title: str
    mode: str
    item_id: uuid.UUID
    item_title: str
    outcome: float
    weight: float
    hints: int
    helped: bool
    marked: bool
    at: datetime

    @classmethod
    def build(cls, e: Evidence) -> "EvidenceOut":
        return cls(
            attempt_id=e.attempt_id,
            assignment_id=e.assignment_id,
            assignment_title=e.assignment_title,
            mode=e.mode,
            item_id=e.item_id,
            item_title=e.item_title,
            outcome=e.outcome,
            weight=e.weight,
            hints=e.hints,
            helped=e.helped,
            marked=e.marked,
            at=e.at,
        )


def _settings(klass: Class) -> RevisitSettings:
    return RevisitSettings(
        slipping=klass.revisit_slipping, stuck=klass.revisit_stuck, stale=klass.revisit_stale
    )


async def _enrolled_child(
    session: AsyncSession, principal: CurrentTeacher, klass: Class, student_id: uuid.UUID
):
    """The child, if they are or were in this class; 404 otherwise, as for any other centre's."""
    student = await get_owned_student(session, principal, student_id)
    enrolled = (
        await session.exec(
            select(Enrolment.student_id).where(
                Enrolment.class_id == klass.id, Enrolment.student_id == student.id
            )
        )
    ).first()
    if enrolled is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="student not found")
    return student


@router.get("/classes/{class_id}/skills", response_model=ClassSkillsOut)
async def class_skills(
    class_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep
) -> ClassSkillsOut:
    klass = await get_owned_class(session, principal, class_id)
    roster = await list_class_roster(session, principal, klass.id)
    concepts = await list_visible_concepts(session, principal)
    visible = {c.id for c in concepts}
    tops = sorted(
        (c for c in concepts if c.parent_id is None or c.parent_id not in visible),
        key=lambda c: (c.sort_order, c.label),
    )
    now = utcnow()
    evidence = await load_evidence(
        session, principal.centre_id, [student.id for _, student in roster], now
    )
    covered = await class_coverage(session, principal.centre_id, klass.id)
    settings = _settings(klass)
    rows = []
    for _, student in roster:
        tree = skill_tree(concepts, evidence[student.id], covered, settings, now)
        rows.append(
            SkillRowOut(
                student_id=student.id,
                display_name=student.display_name,
                cells=[SkillOut.build(tree[c.id]) for c in tops],
            )
        )
    return ClassSkillsOut(
        columns=[SkillColumnOut(concept_id=c.id, label=c.label) for c in tops],
        rows=rows,
        settings=RevisitSettingsOut.build(klass),
    )


@router.get("/classes/{class_id}/students/{student_id}/skills", response_model=StudentSkillsOut)
async def student_skills(
    class_id: uuid.UUID, student_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep
) -> StudentSkillsOut:
    klass = await get_owned_class(session, principal, class_id)
    student = await _enrolled_child(session, principal, klass, student_id)
    concepts = await list_visible_concepts(session, principal)
    now = utcnow()
    evidence = await load_evidence(session, principal.centre_id, [student.id], now)
    covered = await class_coverage(session, principal.centre_id, klass.id)
    tree = skill_tree(concepts, evidence[student.id], covered, _settings(klass), now)
    return StudentSkillsOut(
        student_id=student.id,
        display_name=student.display_name,
        nodes=[
            SkillNodeOut(
                concept_id=c.id,
                label=c.label,
                parent_id=c.parent_id,
                sort_order=c.sort_order,
                **SkillOut.build(tree[c.id]).model_dump(),
            )
            for c in concepts
        ],
        settings=RevisitSettingsOut.build(klass),
    )


@router.get(
    "/classes/{class_id}/students/{student_id}/skills/{concept_id}/evidence",
    response_model=list[EvidenceOut],
)
async def skill_evidence(
    class_id: uuid.UUID,
    student_id: uuid.UUID,
    concept_id: uuid.UUID,
    principal: CurrentTeacher,
    session: SessionDep,
) -> list[EvidenceOut]:
    """What a node's level is built from, newest first: the concept and everything under it."""
    klass = await get_owned_class(session, principal, class_id)
    student = await _enrolled_child(session, principal, klass, student_id)
    concepts = await list_visible_concepts(session, principal)
    if concept_id not in {c.id for c in concepts}:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="concept not found")
    ids = branch(concepts, concept_id)
    evidence = (await load_evidence(session, principal.centre_id, [student.id], utcnow()))[
        student.id
    ]
    return [
        EvidenceOut.build(e)
        for e in sorted(evidence, key=lambda e: e.at, reverse=True)
        if e.concept_ids & ids
    ]


@router.patch("/classes/{class_id}/skill-settings", response_model=RevisitSettingsOut)
async def update_skill_settings(
    class_id: uuid.UUID,
    body: RevisitSettingsPatch,
    principal: CurrentTeacher,
    session: SessionDep,
) -> RevisitSettingsOut:
    """Which signs put a concept on the class's revisit lists. Any teacher at the centre,
    as any teacher may open any class."""
    klass = await get_owned_class(session, principal, class_id)
    changed = {
        name: value
        for name, value in body.model_dump(exclude_unset=True).items()
        if value is not None and value != getattr(klass, f"revisit_{name}")
    }
    if changed:
        for name, value in changed.items():
            setattr(klass, f"revisit_{name}", value)
        klass.updated_at = utcnow()
        session.add(klass)
        session.add(audit_entry(principal, "class.skill_settings", "class", klass.id, **changed))
        await session.commit()
        await session.refresh(klass)
    return RevisitSettingsOut.build(klass)
