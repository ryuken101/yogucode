"""The student's way in: find the class by code, then sign in with a name and a PIN.

**This is the only unauthenticated surface in the API.** Every other route resolves a
`Principal` first and authorises against its `centre_id`; these three cannot, because the
caller is a nine-year-old who has not signed in. What stands in for the tenancy filter is
the join code: knowing it is what authorises the lookup, and the lookup returns display
names and nothing else — no ids of anything but the students, no centre, no PINs, no
enrolment history.

Signing in needs the code *as well as* the name and the PIN. That is deliberate defence in
depth: a roster id on its own, or a guessed PIN on its own, is not a way in.

`/join/lookup` is a POST rather than a GET because the code goes in a body rather than a
URL. A class code in a query string ends up in browser history, in proxy logs, and in the
`Referer` header of whatever the page loads next.
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
from app.auth.student_session import mint_session, token_hash
from app.db import get_session
from app.join_codes import resolve_code
from app.models import (
    ActorType,
    AuditLog,
    Class,
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


class JoinLookupIn(BaseModel):
    code: str = Field(min_length=1, max_length=32)


class JoinStudentOut(BaseModel):
    """A name on the picker, and whether it can be signed in to yet."""

    id: uuid.UUID
    display_name: str
    has_pin: bool


class JoinLookupOut(BaseModel):
    class_id: uuid.UUID
    class_name: str
    term_label: str | None
    students: list[JoinStudentOut]


class StudentSignInIn(BaseModel):
    code: str = Field(min_length=1, max_length=32)
    student_id: uuid.UUID
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


def _bad_code() -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="class code not found")


async def _roster_for(session: AsyncSession, class_id: uuid.UUID) -> list[tuple[Student, bool]]:
    """Active students in a class, alphabetically, each with whether a PIN is set.

    Not routed through `app.scoping` — see the module docstring. The class has already
    been established by the code, and this reads only that class.
    """
    rows = (
        await session.exec(
            select(Student, StudentCredential.student_id)  # type: ignore[call-overload]
            .join(Enrolment, Enrolment.student_id == Student.id)  # type: ignore[arg-type]
            .join(
                StudentCredential,
                StudentCredential.student_id == Student.id,  # type: ignore[arg-type]
                isouter=True,
            )
            .where(
                Enrolment.class_id == class_id,
                Enrolment.status == EnrolmentStatus.ACTIVE,
                Student.status == StudentStatus.ACTIVE,
            )
            # Case-insensitively, to match the teacher's roster — a child looking for
            # their name should find it in the same place the teacher saw it.
            .order_by(func.lower(Student.display_name))
        )
    ).all()
    return [(student, credential_id is not None) for student, credential_id in rows]


async def _class_of(session: AsyncSession, student_id: uuid.UUID) -> Class | None:
    return (
        await session.exec(
            select(Class)
            .join(Enrolment, Enrolment.class_id == Class.id)  # type: ignore[arg-type]
            .where(
                Enrolment.student_id == student_id,
                Enrolment.status == EnrolmentStatus.ACTIVE,
            )
            .order_by(Enrolment.id.desc())  # type: ignore[attr-defined]
        )
    ).first()


@router.post("/join/lookup", response_model=JoinLookupOut)
async def lookup_class(body: JoinLookupIn, session: SessionDep) -> JoinLookupOut:
    """Turn a class code into the list of names a child picks from."""
    klass = await resolve_code(session, body.code)
    if klass is None:
        raise _bad_code()

    roster = await _roster_for(session, klass.id)
    return JoinLookupOut(
        class_id=klass.id,
        class_name=klass.name,
        term_label=klass.term_label,
        students=[
            JoinStudentOut(id=student.id, display_name=student.display_name, has_pin=has_pin)
            for student, has_pin in roster
        ],
    )


@router.post("/auth/student/session", response_model=StudentMeOut)
async def student_sign_in(
    body: StudentSignInIn,
    response: Response,
    session: SessionDep,
    settings: SettingsDep,
    user_agent: Annotated[str | None, Header()] = None,
) -> StudentMeOut:
    """Name plus PIN plus class code, in exchange for a session cookie."""
    klass = await resolve_code(session, body.code)
    if klass is None:
        raise _bad_code()

    roster = {student.id: student for student, _ in await _roster_for(session, klass.id)}
    student = roster.get(body.student_id)
    credential = (
        await session.get(StudentCredential, body.student_id) if student is not None else None
    )

    # A student who is not on this roster, and one whose teacher has not issued a PIN,
    # fail exactly as a wrong PIN does. Anything else turns this route into an oracle for
    # which children exist and which are signed up.
    if student is None or credential is None:
        raise unauthorised("that name and PIN do not match")

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
        # The counter has to be committed before the refusal is raised. Raising first
        # would roll the increment back, and the fifth wrong PIN would never lock
        # anything — a bug that passes review and fails silently in a classroom.
        await session.commit()
        raise unauthorised("that name and PIN do not match")

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
