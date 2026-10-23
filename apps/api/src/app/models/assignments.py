"""Sets, assignments and attempts — how problems reach a child, and what the child did.

A **set** is an ordered list of problems: a lesson's ladder, and from Phase 5 a homework
sheet or (Phase 7) a quiz. A lesson has at most one ladder set (`lesson_id`); other sets
stand alone.

An **assignment** is a set given to a class, with a `mode`: classwork, homework or quiz.
Everything that differs between those three lives here — when it opens, whether it has a
due date, whether completions and hints are on — so the editor and the attempt are the
same code in every mode. `quiz` is in the CHECK from day one so Phase 7 adds behaviour,
not a migration.

Classwork assignments are made for the teacher rather than by them: choosing today's
lesson for a class opens that lesson's ladder as classwork (`app.classwork`). A teacher
thinks "we're on lesson 6", not "assign set 41 to class 3".

An **attempt** is one child's work on one leaf problem (a problem without parts, or one
part) within one assignment. It holds the code — autosaved like a file — and the few
counters the server needs to decide things without trusting the browser: how many runs
(hint gating), the last result (the teacher's progress view) and how far up the hint
ladder they are. The process trace (every edit, every run) is Phase 5's events table.

Attempts point at the exact item version the child saw. A set keeps pointing at an old
version until a teacher updates it, so a problem cannot change under a child mid-lesson.
"""

import uuid
from datetime import datetime
from enum import StrEnum
from typing import Any

from sqlalchemy import CheckConstraint, DateTime, Index, String, Text, UniqueConstraint, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlmodel import Field, SQLModel

from app.models.base import TimestampMixin, TrashMixin, new_uuid, utcnow


class SetStatus(StrEnum):
    ACTIVE = "active"
    ARCHIVED = "archived"


class AssignmentMode(StrEnum):
    CLASSWORK = "classwork"
    HOMEWORK = "homework"
    QUIZ = "quiz"


class AssignmentStatus(StrEnum):
    DRAFT = "draft"
    OPEN = "open"
    CLOSED = "closed"
    ARCHIVED = "archived"


class AttemptStatus(StrEnum):
    IN_PROGRESS = "in_progress"
    SUBMITTED = "submitted"


class ProblemSet(TimestampMixin, table=True):
    __tablename__ = "sets"
    __table_args__ = (
        CheckConstraint("status IN ('active', 'archived')", name="status"),
        # One live ladder per lesson. Archived ladders are history.
        Index(
            "uq_sets_live_lesson",
            "lesson_id",
            unique=True,
            postgresql_where=text("lesson_id IS NOT NULL AND status = 'active'"),
        ),
    )

    id: uuid.UUID = Field(default_factory=new_uuid, primary_key=True)
    centre_id: uuid.UUID = Field(foreign_key="centres.id", index=True)
    title: str
    lesson_id: uuid.UUID | None = Field(default=None, foreign_key="lessons.id")
    status: SetStatus = Field(default=SetStatus.ACTIVE, sa_type=String)
    created_by: uuid.UUID | None = Field(default=None, foreign_key="users.id")


class SetItem(SQLModel, table=True):
    """A problem's place in a set. Replaced as a list when the set is edited."""

    __tablename__ = "set_items"

    set_id: uuid.UUID = Field(foreign_key="sets.id", primary_key=True)
    item_id: uuid.UUID = Field(foreign_key="items.id", primary_key=True, index=True)
    sort_order: int = Field(default=0)


class Assignment(TimestampMixin, TrashMixin, table=True):
    __tablename__ = "assignments"
    __table_args__ = (
        CheckConstraint("mode IN ('classwork', 'homework', 'quiz')", name="mode"),
        CheckConstraint("status IN ('draft', 'open', 'closed', 'archived')", name="status"),
        # A lesson's ladder is opened for a class once; choosing the lesson again reuses it,
        # so a child's attempts from last week are still there.
        Index(
            "uq_assignments_classwork_set",
            "class_id",
            "set_id",
            unique=True,
            postgresql_where=text("mode = 'classwork'"),
        ),
    )

    id: uuid.UUID = Field(default_factory=new_uuid, primary_key=True)
    centre_id: uuid.UUID = Field(foreign_key="centres.id", index=True)
    class_id: uuid.UUID = Field(foreign_key="classes.id", index=True)
    set_id: uuid.UUID = Field(foreign_key="sets.id", index=True)
    title: str
    mode: AssignmentMode = Field(sa_type=String)
    status: AssignmentStatus = Field(default=AssignmentStatus.OPEN, sa_type=String)
    opens_at: datetime = Field(default_factory=utcnow, sa_type=DateTime(timezone=True))
    due_at: datetime | None = Field(default=None, sa_type=DateTime(timezone=True))
    # {"completions": bool, "hints": bool}. JSONB because Phase 7 adds quiz settings
    # (time limit, paste flagging) that classwork and homework never read.
    settings: dict[str, Any] = Field(default_factory=dict, sa_type=JSONB)
    released_at: datetime | None = Field(default=None, sa_type=DateTime(timezone=True))
    # A quiz's one clock for the class (Ken's decision): set when the teacher presses
    # Start; `ends_at` is when everyone's work is handed in, or earlier on Stop.
    started_at: datetime | None = Field(default=None, sa_type=DateTime(timezone=True))
    ends_at: datetime | None = Field(default=None, sa_type=DateTime(timezone=True))
    created_by: uuid.UUID | None = Field(default=None, foreign_key="users.id")


class Attempt(TimestampMixin, table=True):
    __tablename__ = "attempts"
    __table_args__ = (
        CheckConstraint("status IN ('in_progress', 'submitted')", name="status"),
        UniqueConstraint(
            "assignment_id", "item_id", "student_id", name="uq_attempts_assignment_item_student"
        ),
    )

    id: uuid.UUID = Field(default_factory=new_uuid, primary_key=True)
    centre_id: uuid.UUID = Field(foreign_key="centres.id", index=True)
    student_id: uuid.UUID = Field(foreign_key="students.id", index=True)
    assignment_id: uuid.UUID = Field(foreign_key="assignments.id", index=True)
    item_id: uuid.UUID = Field(foreign_key="items.id", index=True)
    code: str = Field(default="", sa_type=Text)
    # Multiple choice: the index of the option picked, or None while unanswered.
    choice: int | None = Field(default=None)
    status: AttemptStatus = Field(default=AttemptStatus.IN_PROGRESS, sa_type=String)
    run_count: int = Field(default=0)
    last_passed: int | None = Field(default=None)
    last_total: int | None = Field(default=None)
    # The highest hint rung unlocked; 0 for none. Rungs unlock in order.
    hints_unlocked: int = Field(default=0)
    # A file in the child's own Files that this work is also saved to (Ken's decision, 17
    # Oct 2026): the first Save asks where, and every save after keeps it up to date. The
    # attempt stays the record that is checked and marked; the file is the child's copy.
    document_id: uuid.UUID | None = Field(default=None, foreign_key="student_documents.id")
