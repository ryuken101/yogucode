"""App-issued opaque sessions for students.

A student's session is a `secrets.token_urlsafe(32)` string returned in an httpOnly
cookie, of which only the SHA-256 hash is ever stored. It is opaque rather than a JWT for
exactly one reason: **it has to be revocable.** A teacher kicking a session — the wrong
child signed in, a laptop left open — must take effect on the next request, not whenever
a token happens to expire.

SHA-256 rather than Argon2id for the token, deliberately. A 256-bit random token has no
guessable structure, so there is nothing for a slow KDF to defend; the hash is there so a
leaked database does not hand over live sessions, and a fast hash does that job while
being cheap enough to run on every single request.

**One live session per student.** Signing in revokes the others. In a classroom, two
concurrent sessions for one child means either a laptop was abandoned still signed in or
somebody else is using her name, and neither is worth preserving. Homework at home and
the next lesson at the centre are sequential, not concurrent, so nothing real is lost —
and it means an abandoned laptop stops being usable the moment that child signs in
somewhere else, without anyone having to notice.

Two clocks bound a session: `expires_at` is absolute (12h, so it cannot outlive the day on
a shared laptop) and `last_seen_at` plus the idle window (90min, so an abandoned laptop
logs itself out). It still survives a browser restart mid-lesson, which is the case that
made a cookie the right answer in the first place.
"""

import hashlib
import secrets
import uuid
from datetime import datetime, timedelta

from sqlmodel import select, update
from sqlmodel.ext.asyncio.session import AsyncSession

from app.config import Settings
from app.models import Student, StudentSession, StudentStatus
from app.models.base import utcnow

SESSION_TOKEN_BYTES = 32

# `last_seen_at` drives the idle clock, so it has to move — but writing it on every single
# request turns every read into a write for no benefit. A minute of slack is invisible
# against a 90-minute window.
TOUCH_AFTER_SECONDS = 60


def new_token() -> str:
    return secrets.token_urlsafe(SESSION_TOKEN_BYTES)


def token_hash(token: str) -> str:
    """SHA-256 hex of the token. The only form of it that touches the database."""
    return hashlib.sha256(token.encode()).hexdigest()


async def revoke_live_sessions(
    session: AsyncSession, student_id: uuid.UUID, now: datetime | None = None
) -> int:
    """Revoke every unrevoked session for a student. Returns how many.

    Used by three callers with the same meaning — the teacher's kick, archiving a student,
    and signing in somewhere new — which is why it is here rather than inline in any of
    them.
    """
    when = now or utcnow()
    live = (
        await session.exec(
            select(StudentSession).where(
                StudentSession.student_id == student_id,
                StudentSession.revoked_at.is_(None),  # type: ignore[union-attr]
            )
        )
    ).all()
    if live:
        await session.exec(
            update(StudentSession)
            .where(
                StudentSession.student_id == student_id,  # type: ignore[arg-type]
                StudentSession.revoked_at.is_(None),  # type: ignore[union-attr]
            )
            .values(revoked_at=when)
        )
    return len(live)


async def mint_session(
    session: AsyncSession,
    student: Student,
    settings: Settings,
    user_agent: str | None = None,
) -> tuple[StudentSession, str]:
    """Start a session, ending the student's others. Returns the row and the raw token.

    The raw token is returned rather than stored: this is the only moment it exists
    outside the child's browser.
    """
    await revoke_live_sessions(session, student.id)

    token = new_token()
    now = utcnow()
    record = StudentSession(
        student_id=student.id,
        token_hash=token_hash(token),
        issued_at=now,
        expires_at=now + timedelta(hours=settings.student_session_hours),
        last_seen_at=now,
        user_agent=(user_agent or "")[:500] or None,
    )
    session.add(record)
    await session.flush()
    return record, token


async def resolve_session(
    session: AsyncSession, token: str, settings: Settings
) -> tuple[StudentSession, Student] | None:
    """The live session and its student, or None if the cookie is not a way in.

    Returns the `Student` as well because `student_sessions` carries no `centre_id`, and
    `Principal` needs one — the tenancy boundary is enforced on every route against it, so
    resolving a session without one would be resolving a principal that cannot be checked.

    Refuses, in order: an unknown token, a revoked session, one past its absolute expiry,
    one past its idle window, and a session belonging to an archived student. The last is
    belt and braces — archiving revokes sessions — but "an archived student cannot log in"
    is on the phase plan's verification list and should not depend on a second write
    having happened.
    """
    if not token:
        return None

    found = (
        await session.exec(
            select(StudentSession, Student)
            .join(Student, StudentSession.student_id == Student.id)  # type: ignore[arg-type]
            .where(StudentSession.token_hash == token_hash(token))
        )
    ).one_or_none()
    if found is None:
        return None

    record, student = found
    now = utcnow()
    if record.revoked_at is not None:
        return None
    if record.expires_at <= now:
        return None
    idle_limit = record.last_seen_at + timedelta(minutes=settings.student_session_idle_minutes)
    if idle_limit <= now:
        return None
    if student.status != StudentStatus.ACTIVE:
        return None

    if (now - record.last_seen_at).total_seconds() >= TOUCH_AFTER_SECONDS:
        record.last_seen_at = now
        session.add(record)

    return record, student
