"""Folders for the problem bank (Ken, 7 Nov 2026): teachers' own groups, such as "Term 4
quizzes", alongside the concept groups the bank sorts itself into.

Shared by every teacher at the centre, as the bank is. They work like labels: a problem can
be in several, nothing is copied, and deleting a folder leaves its problems alone. A
separate thing from `teacher_folders`, which hold one teacher's private files, each in one
place.

A new version of a problem is a new `items` row, so membership follows the version family
(`routers/problem_folders.py`); otherwise editing a problem would drop it from its folders.
"""

import uuid

from sqlalchemy import CheckConstraint, Index, String, text
from sqlmodel import Field, SQLModel

from app.models.base import TimestampMixin, TrashMixin, new_uuid
from app.models.documents import DocumentStatus


class ProblemFolder(TimestampMixin, TrashMixin, table=True):
    __tablename__ = "problem_folders"
    __table_args__ = (
        CheckConstraint("status IN ('active', 'archived')", name="status"),
        Index(
            "uq_problem_folders_live_name",
            "centre_id",
            text("lower(name)"),
            unique=True,
            postgresql_where=text("status = 'active'"),
        ),
    )

    id: uuid.UUID = Field(default_factory=new_uuid, primary_key=True)
    centre_id: uuid.UUID = Field(foreign_key="centres.id", index=True)
    name: str
    status: DocumentStatus = Field(default=DocumentStatus.ACTIVE, sa_type=String)
    created_by: uuid.UUID | None = Field(default=None, foreign_key="users.id")


class ProblemFolderItem(SQLModel, table=True):
    __tablename__ = "problem_folder_items"

    folder_id: uuid.UUID = Field(foreign_key="problem_folders.id", primary_key=True)
    item_id: uuid.UUID = Field(foreign_key="items.id", primary_key=True, index=True)
    centre_id: uuid.UUID = Field(foreign_key="centres.id", index=True)
