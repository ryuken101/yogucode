"""The curriculum: courses, their units, and the lessons inside each unit.

This is the scope and sequence as data — spec §3.7's "lift Magikid's scope and sequence
verbatim", and §10's test that a different course (VEX IQ) is a configuration change rather
than a code change. A lesson lists the concepts it *introduces*, which is what gives
"today's concept" and "a prior concept" in a problem ladder a meaning, and what lets Phase 8
mastery be read in terms of lessons the boss already thinks in.

**`centre_id` is on units and lessons as well as on courses**, although it is derivable
from the parent. Every scoped lookup is then a single-table filter, which is the shape
`app.scoping` relies on: a lesson reachable only through a three-table join is a lesson
whose tenancy filter is three times as easy to get wrong. The routes are the only writers,
and they copy the parent's centre.

`sort_order` is spaced by ten for the same reason as `concepts.yaml`: a lesson can be
slotted between two others without renumbering the unit.
"""

import uuid
from enum import StrEnum

from sqlalchemy import CheckConstraint, String
from sqlmodel import Field, SQLModel

from app.models.base import TimestampMixin, new_uuid


class CurriculumStatus(StrEnum):
    ACTIVE = "active"
    ARCHIVED = "archived"


class Course(TimestampMixin, table=True):
    __tablename__ = "courses"
    __table_args__ = (CheckConstraint("status IN ('active', 'archived')", name="status"),)

    id: uuid.UUID = Field(default_factory=new_uuid, primary_key=True)
    centre_id: uuid.UUID = Field(foreign_key="centres.id", index=True)
    title: str
    status: CurriculumStatus = Field(default=CurriculumStatus.ACTIVE, sa_type=String)


class Unit(TimestampMixin, table=True):
    __tablename__ = "units"
    __table_args__ = (CheckConstraint("status IN ('active', 'archived')", name="status"),)

    id: uuid.UUID = Field(default_factory=new_uuid, primary_key=True)
    centre_id: uuid.UUID = Field(foreign_key="centres.id", index=True)
    course_id: uuid.UUID = Field(foreign_key="courses.id", index=True)
    title: str
    sort_order: int = Field(default=0)
    status: CurriculumStatus = Field(default=CurriculumStatus.ACTIVE, sa_type=String)


class Lesson(TimestampMixin, table=True):
    __tablename__ = "lessons"
    __table_args__ = (CheckConstraint("status IN ('active', 'archived')", name="status"),)

    id: uuid.UUID = Field(default_factory=new_uuid, primary_key=True)
    centre_id: uuid.UUID = Field(foreign_key="centres.id", index=True)
    unit_id: uuid.UUID = Field(foreign_key="units.id", index=True)
    title: str
    sort_order: int = Field(default=0)
    status: CurriculumStatus = Field(default=CurriculumStatus.ACTIVE, sa_type=String)


class LessonConcept(SQLModel, table=True):
    """A concept a lesson introduces.

    A link row with no history of its own: replacing a lesson's concept list is an edit to
    the lesson, not an event in a child's record, so these rows are replaced rather than
    archived. Nothing an attempt or a mark depends on points here.
    """

    __tablename__ = "lesson_concepts"

    lesson_id: uuid.UUID = Field(foreign_key="lessons.id", primary_key=True)
    concept_id: uuid.UUID = Field(foreign_key="concepts.id", primary_key=True, index=True)
