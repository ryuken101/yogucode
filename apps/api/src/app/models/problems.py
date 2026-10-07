"""The problem bank: items, their concept tags, test cases and hints.

An **item** is one thing a student can attempt. Spec §2's invariant — "everything is an
attempt at a tagged problem" — means classwork, homework and (from Phase 7) quizzes all
draw on this one table; what differs between them lives on the assignment, not here.

**Difficulty and concepts are separate fields** (spec §3.3). `difficulty` is the author's
1–3 dot estimate; `item_concepts` says what the item exercises, with one tag marked
primary so mastery (Phase 8) knows what the item mainly tests.

**Parts (a/b/c) are child items** (`parent_id`). Spec §3.3's compound-problem fix is that
each part is independently attemptable, with its own tags, tests and marks — which is
exactly an item. The parent carries the shared prompt and has no tests of its own; an
attempt is only ever against a leaf.

**A published item is never edited in place.** Editing makes a new draft row with
`supersedes_id` pointing back and `version + 1`; publishing it marks the old row
`superseded`. Attempts and marks point at the version the child actually saw, so a fix to
a test case cannot silently change what last fortnight's marks meant. Drafts are freely
editable — nothing can have been attempted against a draft.

**Test-case `spec` is JSONB, validated per `kind` by the API.** `io` holds
`{stdin, expected, match}`; `function` holds `{call, expected}`. A future turtle kind is
a new `kind` value and a new Pydantic shape, not a migration.

`source_key` is the YAML import's identity for a problem (step 5): re-importing a file
updates the problem it created rather than adding a second copy. Every version of a
problem carries the same key; see the indexes for what is unique.
"""

import uuid
from enum import StrEnum
from typing import Any

from sqlalchemy import CheckConstraint, Index, String, Text, UniqueConstraint, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlmodel import Field, SQLModel

from app.models.base import TimestampMixin, new_uuid


class ItemKind(StrEnum):
    CODE = "code"
    # Multiple choice (Phase 7 quizzes, also usable in homework). Each wrong option names
    # the misconception it reveals — spec §3.6's "six students think range is inclusive".
    MCQ = "mcq"


class ItemStatus(StrEnum):
    DRAFT = "draft"
    PUBLISHED = "published"
    SUPERSEDED = "superseded"
    ARCHIVED = "archived"


class TestKind(StrEnum):
    IO = "io"
    FUNCTION = "function"


class Item(TimestampMixin, table=True):
    __tablename__ = "items"
    __table_args__ = (
        CheckConstraint("kind IN ('code', 'mcq')", name="kind"),
        CheckConstraint(
            "status IN ('draft', 'published', 'superseded', 'archived')", name="status"
        ),
        CheckConstraint("difficulty BETWEEN 1 AND 3", name="difficulty"),
        # A part has a label and a parent; a top-level item has neither.
        CheckConstraint("(parent_id IS NULL) = (part_label IS NULL)", name="part_label"),
        # One published and one draft per key, at most: a published problem and the draft
        # of its next version share a key while the edit is in progress. Superseded and
        # archived versions keep the key as history and are outside both indexes.
        Index(
            "uq_items_published_source_key",
            "centre_id",
            "source_key",
            unique=True,
            postgresql_where=text("parent_id IS NULL AND status = 'published'"),
        ),
        Index(
            "uq_items_draft_source_key",
            "centre_id",
            "source_key",
            unique=True,
            postgresql_where=text("parent_id IS NULL AND status = 'draft'"),
        ),
    )

    id: uuid.UUID = Field(default_factory=new_uuid, primary_key=True)
    centre_id: uuid.UUID = Field(foreign_key="centres.id", index=True)
    kind: ItemKind = Field(default=ItemKind.CODE, sa_type=String)
    parent_id: uuid.UUID | None = Field(default=None, foreign_key="items.id", index=True)
    part_label: str | None = Field(default=None)
    sort_order: int = Field(default=0)
    title: str
    # Text rather than AutoString: these are documents and programs, not labels. Caps live
    # on the DTOs, as for student_documents.content.
    prompt_md: str = Field(default="", sa_type=Text)
    difficulty: int = Field(default=1)
    starter_code: str = Field(default="", sa_type=Text)
    solution_code: str = Field(default="", sa_type=Text)
    # Multiple choice only: [{"text", "correct", "misconception"}], in display order.
    options: list[dict[str, Any]] = Field(
        default_factory=list,
        sa_type=JSONB,
        # Existing rows (every code problem) get an empty list rather than NULL.
        sa_column_kwargs={"server_default": text("'[]'::jsonb")},
    )
    status: ItemStatus = Field(default=ItemStatus.DRAFT, sa_type=String)
    version: int = Field(default=1)
    supersedes_id: uuid.UUID | None = Field(default=None, foreign_key="items.id")
    source_key: str | None = Field(default=None)
    created_by: uuid.UUID | None = Field(default=None, foreign_key="users.id")


class ItemConcept(SQLModel, table=True):
    __tablename__ = "item_concepts"
    __table_args__ = (
        # At most one primary tag per item. "Exactly one" is a publish-time rule, since a
        # half-written draft may have none yet.
        Index(
            "uq_item_concepts_primary",
            "item_id",
            unique=True,
            postgresql_where=text("is_primary"),
        ),
    )

    item_id: uuid.UUID = Field(foreign_key="items.id", primary_key=True)
    concept_id: uuid.UUID = Field(foreign_key="concepts.id", primary_key=True, index=True)
    is_primary: bool = Field(default=False)


class TestCase(SQLModel, table=True):
    __tablename__ = "test_cases"
    __table_args__ = (CheckConstraint("kind IN ('io', 'function')", name="kind"),)
    # pytest collects classes named Test*; this is a model, not a test.
    __test__ = False

    id: uuid.UUID = Field(default_factory=new_uuid, primary_key=True)
    centre_id: uuid.UUID = Field(foreign_key="centres.id", index=True)
    item_id: uuid.UUID = Field(foreign_key="items.id", index=True)
    name: str
    kind: TestKind = Field(sa_type=String)
    spec: dict[str, Any] = Field(default_factory=dict, sa_type=JSONB)
    hidden: bool = Field(default=False)
    sort_order: int = Field(default=0)


class Hint(SQLModel, table=True):
    """One rung of an item's hint ladder: nudge (1), stronger hint (2), worked example (3).

    A rung unlocks when *either* threshold is met — enough runs, or enough time on the
    item — which is spec §3.4's gate against bottoming out the ladder without thinking.
    """

    __tablename__ = "hints"
    __table_args__ = (
        CheckConstraint("level BETWEEN 1 AND 3", name="level"),
        UniqueConstraint("item_id", "level", name="uq_hints_item_level"),
    )

    id: uuid.UUID = Field(default_factory=new_uuid, primary_key=True)
    centre_id: uuid.UUID = Field(foreign_key="centres.id", index=True)
    item_id: uuid.UUID = Field(foreign_key="items.id", index=True)
    level: int
    body_md: str = Field(sa_type=Text)
    unlock_after_runs: int = Field(default=1)
    unlock_after_seconds: int = Field(default=120)
