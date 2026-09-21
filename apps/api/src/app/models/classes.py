"""Classes, their teachers, their enrolments, and their join codes."""

import uuid
from datetime import datetime
from enum import StrEnum

from sqlalchemy import CheckConstraint, DateTime, String, UniqueConstraint
from sqlmodel import Field, SQLModel

from app.models.base import TimestampMixin, new_uuid, utcnow


class ClassStatus(StrEnum):
    ACTIVE = "active"
    ARCHIVED = "archived"


class ClassTeacherRole(StrEnum):
    LEAD = "lead"
    ASSISTANT = "assistant"


class EnrolmentStatus(StrEnum):
    ACTIVE = "active"
    WITHDRAWN = "withdrawn"


class Class(TimestampMixin, table=True):
    __tablename__ = "classes"
    __table_args__ = (CheckConstraint("status IN ('active', 'archived')", name="status"),)

    id: uuid.UUID = Field(default_factory=new_uuid, primary_key=True)
    centre_id: uuid.UUID = Field(foreign_key="centres.id", index=True)
    name: str
    term_label: str | None = Field(default=None)
    status: ClassStatus = Field(default=ClassStatus.ACTIVE, sa_type=String)


class ClassTeacher(TimestampMixin, table=True):
    __tablename__ = "class_teachers"
    __table_args__ = (CheckConstraint("role IN ('lead', 'assistant')", name="role"),)

    class_id: uuid.UUID = Field(foreign_key="classes.id", primary_key=True)
    user_id: uuid.UUID = Field(foreign_key="users.id", primary_key=True)
    role: ClassTeacherRole = Field(default=ClassTeacherRole.LEAD, sa_type=String)


class Enrolment(SQLModel, table=True):
    """A student's membership of a class for a term.

    Withdrawal sets status; it never deletes the row. A student leaving mid-term must
    not vaporise a term of history.
    """

    __tablename__ = "enrolments"
    __table_args__ = (
        UniqueConstraint("class_id", "student_id", name="uq_enrolments_class_student"),
        CheckConstraint("status IN ('active', 'withdrawn')", name="status"),
    )

    id: uuid.UUID = Field(default_factory=new_uuid, primary_key=True)
    class_id: uuid.UUID = Field(foreign_key="classes.id", index=True)
    student_id: uuid.UUID = Field(foreign_key="students.id", index=True)
    status: EnrolmentStatus = Field(default=EnrolmentStatus.ACTIVE, sa_type=String)
    joined_at: datetime = Field(default_factory=utcnow, sa_type=DateTime(timezone=True))
    withdrawn_at: datetime | None = Field(default=None, sa_type=DateTime(timezone=True))


class ClassJoinCode(SQLModel, table=True):
    """A short code a teacher reads out so students can find their class at /join.

    Rotating a code creates a new row and sets revoked_at on the old one, so an old
    code stops working immediately rather than at expiry.
    """

    __tablename__ = "class_join_codes"

    id: uuid.UUID = Field(default_factory=new_uuid, primary_key=True)
    class_id: uuid.UUID = Field(foreign_key="classes.id", index=True)
    code: str = Field(unique=True, index=True)
    created_by: uuid.UUID = Field(foreign_key="users.id")
    expires_at: datetime | None = Field(default=None, sa_type=DateTime(timezone=True))
    revoked_at: datetime | None = Field(default=None, sa_type=DateTime(timezone=True))
    created_at: datetime = Field(default_factory=utcnow, sa_type=DateTime(timezone=True))
