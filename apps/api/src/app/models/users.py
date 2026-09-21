"""Teachers and centre owners.

Students deliberately live in their own table (app.models.students), not here: no email,
no Supabase identity, a different PII posture and a different lifecycle. Merging the two
would force nullable email and supabase_user_id on every row and muddy every
authorisation check.
"""

import uuid
from enum import StrEnum

from sqlalchemy import CheckConstraint, String
from sqlmodel import Field

from app.models.base import TimestampMixin, new_uuid


class UserRole(StrEnum):
    OWNER = "owner"
    TEACHER = "teacher"


class UserStatus(StrEnum):
    ACTIVE = "active"
    DISABLED = "disabled"


class User(TimestampMixin, table=True):
    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint("role IN ('owner', 'teacher')", name="role"),
        CheckConstraint("status IN ('active', 'disabled')", name="status"),
    )

    id: uuid.UUID = Field(default_factory=new_uuid, primary_key=True)
    supabase_user_id: uuid.UUID = Field(unique=True, index=True)
    centre_id: uuid.UUID = Field(foreign_key="centres.id", index=True)
    email: str = Field(index=True)
    display_name: str
    # sa_type=String keeps these as text + CHECK rather than a Postgres ENUM; see
    # app.models.base for why.
    role: UserRole = Field(default=UserRole.TEACHER, sa_type=String)
    status: UserStatus = Field(default=UserStatus.ACTIVE, sa_type=String)
