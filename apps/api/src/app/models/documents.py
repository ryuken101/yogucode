"""A student's saved work.

Phase 2's requirement is product-spec §3.1: "work persists across sessions — no lost files
between weeks." So a student has *files*, several of them, titled and switchable — not one
scratch buffer that last week's turtle drawing falls out of. A teacher saying "open your
spiral one" is the case this table exists to make possible.

**This is the first table a student can write to.** Everything up to now was teacher-owned,
which means the tenancy filter was always about the centre alone. Here it is about the
centre *and* the subject: a document is reachable only by the child who owns it. The
scoping helper carries both halves, and the routes live under `/me/...` so that no route
even has a student id available to point at the wrong child.

**Problems are not referenced here.** They arrive in Phase 4 with their own tables, and a
nullable `problem_id` with no foreign key behind it — two phases of an unconstrained
reference — is how orphaned rows appear. Phase 4 links work to problems when there is
something real to link to.
"""

import uuid
from enum import StrEnum

from sqlalchemy import CheckConstraint, Index, String, Text, text
from sqlmodel import Field

from app.models.base import TimestampMixin, new_uuid


class DocumentStatus(StrEnum):
    ACTIVE = "active"
    ARCHIVED = "archived"


class StudentDocument(TimestampMixin, table=True):
    """One file belonging to one student."""

    __tablename__ = "student_documents"
    __table_args__ = (
        CheckConstraint("status IN ('active', 'archived')", name="status"),
        # Two *live* files with the same name is confusing for a child and useless to a
        # teacher naming one out loud. Two archived ones are just history, so the
        # constraint is partial — the same pattern as concepts' uq_concepts_global_key,
        # and for the same reason: the rule only applies to the rows in play.
        #
        # `lower(title)` because "Spiral" and "spiral" are the same file to a ten-year-old.
        # Autogenerate did render this functional partial index correctly, which is not
        # guaranteed for expression indexes — read the generated revision rather than
        # assuming, and `test_schema.py` asserts the constraint actually bites.
        Index(
            "uq_student_documents_live_title",
            "student_id",
            text("lower(title)"),
            unique=True,
            postgresql_where=text("status = 'active'"),
        ),
    )

    id: uuid.UUID = Field(default_factory=new_uuid, primary_key=True)
    centre_id: uuid.UUID = Field(foreign_key="centres.id", index=True)
    student_id: uuid.UUID = Field(foreign_key="students.id", index=True)
    title: str
    # Text rather than the default AutoString: this holds a Python file, not a label, and
    # the column should read as unbounded to anyone who opens the schema. The practical
    # cap lives on the DTO, as it does for display_name and classes.name.
    content: str = Field(default="", sa_type=Text)
    status: DocumentStatus = Field(default=DocumentStatus.ACTIVE, sa_type=String)
