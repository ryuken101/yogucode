"""Folders for My files (children) and My code (teachers) — Ken's decision, 11 Oct 2026.

A VS Code-style explorer: folders inside folders, files in any of them, everything movable.
Two tables for the same reason files are two tables (`student_documents`,
`teacher_documents`): different owners, different privacy, and no query on children's work
should ever have to filter teachers out of it.

`parent_id` null means the top level. Names follow the files' rule — no two live folders
with the same name (ignoring case) in the same place — and archived folders are history,
so the rule is a partial index. Postgres treats NULLs as distinct in a unique index, so
the top level is folded to the nil UUID with `coalesce` to make the rule bite there too.

Deleting a folder archives it, everything inside it and every file in them: children's
work is never destroyed by tidying up (archive, never delete).
"""

import uuid

from sqlalchemy import CheckConstraint, Index, String, text
from sqlmodel import Field

from app.models.base import TimestampMixin, new_uuid
from app.models.documents import DocumentStatus

# The top level, for the per-folder unique-name indexes. Never a real folder id.
TOP_LEVEL = "00000000-0000-0000-0000-000000000000"


class StudentFolder(TimestampMixin, table=True):
    __tablename__ = "student_folders"
    __table_args__ = (
        CheckConstraint("status IN ('active', 'archived')", name="status"),
        Index(
            "uq_student_folders_live_name",
            "student_id",
            text(f"coalesce(parent_id, '{TOP_LEVEL}'::uuid)"),
            text("lower(name)"),
            unique=True,
            postgresql_where=text("status = 'active'"),
        ),
    )

    id: uuid.UUID = Field(default_factory=new_uuid, primary_key=True)
    centre_id: uuid.UUID = Field(foreign_key="centres.id", index=True)
    student_id: uuid.UUID = Field(foreign_key="students.id", index=True)
    parent_id: uuid.UUID | None = Field(default=None, foreign_key="student_folders.id")
    name: str
    status: DocumentStatus = Field(default=DocumentStatus.ACTIVE, sa_type=String)


class TeacherFolder(TimestampMixin, table=True):
    __tablename__ = "teacher_folders"
    __table_args__ = (
        CheckConstraint("status IN ('active', 'archived')", name="status"),
        Index(
            "uq_teacher_folders_live_name",
            "user_id",
            text(f"coalesce(parent_id, '{TOP_LEVEL}'::uuid)"),
            text("lower(name)"),
            unique=True,
            postgresql_where=text("status = 'active'"),
        ),
    )

    id: uuid.UUID = Field(default_factory=new_uuid, primary_key=True)
    centre_id: uuid.UUID = Field(foreign_key="centres.id", index=True)
    user_id: uuid.UUID = Field(foreign_key="users.id", index=True)
    parent_id: uuid.UUID | None = Field(default=None, foreign_key="teacher_folders.id")
    name: str
    status: DocumentStatus = Field(default=DocumentStatus.ACTIVE, sa_type=String)
