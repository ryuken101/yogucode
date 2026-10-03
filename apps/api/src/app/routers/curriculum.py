"""The curriculum — courses, units, lessons, and the concepts each lesson introduces.

Teacher-only, centre-scoped, archive-never-delete, as everywhere else. Every lookup goes
through `app.scoping`.

The tree is edited one node at a time (create a unit, rename a lesson) and read whole
(`GET /courses/{id}` returns the full outline), because the screen that uses it shows the
whole course at once and edits one row in place.

Curriculum edits are audited although they touch no child's record. The rule elsewhere is
"every teacher mutation is audited"; the one departure (`documents.py`) is for a child's
own autosave, which is a different case. A course is cheap to audit and occasionally
useful to have answered — "who renamed Unit 3?".
"""

import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlmodel import delete, func, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.audit import audit_entry
from app.auth.principal import CurrentTeacher
from app.classwork import get_ladder as get_lesson_ladder
from app.classwork import ladder_items, newest_version, open_classwork_for_lesson, set_ladder
from app.db import get_session
from app.models import Concept, Course, CurriculumStatus, ItemStatus, Lesson, LessonConcept, Unit
from app.scoping import (
    get_owned_course,
    get_owned_lesson,
    get_owned_unit,
    list_course_outline,
    list_owned_courses,
    list_visible_concepts,
)

router = APIRouter(tags=["curriculum"])

SessionDep = Annotated[AsyncSession, Depends(get_session)]

MAX_TITLE_LENGTH = 120
# Spaced by ten so a row can be slotted between two others — see models/curriculum.py.
SORT_STEP = 10


# --- shapes -------------------------------------------------------------------------


class TitleIn(BaseModel):
    title: str = Field(min_length=1, max_length=MAX_TITLE_LENGTH)


class NodePatch(BaseModel):
    """Every field optional — an absent field means "leave it alone"."""

    title: str | None = Field(default=None, min_length=1, max_length=MAX_TITLE_LENGTH)
    sort_order: int | None = None


class ConceptOut(BaseModel):
    id: uuid.UUID
    key: str
    label: str
    status: str

    @classmethod
    def build(cls, record: Concept) -> "ConceptOut":
        return cls(id=record.id, key=record.key, label=record.label, status=record.status)


class CourseOut(BaseModel):
    id: uuid.UUID
    title: str
    status: CurriculumStatus
    created_at: datetime
    updated_at: datetime

    @classmethod
    def build(cls, record: Course) -> "CourseOut":
        return cls(
            id=record.id,
            title=record.title,
            status=record.status,
            created_at=record.created_at,
            updated_at=record.updated_at,
        )


class LessonOut(BaseModel):
    id: uuid.UUID
    unit_id: uuid.UUID
    title: str
    sort_order: int
    status: CurriculumStatus
    concept_ids: list[uuid.UUID]

    @classmethod
    def build(cls, record: Lesson, concept_ids: list[uuid.UUID]) -> "LessonOut":
        return cls(
            id=record.id,
            unit_id=record.unit_id,
            title=record.title,
            sort_order=record.sort_order,
            status=record.status,
            concept_ids=concept_ids,
        )


class UnitOut(BaseModel):
    id: uuid.UUID
    course_id: uuid.UUID
    title: str
    sort_order: int
    status: CurriculumStatus

    @classmethod
    def build(cls, record: Unit) -> "UnitOut":
        return cls(
            id=record.id,
            course_id=record.course_id,
            title=record.title,
            sort_order=record.sort_order,
            status=record.status,
        )


class UnitTreeOut(UnitOut):
    lessons: list[LessonOut]


class CourseTreeOut(CourseOut):
    units: list[UnitTreeOut]


class LessonConceptsIn(BaseModel):
    concept_ids: list[uuid.UUID] = Field(max_length=18)


# --- concepts -----------------------------------------------------------------------


@router.get("/concepts", response_model=list[ConceptOut])
async def list_concepts(principal: CurrentTeacher, session: SessionDep) -> list[ConceptOut]:
    """The taxonomy a teacher can tag with. Read-only here; it is edited as YAML."""
    return [ConceptOut.build(c) for c in await list_visible_concepts(session, principal)]


# --- courses ------------------------------------------------------------------------


async def _course_tree(
    session: AsyncSession, principal: CurrentTeacher, course: Course, include_archived: bool
) -> CourseTreeOut:
    units, lessons, links = await list_course_outline(
        session, principal, course.id, include_archived
    )
    concepts_by_lesson: dict[uuid.UUID, list[uuid.UUID]] = {}
    for link in links:
        concepts_by_lesson.setdefault(link.lesson_id, []).append(link.concept_id)
    lessons_by_unit: dict[uuid.UUID, list[LessonOut]] = {}
    for lesson in lessons:
        lessons_by_unit.setdefault(lesson.unit_id, []).append(
            LessonOut.build(lesson, sorted(concepts_by_lesson.get(lesson.id, [])))
        )
    return CourseTreeOut(
        **CourseOut.build(course).model_dump(),
        units=[
            UnitTreeOut(
                **UnitOut.build(unit).model_dump(), lessons=lessons_by_unit.get(unit.id, [])
            )
            for unit in units
        ],
    )


@router.post("/courses", response_model=CourseTreeOut, status_code=status.HTTP_201_CREATED)
async def create_course(
    body: TitleIn, principal: CurrentTeacher, session: SessionDep
) -> CourseTreeOut:
    record = Course(centre_id=principal.centre_id, title=body.title.strip())
    session.add(record)
    await session.flush()
    session.add(audit_entry(principal, "course.created", "course", record.id, title=record.title))
    await session.commit()
    await session.refresh(record)
    return CourseTreeOut(**CourseOut.build(record).model_dump(), units=[])


@router.get("/courses", response_model=list[CourseOut])
async def list_courses(
    principal: CurrentTeacher, session: SessionDep, include_archived: bool = False
) -> list[CourseOut]:
    return [
        CourseOut.build(c) for c in await list_owned_courses(session, principal, include_archived)
    ]


@router.get("/courses/{course_id}", response_model=CourseTreeOut)
async def read_course(
    course_id: uuid.UUID,
    principal: CurrentTeacher,
    session: SessionDep,
    include_archived: bool = False,
) -> CourseTreeOut:
    course = await get_owned_course(session, principal, course_id)
    return await _course_tree(session, principal, course, include_archived)


@router.patch("/courses/{course_id}", response_model=CourseOut)
async def rename_course(
    course_id: uuid.UUID, body: TitleIn, principal: CurrentTeacher, session: SessionDep
) -> CourseOut:
    record = await get_owned_course(session, principal, course_id)
    title = body.title.strip()
    if title != record.title:
        record.title = title
        session.add(record)
        session.add(audit_entry(principal, "course.renamed", "course", record.id, title=title))
        await session.commit()
        await session.refresh(record)
    return CourseOut.build(record)


async def _set_course_status(
    course_id: uuid.UUID,
    target: CurriculumStatus,
    principal: CurrentTeacher,
    session: AsyncSession,
) -> CourseOut:
    """Archive or restore a course. Its units and lessons keep their own status.

    Not cascaded: restoring a course should bring back exactly what was there, including a
    unit that had been archived on its own beforehand — a cascade would lose that.
    """
    record = await get_owned_course(session, principal, course_id)
    if record.status != target:
        record.status = target
        session.add(record)
        session.add(audit_entry(principal, f"course.{target.value}", "course", record.id))
        await session.commit()
        await session.refresh(record)
    return CourseOut.build(record)


@router.post("/courses/{course_id}/archive", response_model=CourseOut)
async def archive_course(
    course_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep
) -> CourseOut:
    return await _set_course_status(course_id, CurriculumStatus.ARCHIVED, principal, session)


@router.post("/courses/{course_id}/unarchive", response_model=CourseOut)
async def unarchive_course(
    course_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep
) -> CourseOut:
    return await _set_course_status(course_id, CurriculumStatus.ACTIVE, principal, session)


# --- units --------------------------------------------------------------------------


@router.post(
    "/courses/{course_id}/units", response_model=UnitOut, status_code=status.HTTP_201_CREATED
)
async def create_unit(
    course_id: uuid.UUID, body: TitleIn, principal: CurrentTeacher, session: SessionDep
) -> UnitOut:
    """Add a unit at the end of the course."""
    course = await get_owned_course(session, principal, course_id)
    last = (
        await session.exec(
            select(func.max(Unit.sort_order)).where(
                Unit.course_id == course.id, Unit.centre_id == principal.centre_id
            )
        )
    ).one()
    record = Unit(
        centre_id=course.centre_id,
        course_id=course.id,
        title=body.title.strip(),
        sort_order=(last or 0) + SORT_STEP,
    )
    session.add(record)
    await session.flush()
    session.add(
        audit_entry(
            principal,
            "unit.created",
            "unit",
            record.id,
            course_id=str(course.id),
            title=record.title,
        )
    )
    await session.commit()
    await session.refresh(record)
    return UnitOut.build(record)


def _apply_patch(record: Unit | Lesson, body: NodePatch) -> dict[str, object]:
    changed: dict[str, object] = {}
    if body.title is not None and body.title.strip() != record.title:
        record.title = body.title.strip()
        changed["title"] = record.title
    if body.sort_order is not None and body.sort_order != record.sort_order:
        record.sort_order = body.sort_order
        changed["sort_order"] = record.sort_order
    return changed


@router.patch("/units/{unit_id}", response_model=UnitOut)
async def update_unit(
    unit_id: uuid.UUID, body: NodePatch, principal: CurrentTeacher, session: SessionDep
) -> UnitOut:
    record = await get_owned_unit(session, principal, unit_id)
    changed = _apply_patch(record, body)
    if changed:
        session.add(record)
        session.add(audit_entry(principal, "unit.updated", "unit", record.id, **changed))
        await session.commit()
        await session.refresh(record)
    return UnitOut.build(record)


async def _set_unit_status(
    unit_id: uuid.UUID, target: CurriculumStatus, principal: CurrentTeacher, session: AsyncSession
) -> UnitOut:
    record = await get_owned_unit(session, principal, unit_id)
    if record.status != target:
        record.status = target
        session.add(record)
        session.add(audit_entry(principal, f"unit.{target.value}", "unit", record.id))
        await session.commit()
        await session.refresh(record)
    return UnitOut.build(record)


@router.post("/units/{unit_id}/archive", response_model=UnitOut)
async def archive_unit(
    unit_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep
) -> UnitOut:
    return await _set_unit_status(unit_id, CurriculumStatus.ARCHIVED, principal, session)


@router.post("/units/{unit_id}/unarchive", response_model=UnitOut)
async def unarchive_unit(
    unit_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep
) -> UnitOut:
    return await _set_unit_status(unit_id, CurriculumStatus.ACTIVE, principal, session)


# --- lessons ------------------------------------------------------------------------


async def _lesson_concept_ids(session: AsyncSession, lesson_id: uuid.UUID) -> list[uuid.UUID]:
    """A lesson's concept ids. Tenancy is the caller's: the lesson came through scoping."""
    return sorted(
        (
            await session.exec(
                select(LessonConcept.concept_id).where(LessonConcept.lesson_id == lesson_id)
            )
        ).all()
    )


@router.post(
    "/units/{unit_id}/lessons", response_model=LessonOut, status_code=status.HTTP_201_CREATED
)
async def create_lesson(
    unit_id: uuid.UUID, body: TitleIn, principal: CurrentTeacher, session: SessionDep
) -> LessonOut:
    """Add a lesson at the end of the unit."""
    unit = await get_owned_unit(session, principal, unit_id)
    last = (
        await session.exec(
            select(func.max(Lesson.sort_order)).where(
                Lesson.unit_id == unit.id, Lesson.centre_id == principal.centre_id
            )
        )
    ).one()
    record = Lesson(
        centre_id=unit.centre_id,
        unit_id=unit.id,
        title=body.title.strip(),
        sort_order=(last or 0) + SORT_STEP,
    )
    session.add(record)
    await session.flush()
    session.add(
        audit_entry(
            principal,
            "lesson.created",
            "lesson",
            record.id,
            unit_id=str(unit.id),
            title=record.title,
        )
    )
    await session.commit()
    await session.refresh(record)
    return LessonOut.build(record, [])


@router.patch("/lessons/{lesson_id}", response_model=LessonOut)
async def update_lesson(
    lesson_id: uuid.UUID, body: NodePatch, principal: CurrentTeacher, session: SessionDep
) -> LessonOut:
    record = await get_owned_lesson(session, principal, lesson_id)
    changed = _apply_patch(record, body)
    if changed:
        session.add(record)
        session.add(audit_entry(principal, "lesson.updated", "lesson", record.id, **changed))
        await session.commit()
        await session.refresh(record)
    return LessonOut.build(record, await _lesson_concept_ids(session, record.id))


async def _set_lesson_status(
    lesson_id: uuid.UUID,
    target: CurriculumStatus,
    principal: CurrentTeacher,
    session: AsyncSession,
) -> LessonOut:
    record = await get_owned_lesson(session, principal, lesson_id)
    if record.status != target:
        record.status = target
        session.add(record)
        session.add(audit_entry(principal, f"lesson.{target.value}", "lesson", record.id))
        await session.commit()
        await session.refresh(record)
    return LessonOut.build(record, await _lesson_concept_ids(session, record.id))


@router.post("/lessons/{lesson_id}/archive", response_model=LessonOut)
async def archive_lesson(
    lesson_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep
) -> LessonOut:
    return await _set_lesson_status(lesson_id, CurriculumStatus.ARCHIVED, principal, session)


@router.post("/lessons/{lesson_id}/unarchive", response_model=LessonOut)
async def unarchive_lesson(
    lesson_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep
) -> LessonOut:
    return await _set_lesson_status(lesson_id, CurriculumStatus.ACTIVE, principal, session)


@router.put("/lessons/{lesson_id}/concepts", response_model=LessonOut)
async def set_lesson_concepts(
    lesson_id: uuid.UUID, body: LessonConceptsIn, principal: CurrentTeacher, session: SessionDep
) -> LessonOut:
    """Replace the concepts a lesson introduces.

    Every id must be a concept this centre can see — a global one, or the centre's own.
    Accepting any concept id would let a centre tag with another centre's private
    concept, which is a cross-tenant reference even if nothing reads through it yet. An
    unknown id is a 422 naming nothing, the same as a missing one would be.
    """
    record = await get_owned_lesson(session, principal, lesson_id)
    wanted = set(body.concept_ids)
    visible = {c.id for c in await list_visible_concepts(session, principal)}
    if not wanted <= visible:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="One or more concepts are not available",
        )

    current = set(await _lesson_concept_ids(session, record.id))
    if wanted != current:
        await session.exec(delete(LessonConcept).where(LessonConcept.lesson_id == record.id))  # type: ignore[arg-type]
        session.add_all(LessonConcept(lesson_id=record.id, concept_id=cid) for cid in wanted)
        session.add(
            audit_entry(
                principal,
                "lesson.concepts_set",
                "lesson",
                record.id,
                concept_ids=sorted(str(cid) for cid in wanted),
            )
        )
        await session.commit()
    return LessonOut.build(record, sorted(wanted))


# --- ladders ------------------------------------------------------------------------


class LadderItemOut(BaseModel):
    id: uuid.UUID
    title: str
    difficulty: int
    status: ItemStatus
    version: int
    # Set when a newer published version exists — the teacher may want to swap it in.
    newer_version_id: uuid.UUID | None


class LadderIn(BaseModel):
    item_ids: list[uuid.UUID] = Field(max_length=12)


async def _ladder_out(
    session: AsyncSession, principal: CurrentTeacher, lesson: Lesson
) -> list[LadderItemOut]:
    ladder = await get_lesson_ladder(session, principal, lesson)
    if ladder is None:
        return []
    out = []
    for item in await ladder_items(session, principal, ladder.id):
        newer = await newest_version(session, principal, item)
        out.append(
            LadderItemOut(
                id=item.id,
                title=item.title,
                difficulty=item.difficulty,
                status=item.status,
                version=item.version,
                newer_version_id=newer.id if newer else None,
            )
        )
    return out


@router.get("/lessons/{lesson_id}/ladder", response_model=list[LadderItemOut])
async def read_ladder(
    lesson_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep
) -> list[LadderItemOut]:
    lesson = await get_owned_lesson(session, principal, lesson_id)
    return await _ladder_out(session, principal, lesson)


@router.put("/lessons/{lesson_id}/ladder", response_model=list[LadderItemOut])
async def save_ladder(
    lesson_id: uuid.UUID, body: LadderIn, principal: CurrentTeacher, session: SessionDep
) -> list[LadderItemOut]:
    """Replace the lesson's ladder, and open it in any class that is on this lesson today."""
    lesson = await get_owned_lesson(session, principal, lesson_id)
    ladder = await set_ladder(session, principal, lesson, body.item_ids)
    await open_classwork_for_lesson(session, principal, lesson)
    session.add(
        audit_entry(
            principal,
            "lesson.ladder_set",
            "lesson",
            lesson.id,
            set_id=str(ladder.id),
            item_ids=[str(i) for i in body.item_ids],
        )
    )
    await session.commit()
    return await _ladder_out(session, principal, lesson)
