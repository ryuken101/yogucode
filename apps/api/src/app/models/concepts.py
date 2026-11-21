"""The concept taxonomy.

Content is deferred — next term's scope and sequence is not confirmed — but the
mechanism is not. Swapping the taxonomy must be a config edit (seed/concepts.yaml, step
8) rather than a migration. That is product-spec §10's test: can the product be
configured for a different course without changing code?

`centre_id IS NULL` means a global concept shared by every centre; a non-null centre_id
is a centre's own override or addition. Teachers add, rename and remove the centre's own
from the problem editor's tag picker (Ken, 14 Nov 2026; `routers/curriculum.py`). Those get
a key no global concept has, so they sit beside the taxonomy rather than override it.

**The centre's tree** (Ken, 21 Nov 2026): teachers shape it — sub-skills under any tag, as
deep as they like, and any tag deleted with its branch (to the Trash, hence `TrashMixin`).
The first edit copies the global taxonomy into the centre (`app.concepts.own_taxonomy`), so
the global rows are never changed by a teacher: they stay the template the YAML edits.
"""

import uuid
from enum import StrEnum

from sqlalchemy import CheckConstraint, Index, String, UniqueConstraint, text
from sqlmodel import Field

from app.models.base import TimestampMixin, TrashMixin, new_uuid


class ConceptStatus(StrEnum):
    ACTIVE = "active"
    PROVISIONAL = "provisional"
    ARCHIVED = "archived"


class Concept(TimestampMixin, TrashMixin, table=True):
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
