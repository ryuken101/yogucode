"""The authorisation seam: one dependency, two verifiers, one Principal.

Teachers arrive with a Supabase JWT in an Authorization header. Students arrive with an
opaque session cookie this service issued. Both resolve to a `Principal`
carrying `centre_id`, and **every route authorises against `Principal.centre_id`**. That
is the tenancy boundary, and a leak across it is a leak of children's records.

`get_current_principal()` never writes. Provisioning a teacher's first `users` row is an
explicit call to `POST /auth/teacher/session` — an auth dependency that silently creates
rows is surprising to debug, and it would put a write in the path of every GET.
"""

import logging
import uuid
from dataclasses import dataclass
from typing import Annotated, Literal

from fastapi import Depends, Header, HTTPException, Request, status
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.auth.student_session import resolve_session
from app.auth.supabase_jwt import (
    JWKSUnavailable,
    SupabaseJWKSVerifier,
    TeacherClaims,
    TokenError,
    get_verifier,
)
from app.config import Settings, get_settings
from app.db import get_session
from app.models import User, UserRole, UserStatus

logger = logging.getLogger(__name__)

STUDENT_SESSION_COOKIE = "student_session"

# Sent as the `code` on a 403 so the web app can tell "you have never signed in here"
# apart from "you are not allowed here" and call the bootstrap endpoint.
NOT_PROVISIONED = "profile_not_provisioned"


@dataclass(frozen=True, slots=True)
class Principal:
    kind: Literal["teacher", "student"]
    subject_id: uuid.UUID
    centre_id: uuid.UUID
    # Teachers only. Students have no role in this sense.
    role: UserRole | None = None

    @property
    def is_teacher(self) -> bool:
        return self.kind == "teacher"

    @property
    def is_student(self) -> bool:
        return self.kind == "student"


def unauthorised(detail: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


def bearer_token(authorization: str | None) -> str | None:
    """The token from an `Authorization: Bearer <token>` header, if it is one."""
    if not authorization:
        return None
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        return None
    return token.strip()


async def verify_teacher_token(
    token: str,
    verifier: SupabaseJWKSVerifier,
    settings: Settings,
) -> TeacherClaims:
    """Verify a Supabase token and check the email against the allowlist.

    The allowlist is checked on every request, not only at provisioning: removing an
    address from config should actually revoke access, rather than only prevent a new
    signup.
    """
    try:
        claims = await verifier.verify(token)
    except TokenError as exc:
        # The caller gets "invalid token" and nothing more — a 401 that explains which
        # claim failed is a 401 that helps someone forge the next one. The reason belongs
        # here, where whoever is debugging a sign-in can actually read it.
        logger.warning("teacher token rejected: %s", exc)
        raise unauthorised("invalid token") from exc
    except JWKSUnavailable as exc:
        logger.error("could not verify a teacher token: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="cannot verify sign-in right now",
        ) from exc

    if not settings.is_teacher_email_allowed(claims.email):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="this address is not permitted to sign in",
        )
    return claims


async def load_teacher(session: AsyncSession, claims: TeacherClaims) -> User:
    """The users row for a verified token, or a 403 telling the caller to bootstrap."""
    user = (
        await session.exec(select(User).where(User.supabase_user_id == claims.supabase_user_id))
    ).one_or_none()

    if user is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": NOT_PROVISIONED, "message": "no profile for this account yet"},
        )
    if user.status != UserStatus.ACTIVE:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="this account is disabled"
        )
    return user


SettingsDep = Annotated[Settings, Depends(get_settings)]
VerifierDep = Annotated[SupabaseJWKSVerifier, Depends(get_verifier)]


async def get_current_principal(
    request: Request,
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: SettingsDep,
    verifier: VerifierDep,
    authorization: Annotated[str | None, Header()] = None,
) -> Principal:
    """Resolve a teacher JWT or a student session cookie into one Principal."""
    token = bearer_token(authorization)
    if token is not None:
        claims = await verify_teacher_token(token, verifier, settings)
        user = await load_teacher(session, claims)
        return Principal(
            kind="teacher",
            subject_id=user.id,
            centre_id=user.centre_id,
            role=user.role,
        )

    cookie = request.cookies.get(STUDENT_SESSION_COOKIE)
    if cookie:
        resolved = await resolve_session(session, cookie, settings)
        if resolved is None:
            # Revoked, expired, idle, archived or simply unknown — all the same 401. The
            # child's remedy is identical in every case (sign in again), and
            # distinguishing them would tell an attacker which tokens once existed.
            raise unauthorised("session is no longer valid")
        _record, student = resolved
        return Principal(kind="student", subject_id=student.id, centre_id=student.centre_id)

    raise unauthorised("not signed in")


CurrentPrincipal = Annotated[Principal, Depends(get_current_principal)]


async def require_teacher(principal: CurrentPrincipal) -> Principal:
    """For routes a student must never reach — the roster, PIN resets, class admin."""
    if not principal.is_teacher:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="teacher access required")
    return principal


CurrentTeacher = Annotated[Principal, Depends(require_teacher)]


async def require_student(principal: CurrentPrincipal) -> Principal:
    """For the handful of routes a student reaches — their own class, their own work."""
    if not principal.is_student:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="student access required")
    return principal


CurrentStudent = Annotated[Principal, Depends(require_student)]
