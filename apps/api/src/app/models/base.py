"""Shared model conventions.

Two rules apply to every table in this schema:

1. **UUIDv7 primary keys, generated in Python.** Time-sortable, so they carry creation
   order, and client-generatable, which Phase 6's offline event buffer needs — a
   disconnected laptop must be able to mint non-colliding event ids. Generation stays
   application-side for that reason; it is not a database default. (Postgres 16 has no
   native uuidv7(); that arrived in 18.)
2. **Timestamps are set in Python, not by the database.** `func.now()` is transaction
   start time in Postgres, so a row inserted and updated in one transaction would show
   an unchanged `updated_at`. `server_default` is kept only as a fallback for rows
   inserted outside the application.

Status columns are text with a CHECK constraint rather than a Postgres ENUM: these
vocabularies will grow, and `ALTER TYPE ... ADD VALUE` is awkward inside a migration.
"""

import uuid
from datetime import UTC, datetime

from sqlalchemy import DateTime, func
from sqlmodel import Field, SQLModel
from uuid_utils.compat import uuid7

# Deterministic constraint and index names, so Alembic autogenerate produces stable
# migrations and a downgrade can drop what an upgrade created by name. Must be set
# before any table class is defined — every model module imports this one first.
SQLModel.metadata.naming_convention = {
    "ix": "ix_%(table_name)s_%(column_0_N_name)s",
    "uq": "uq_%(table_name)s_%(column_0_N_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_N_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


def new_uuid() -> uuid.UUID:
    """A UUIDv7 as a stdlib uuid.UUID, ready for a native Postgres uuid column."""
    return uuid7()


def utcnow() -> datetime:
    return datetime.now(UTC)


class TimestampMixin(SQLModel):
    created_at: datetime = Field(
        default_factory=utcnow,
        sa_type=DateTime(timezone=True),
        nullable=False,
        sa_column_kwargs={"server_default": func.now()},
    )
    updated_at: datetime = Field(
        default_factory=utcnow,
        sa_type=DateTime(timezone=True),
        nullable=False,
        sa_column_kwargs={"server_default": func.now(), "onupdate": utcnow},
    )
