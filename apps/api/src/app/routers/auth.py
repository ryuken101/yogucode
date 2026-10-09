"""Sign-in routes.

`POST /auth/teacher/session` is the only route that provisions. The web app calls it
after a teacher's first verified sign-in (the email-confirmation link lands on
/auth/callback); everything else assumes a `users` row exists and returns 403
`profile_not_provisioned` if it does not.

`GET /auth/signup-allowed` lets the sign-up page say "ask your centre to add you" before
an account is created in Supabase. It is a courtesy, not the gate: provisioning checks
again, because anyone can create a Supabase account without going through our page.
"""

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from pydantic import BaseModel
from sqlmodel.ext.asyncio.session import AsyncSession

from app.auth.principal import (
    CurrentTeacher,
    SettingsDep,
    VerifierDep,
    bearer_token,
    load_teacher,
    unauthorised,
    verify_teacher_token,
)
from app.auth.provisioning import may_create_account, provision_teacher
from app.db import get_session
from app.models import Centre, User, UserRole
from app.schemas import CentreOut

router = APIRouter(prefix="/auth", tags=["auth"])


class TeacherProfileOut(BaseModel):
    id: uuid.UUID
    email: str
    display_name: str
    role: UserRole
    centre: CentreOut

    @classmethod
    def build(cls, user: User, centre: Centre) -> "TeacherProfileOut":
        return cls(
            id=user.id,
            email=user.email,
            display_name=user.display_name,
            role=user.role,
            centre=CentreOut.build(centre),
        )


@router.post("/teacher/session", response_model=TeacherProfileOut)
async def start_teacher_session(
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: SettingsDep,
    verifier: VerifierDep,
    authorization: Annotated[str | None, Header()] = None,
) -> TeacherProfileOut:
    """Exchange a verified Supabase token for a profile, provisioning on first use.

    Idempotent: called twice, the second call returns the same profile rather than
    creating a second row.
    """
    token = bearer_token(authorization)
    if token is None:
        raise unauthorised("not signed in")

    claims = await verify_teacher_token(token, verifier)
    await provision_teacher(session, claims, settings)
    await session.commit()
    # The same check every request makes: a teacher the owner removed (and has not invited
    # back) is refused here too, rather than handed a profile that 403s a moment later.
    user = await load_teacher(session, claims)

    centre = await session.get(Centre, user.centre_id)
    if centre is None:  # pragma: no cover — provisioning guarantees it
        raise unauthorised("centre missing for this profile")
    return TeacherProfileOut.build(user, centre)


class SignupAllowedOut(BaseModel):
    allowed: bool


@router.get("/signup-allowed", response_model=SignupAllowedOut)
async def signup_allowed(
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: SettingsDep,
    email: Annotated[str, Query(max_length=320)],
) -> SignupAllowedOut:
    """Whether this address has been invited. A yes or a no, and nothing else.

    No sign-in needed: the person asking does not have an account yet. It says nothing
    about who invited them, when, or whether they already have an account.
    """
    if "@" not in email:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="not an email")
    return SignupAllowedOut(allowed=await may_create_account(session, settings, email))


@router.get("/me", response_model=TeacherProfileOut)
async def read_current_teacher(
    principal: CurrentTeacher,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> TeacherProfileOut:
    """Who am I? The web app calls this on load to decide whether to bootstrap.

    The dependency has already verified the token and resolved the principal, so this
    reads by id rather than verifying a second time.
    """
    user = await session.get(User, principal.subject_id)
    centre = await session.get(Centre, principal.centre_id)
    if user is None or centre is None:  # pragma: no cover — the principal came from these
        raise unauthorised("profile missing")
    return TeacherProfileOut.build(user, centre)
