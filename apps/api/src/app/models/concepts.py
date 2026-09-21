"""The concept taxonomy.

Content is deferred — next term's scope and sequence is not confirmed — but the
mechanism is not. Swapping the taxonomy must be a config edit (seed/concepts.yaml, step
8) rather than a migration. That is product-spec §10's test: can the product be
configured for a different course without changing code?

`centre_id IS NULL` means a global concept shared by every centre; a non-null centre_id
is a centre's own override or addition.
"""

import uuid
from enum import StrEnum

from sqlalchemy import CheckConstraint, Index, String, UniqueConstraint, text
from sqlmodel import Field

from app.models.base import TimestampMixin, new_uuid


class ConceptStatus(StrEnum):
    ACTIVE = "active"
    PROVISIONAL = "provisional"
    ARCHIVED = "archived"


class Concept(TimestampMixin, table=True):
    __tablename__ = "concepts"
    __table_args__ = (
        UniqueConstraint("centre_id", "key", name="uq_concepts_centre_key"),
        # Postgres treats NULLs as distinct in a unique constraint, so the constraint
        # above does not stop two global concepts sharing a key. This partial index does.
        Index(
            "uq_concepts_global_key",
            "key",
            unique=True,
            postgresql_where=text("centre_id IS NULL"),
        ),
        CheckConstraint("status IN ('active', 'provisional', 'archived')", name="status"),
    )

    id: uuid.UUID = Field(default_factory=new_uuid, primary_key=True)
    centre_id: uuid.UUID | None = Field(default=None, foreign_key="centres.id", index=True)
    key: str
    label: str
    sort_order: int = Field(default=0)
    parent_id: uuid.UUID | None = Field(default=None, foreign_key="concepts.id")
    status: ConceptStatus = Field(default=ConceptStatus.PROVISIONAL, sa_type=String)
