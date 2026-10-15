"""Students, their PIN credentials, and their sessions.

PII minimisation (product-spec §10): a student has a display name, a username to sign in
with, and nothing else. No email, no date of birth, no surname where a first name plus last
initial will do. Data never collected is data that never has to be protected, disclosed,
or deleted.

**Permanent accounts** (Ken's decision, 11 Oct 2026): the teacher creates each child's
account — a username and a 4-digit PIN — and the child signs in with those two alone, no
class code. Usernames are unique across the whole system (case-insensitive), so a sign-in
needs nothing else to find the account.

A student belongs to a *centre*, not to a class, and is enrolled in classes term by
term. That is what lets mastery follow a child across terms in Phase 8; the alternative
resets a child's history every term.
"""

import uuid
from datetime import datetime
from enum import StrEnum

from sqlalchemy import CheckConstraint, DateTime, Index, String, text
from sqlmodel import Field, SQLModel

from app.models.base import TimestampMixin, new_uuid, utcnow


class StudentStatus(StrEnum):
    ACTIVE = "active"
    ARCHIVED = "archived"


class Student(TimestampMixin, table=True):
    __tablename__ = "students"
    __table_args__ = (
        CheckConstraint("status IN ('active', 'archived')", name="status"),
        # Lower-case letters, digits and dots, 2–30 long. Stored lower-case, and the index
        # is on lower() anyway, so "Aria.K" and "aria.k" can never both exist.
        CheckConstraint("username ~ '^[a-z0-9.]{2,30}$'", name="username"),
        Index("uq_students_username", text("lower(username)"), unique=True),
    )

    id: uuid.UUID = Field(default_factory=new_uuid, primary_key=True)
    centre_id: uuid.UUID = Field(foreign_key="centres.id", index=True)
    display_name: str
    username: str
    status: StudentStatus = Field(default=StudentStatus.ACTIVE, sa_type=String)


class StudentCredential(TimestampMixin, table=True):
    """A student's PIN: an Argon2id hash for sign-in, plus an encrypted copy. Never plaintext.

    The teacher sets the PIN — choosing one or pressing random — when creating the account
    or changing it, and gets the slip then. Since 16 Oct 2026 (Ken's decision, reversing
    11 Oct's hash-only rule) a teacher can also reveal it later with Show PIN, which
    decrypts `pin_ciphertext` under `PIN_ENCRYPTION_KEYS` — a key the database never
    holds — and audits the view. `pin_ciphertext` is null for a PIN set before then, or
    with no key configured; that PIN can only be replaced. Students never set their own:
    that would let whoever reaches a laptop first take over another child's account.
    """

    __tablename__ = "student_credentials"

    student_id: uuid.UUID = Field(foreign_key="students.id", primary_key=True)
    pin_hash: str
    # Fernet token for Show PIN (app/auth/pin.py). Display only; sign-in never reads it.
    pin_ciphertext: str | None = Field(default=None)
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
