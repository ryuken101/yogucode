"""A teacher's own files — "My code" (Ken's decision, 10 Oct 2026).

A teacher writes and runs Python here to demonstrate to the class on the projector. The
files are **private to that teacher**: other teachers at the centre cannot see them, so the
scoping filter is the centre *and* the user, exactly as a student's files are scoped to
the centre and the child.

A separate table from `student_documents` rather than a second, nullable owner column on
it: a child's work and a teacher's scratch files have different owners, different privacy
and different lifecycles — the same reasoning that keeps `students` apart from `users` —
and every query on children's files stays exactly as it was.
"""

import uuid

from sqlalchemy import CheckConstraint, Index, String, Text, text
from sqlmodel import Field

from app.models.base import TimestampMixin, new_uuid
from app.models.documents import DocumentStatus


class TeacherDocument(TimestampMixin, table=True):
    """One file belonging to one teacher."""

    __tablename__ = "teacher_documents"
    __table_args__ = (
        CheckConstraint("status IN ('active', 'archived')", name="status"),
        # The same rule as a child's files: two live files cannot share a name, ignoring
        # case. Archived ones are history and do not count.
        Index(
            "uq_teacher_documents_live_title",
            "user_id",
            text("lower(title)"),
            unique=True,
            postgresql_where=text("status = 'active'"),
        ),
    )

    id: uuid.UUID = Field(default_factory=new_uuid, primary_key=True)
    centre_id: uuid.UUID = Field(foreign_key="centres.id", index=True)
    user_id: uuid.UUID = Field(foreign_key="users.id", index=True)
    title: str
    content: str = Field(default="", sa_type=Text)
    status: DocumentStatus = Field(default=DocumentStatus.ACTIVE, sa_type=String)
