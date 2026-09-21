"""Append-only audit of actions taken on children's records.

PIN resets, roster changes and archival are actions a teacher takes on a child's record
under the Australian Privacy Act. Recording them is cheap now and impossible to
reconstruct later. Rows are never updated or deleted, hence no updated_at.
"""

import uuid
from datetime import datetime
from enum import StrEnum
from typing import Any

from sqlalchemy import CheckConstraint, DateTime, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlmodel import Field, SQLModel

from app.models.base import new_uuid, utcnow


class ActorType(StrEnum):
    USER = "user"
    STUDENT = "student"
    SYSTEM = "system"


class AuditLog(SQLModel, table=True):
    __tablename__ = "audit_log"
    __table_args__ = (
        CheckConstraint("actor_type IN ('user', 'student', 'system')", name="actor_type"),
    )

    id: uuid.UUID = Field(default_factory=new_uuid, primary_key=True)
    centre_id: uuid.UUID = Field(foreign_key="centres.id", index=True)
    actor_type: ActorType = Field(sa_type=String)
    actor_id: uuid.UUID | None = Field(default=None)
    action: str = Field(index=True)
    target_type: str
    target_id: uuid.UUID | None = Field(default=None)
    payload: dict[str, Any] = Field(default_factory=dict, sa_type=JSONB)
    created_at: datetime = Field(
        default_factory=utcnow, sa_type=DateTime(timezone=True), index=True
    )
