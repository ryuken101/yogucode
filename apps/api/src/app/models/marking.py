"""Hand-ins, marks, overall notes, and the comment bank — homework, end to end.

**A submission is a frozen copy of an attempt** at the moment it was handed in. The
attempt keeps changing (a child can carry on and hand in again until the work is
released); the submission does not. Append-only, and the newest row is the one that
counts. `source = 'saved_work'` marks a copy the *teacher* took when marking a child who
never pressed Hand in (Ken's decision: "not handed in" is still markable).

**A mark is one teacher's judgement of one attempt**, against a fixed rubric (spec §3.5):
`runs` yes/no, `correct` 0–2, `approach` 0–2. Runs and Correct arrive pre-filled from the
teacher's browser re-running the checks (`verified_*`); approach is the one human call.
Same dimensions every time, so a child's trend measures the child, not the marker's mood.
One mark per attempt, updated in place; changes are audited, because a mark is a teacher's
action on a child's record.

**Nothing is visible to a child until it is released.** `released_at` on marks and notes,
stamped together by the assignment's Release. A child then sees comments and sage/amber
per question — never the numbers (spec §3.7: three views of one model).

**Snippets are the centre's shared comment bank** (spec §3.5): canned feedback for the
misconceptions that come up every week, optionally tagged with a concept so the relevant
ones surface first. `use_count` is how the bank learns which ones earn their place.
"""

import uuid
from datetime import datetime
from enum import StrEnum

from sqlalchemy import CheckConstraint, DateTime, Index, String, Text
from sqlmodel import Field, SQLModel

from app.models.base import TimestampMixin, new_uuid, utcnow


class SubmissionSource(StrEnum):
    HAND_IN = "hand_in"
    SAVED_WORK = "saved_work"


class SnippetStatus(StrEnum):
    ACTIVE = "active"
    ARCHIVED = "archived"


class Submission(SQLModel, table=True):
    __tablename__ = "submissions"
    __table_args__ = (
        CheckConstraint("source IN ('hand_in', 'saved_work')", name="source"),
        Index("ix_submissions_attempt_submitted", "attempt_id", "submitted_at"),
    )

    id: uuid.UUID = Field(default_factory=new_uuid, primary_key=True)
    centre_id: uuid.UUID = Field(foreign_key="centres.id", index=True)
    attempt_id: uuid.UUID = Field(foreign_key="attempts.id")
    code: str = Field(sa_type=Text)
    # Multiple choice: the option picked at hand-in.
    choice: int | None = None
    # The child's browser's check result at hand-in. Informational; marking re-runs.
    passed: int | None = None
    total: int | None = None
    late: bool = False
    source: SubmissionSource = Field(default=SubmissionSource.HAND_IN, sa_type=String)
    submitted_at: datetime = Field(default_factory=utcnow, sa_type=DateTime(timezone=True))


class Mark(TimestampMixin, table=True):
    __tablename__ = "marks"
    __table_args__ = (
        CheckConstraint("correct BETWEEN 0 AND 2", name="correct"),
        CheckConstraint("approach IS NULL OR approach BETWEEN 0 AND 2", name="approach"),
    )

    id: uuid.UUID = Field(default_factory=new_uuid, primary_key=True)
    centre_id: uuid.UUID = Field(foreign_key="centres.id", index=True)
    attempt_id: uuid.UUID = Field(foreign_key="attempts.id", unique=True)
    submission_id: uuid.UUID = Field(foreign_key="submissions.id")
    marker_id: uuid.UUID = Field(foreign_key="users.id")
    runs: bool
    correct: int
    # Nullable: a teacher may save Runs/Correct and a comment, and come back for approach.
    approach: int | None = None
    verified_passed: int | None = None
    verified_total: int | None = None
    comment_md: str = Field(default="", sa_type=Text)
    released_at: datetime | None = Field(default=None, sa_type=DateTime(timezone=True))


class AssignmentNote(TimestampMixin, table=True):
    """The optional overall note to one child on one homework."""

    __tablename__ = "assignment_notes"

    assignment_id: uuid.UUID = Field(foreign_key="assignments.id", primary_key=True)
    student_id: uuid.UUID = Field(foreign_key="students.id", primary_key=True)
    centre_id: uuid.UUID = Field(foreign_key="centres.id", index=True)
    marker_id: uuid.UUID = Field(foreign_key="users.id")
    note: str = Field(default="", sa_type=Text)
    released_at: datetime | None = Field(default=None, sa_type=DateTime(timezone=True))


class FeedbackSnippet(TimestampMixin, table=True):
    __tablename__ = "feedback_snippets"
    __table_args__ = (CheckConstraint("status IN ('active', 'archived')", name="status"),)

    id: uuid.UUID = Field(default_factory=new_uuid, primary_key=True)
    centre_id: uuid.UUID = Field(foreign_key="centres.id", index=True)
    body: str = Field(sa_type=Text)
    concept_id: uuid.UUID | None = Field(default=None, foreign_key="concepts.id")
    use_count: int = 0
    status: SnippetStatus = Field(default=SnippetStatus.ACTIVE, sa_type=String)
    created_by: uuid.UUID | None = Field(default=None, foreign_key="users.id")
