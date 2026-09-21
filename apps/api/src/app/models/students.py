"""Students, their PIN credentials, and their sessions.

PII minimisation (product-spec §10): a student has a display name and nothing else. No
email, no date of birth, no surname where a first name plus last initial will do. Data
never collected is data that never has to be protected, disclosed, or deleted.

A student belongs to a *centre*, not to a class, and is enrolled in classes term by
term. That is what lets mastery follow a child across terms in Phase 8; the alternative
resets a child's history every term.
"""

import uuid
from datetime import datetime
from enum import StrEnum

from sqlalchemy import CheckConstraint, DateTime, String
from sqlmodel import Field, SQLModel

from app.models.base import TimestampMixin, new_uuid, utcnow


class StudentStatus(StrEnum):
    ACTIVE = "active"
    ARCHIVED = "archived"


class Student(TimestampMixin, table=True):
    __tablename__ = "students"
    __table_args__ = (CheckConstraint("status IN ('active', 'archived')", name="status"),)

    id: uuid.UUID = Field(default_factory=new_uuid, primary_key=True)
    centre_id: uuid.UUID = Field(foreign_key="centres.id", index=True)
    display_name: str
    status: StudentStatus = Field(default=StudentStatus.ACTIVE, sa_type=String)


class StudentCredential(TimestampMixin, table=True):
    """A student's PIN, as an Argon2id hash. Never plaintext, anywhere, ever.

    The teacher sets the PIN when building the roster and hands out slips — students do
    not claim a name on first login, which would let one child claim another's name
    before they ever signed in.

    `must_change_pin` drives the reset flow: a teacher resetting a PIN invalidates the
    old one and the student is prompted to choose a new one at next sign-in. Resets will
    be frequent — a Year 4 student forgets a PIN roughly weekly — so this is a primary
    flow, not an edge case.
    """

    __tablename__ = "student_credentials"

    student_id: uuid.UUID = Field(foreign_key="students.id", primary_key=True)
    pin_hash: str
    pin_set_at: datetime = Field(default_factory=utcnow, sa_type=DateTime(timezone=True))
    pin_set_by: uuid.UUID | None = Field(default=None, foreign_key="users.id")
    must_change_pin: bool = Field(default=False)
    failed_attempts: int = Field(default=0)
    locked_until: datetime | None = Field(default=None, sa_type=DateTime(timezone=True))


class StudentSession(SQLModel, table=True):
    """An app-issued opaque session.

    Only the SHA-256 hash of the token is stored; the token itself lives in an httpOnly
    Secure SameSite=Lax cookie and nowhere else. Opaque rather than a JWT specifically
    because it must be **revocable** — a teacher kicking a session (wrong child logged
    in, laptop left signed in) has to take effect on the next request, not at expiry.

    Two clocks bound a session: `expires_at` is the absolute bound (12h, so a session
    does not outlive the day on a shared centre laptop) and `last_seen_at` plus
    STUDENT_SESSION_IDLE_MINUTES is the idle bound (90min, so an abandoned laptop logs
    itself out). It still survives a browser restart mid-lesson.
    """

    __tablename__ = "student_sessions"

    id: uuid.UUID = Field(default_factory=new_uuid, primary_key=True)
    student_id: uuid.UUID = Field(foreign_key="students.id", index=True)
    token_hash: str = Field(unique=True, index=True)
    issued_at: datetime = Field(default_factory=utcnow, sa_type=DateTime(timezone=True))
    expires_at: datetime = Field(sa_type=DateTime(timezone=True))
    last_seen_at: datetime = Field(default_factory=utcnow, sa_type=DateTime(timezone=True))
    revoked_at: datetime | None = Field(default=None, sa_type=DateTime(timezone=True))
    user_agent: str | None = Field(default=None)
