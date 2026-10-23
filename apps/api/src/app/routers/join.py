"""The student's way in: a username and a PIN (Ken's decision, 11 Oct 2026).

**This is the only unauthenticated surface in the API** apart from teacher sign-up checks.
Every other route resolves a `Principal` first and authorises against its `centre_id`;
sign-in cannot, because the caller has not signed in yet.

Children used to find their class by a code, pick their name from the class list, then
type their PIN. Now the teacher creates a permanent account — a username and a PIN — and
the child types those two and nothing else. So the defences against guessing are:

- every failure answers the same "that username and PIN do not match", whether the
  username exists, has no PIN yet, or the PIN is wrong — no oracle for which children
  exist;
- the per-child lockout: 5 wrong PINs → 15 minutes;
- a per-device limit on wrong PINs across any usernames (`app.auth.rate_limit`), which
  takes the place of the class-code step.
"""

import uuid
from datetime import timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response, status
from pydantic import BaseModel, Field
from sqlmodel import func, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.auth.pin import verify_pin
from app.auth.principal import (
    STUDENT_SESSION_COOKIE,
    CurrentStudent,
    SettingsDep,
    unauthorised,
)
from app.auth.rate_limit import client_ip, pin_failures
from app.auth.student_session import mint_session, token_hash
from app.db import get_session
from app.models import (
    ActorType,
    AuditLog,
    Class,
    ClassStatus,
    Enrolment,
    EnrolmentStatus,
    Student,
    StudentCredential,
    StudentSession,
    StudentStatus,
)
from app.models.base import utcnow

router = APIRouter(tags=["join"])

SessionDep = Annotated[AsyncSession, Depends(get_session)]


class StudentSignInIn(BaseModel):
    username: str = Field(min_length=1, max_length=40)
    pin: str = Field(min_length=1, max_length=16)


class StudentMeOut(BaseModel):
    student_id: uuid.UUID
    display_name: str
    class_id: uuid.UUID
    class_name: str
    term_label: str | None

    @classmethod
    def build(cls, student: Student, klass: Class) -> "StudentMeOut":
        return cls(
            student_id=student.id,
            display_name=student.display_name,
            class_id=klass.id,
            class_name=klass.name,
            term_label=klass.term_label,
        )


async def _class_of(session: AsyncSession, student_id: uuid.UUID) -> Class | None:
    return (
        await session.exec(
            select(Class)
            .join(Enrolment, Enrolment.class_id == Class.id)  # type: ignore[arg-type]
            .where(
                Enrolment.student_id == student_id,
                Enrolment.status == EnrolmentStatus.ACTIVE,
                # A removed (archived) class is not somewhere a child can go.
                Class.status == ClassStatus.ACTIVE,
            )
            .order_by(Enrolment.id.desc())  # type: ignore[attr-defined]
        )
    ).first()


@router.post("/auth/student/session", response_model=StudentMeOut)
async def student_sign_in(
    body: StudentSignInIn,
    request: Request,
    response: Response,
    session: SessionDep,
    settings: SettingsDep,
    user_agent: Annotated[str | None, Header()] = None,
) -> StudentMeOut:
    """Username plus PIN, in exchange for a session cookie."""
    device = client_ip(request)
    window = settings.pin_failure_window_minutes * 60
    if pin_failures.blocked(device, settings.pin_failures_per_device, window):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=(
                "too many wrong tries on this computer — wait a few minutes, or ask your teacher"
            ),
        )

    student = (
        await session.exec(
            select(Student).where(
                func.lower(Student.username) == body.username.strip().lower(),
                Student.status == StudentStatus.ACTIVE,
            )
        )
    ).one_or_none()
    credential = await session.get(StudentCredential, student.id) if student else None

    # An unknown username, and a child whose teacher has not set a PIN, fail exactly as a
    # wrong PIN does. Anything else turns this route into an oracle for which children
    # exist and which are signed up.
    if student is None or credential is None:
        pin_failures.fail(device, window)
        raise unauthorised("that username and PIN do not match")

    now = utcnow()
    if credential.locked_until is not None and credential.locked_until > now:
        remaining = int((credential.locked_until - now).total_seconds() // 60) + 1
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"too many wrong tries — ask your teacher, or try again in {remaining} minutes",
        )

    if not verify_pin(credential.pin_hash, body.pin):
        credential.failed_attempts += 1
        locked = credential.failed_attempts >= settings.pin_max_failed_attempts
        if locked:
            credential.locked_until = now + timedelta(minutes=settings.pin_lockout_minutes)
            credential.failed_attempts = 0
            session.add(
                AuditLog(
                    centre_id=student.centre_id,
                    actor_type=ActorType.STUDENT,
                    actor_id=student.id,
                    action="student.locked_out",
                    target_type="student",
                    target_id=student.id,
                    payload={"minutes": settings.pin_lockout_minutes},
                )
            )
        session.add(credential)
        pin_failures.fail(device, window)
        # The counter has to be committed before the refusal is raised. Raising first
        # would roll the increment back, and the fifth wrong PIN would never lock
        # anything — a bug that passes review and fails silently in a classroom.
        await session.commit()
        raise unauthorised("that username and PIN do not match")

    # Signed in, but in no class: nothing to show them yet. Said only after the right PIN,
    # so it reveals nothing to someone guessing.
    klass = await _class_of(session, student.id)
    if klass is None:
        await session.rollback()
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You’re not in a class yet — ask your teacher to add you.",
        )

    credential.failed_attempts = 0
    credential.locked_until = None
    session.add(credential)

    _record, token = await mint_session(session, student, settings, user_agent)
    session.add(
        AuditLog(
            centre_id=student.centre_id,
            actor_type=ActorType.STUDENT,
            actor_id=student.id,
            action="student.signed_in",
            target_type="student",
            target_id=student.id,
            payload={"class_id": str(klass.id)},
        )
    )
    await session.commit()

    # No max_age: a browser-session cookie, gone when the browser quits (Ken's decision,
    # 10 Oct 2026 — closing the app means signing in again). Closing just the tab is
    # handled by the web app (lib/tabSession.ts). The server-side limits still apply on
    # top: student_session_hours absolute, student_session_idle_minutes idle.
    response.set_cookie(
        STUDENT_SESSION_COOKIE,
        token,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        path="/",
    )
    return StudentMeOut.build(student, klass)


@router.post("/auth/student/logout", status_code=status.HTTP_204_NO_CONTENT)
async def student_sign_out(
    request: Request, response: Response, session: SessionDep, settings: SettingsDep
) -> Response:
    """End this session. Idempotent — signing out twice is not an error."""
    cookie = request.cookies.get(STUDENT_SESSION_COOKIE)
    if cookie:
        found = (
            await session.exec(
                select(StudentSession).where(StudentSession.token_hash == token_hash(cookie))
            )
        ).one_or_none()
        if found is not None and found.revoked_at is None:
            found.revoked_at = utcnow()
            session.add(found)
            await session.commit()

    response.delete_cookie(
        STUDENT_SESSION_COOKIE,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        path="/",
    )
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


@router.get("/auth/student/me", response_model=StudentMeOut)
async def read_current_student(principal: CurrentStudent, session: SessionDep) -> StudentMeOut:
    """Who am I? The web app calls this on load to decide which screen to show."""
    student = await session.get(Student, principal.subject_id)
    klass = await _class_of(session, principal.subject_id)
    if student is None or klass is None:
        raise unauthorised("no class for this student")
    return StudentMeOut.build(student, klass)
