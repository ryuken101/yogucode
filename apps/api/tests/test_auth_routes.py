"""The sign-in routes and first-sign-in provisioning.

The decisions being defended here: one academy is one centre no matter how many teachers
sign in, the allowlist is a real gate rather than a signup form, and nothing provisions
except the bootstrap endpoint.
"""

import uuid

from cryptography.hazmat.primitives.asymmetric import ec
from sqlmodel import func, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.auth.provisioning import get_or_create_centre
from app.models import AuditLog, Centre, User, UserRole, UserStatus


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


# --- provisioning ------------------------------------------------------------------


async def test_first_sign_in_creates_the_centre_and_an_owner(
    client, make_token, session: AsyncSession
) -> None:
    response = await client.post(
        "/auth/teacher/session", headers=auth(make_token(email="ken@example.com"))
    )
    assert response.status_code == 200

    body = response.json()
    assert body["email"] == "ken@example.com"
    assert body["display_name"] == "Ken Nguyen"
    assert body["role"] == "owner"
    assert body["centre"]["slug"] == "castle-hill"
    assert body["centre"]["name"] == "Magikid Castle Hill"

    centres = (await session.exec(select(Centre))).all()
    assert len(centres) == 1


async def test_a_second_teacher_joins_the_same_centre(
    client, make_token, session: AsyncSession
) -> None:
    """The decision that matters: one academy is one tenant.

    If the second teacher got their own centre they would silently be unable to see the
    first teacher's classes, and merging afterwards means moving rows across the
    tenancy boundary.
    """
    first = await client.post(
        "/auth/teacher/session", headers=auth(make_token(email="ken@example.com"))
    )
    second = await client.post(
        "/auth/teacher/session", headers=auth(make_token(email="sam@example.com"))
    )
    assert first.status_code == second.status_code == 200

    assert first.json()["centre"]["id"] == second.json()["centre"]["id"]
    assert first.json()["role"] == "owner"
    assert second.json()["role"] == "teacher"

    centre_count = (await session.exec(select(func.count()).select_from(Centre))).one()
    assert centre_count == 1


async def test_bootstrapping_twice_is_idempotent(client, make_token, session: AsyncSession) -> None:
    """The web app may call this on every load; it must not pile up rows."""
    token = make_token(email="ken@example.com")
    first = await client.post("/auth/teacher/session", headers=auth(token))
    second = await client.post("/auth/teacher/session", headers=auth(token))

    assert first.json()["id"] == second.json()["id"]
    user_count = (await session.exec(select(func.count()).select_from(User))).one()
    assert user_count == 1


async def test_provisioning_is_audited(client, make_token, session: AsyncSession) -> None:
    """Teacher records get created under the Privacy Act; record who and when."""
    await client.post("/auth/teacher/session", headers=auth(make_token(email="ken@example.com")))

    entries = (
        await session.exec(select(AuditLog).where(AuditLog.action == "teacher.provisioned"))
    ).all()
    assert len(entries) == 1
    assert entries[0].payload["email"] == "ken@example.com"


async def test_get_or_create_centre_is_safe_to_call_twice(
    session: AsyncSession, test_settings
) -> None:
    """Two teachers signing in at the same moment must not make two centres.

    The unique constraint on slug is the arbiter, via ON CONFLICT DO NOTHING, rather
    than a check-then-insert that races.
    """
    first = await get_or_create_centre(session, test_settings)
    second = await get_or_create_centre(session, test_settings)

    assert first.id == second.id
    count = (await session.exec(select(func.count()).select_from(Centre))).one()
    assert count == 1


async def test_display_name_falls_back_to_the_email_local_part(client, make_token) -> None:
    response = await client.post(
        "/auth/teacher/session",
        headers=auth(make_token(email="ken@example.com", full_name=None)),
    )
    assert response.json()["display_name"] == "ken"


# --- the allowlist gate ------------------------------------------------------------


async def test_an_address_outside_the_allowlist_cannot_provision(
    client, make_token, session: AsyncSession
) -> None:
    """Supabase sign-up is open to anyone; without this, any account becomes a tenant."""
    response = await client.post(
        "/auth/teacher/session", headers=auth(make_token(email="stranger@gmail.com"))
    )
    assert response.status_code == 403
    assert "invited" in response.json()["detail"], "said for a person, not a developer"

    user_count = (await session.exec(select(func.count()).select_from(User))).one()
    centre_count = (await session.exec(select(func.count()).select_from(Centre))).one()
    assert user_count == 0
    assert centre_count == 0


async def test_the_allowlist_only_bootstraps_and_does_not_hold_access(
    client, make_token, test_settings
) -> None:
    """TEACHER_EMAIL_ALLOWLIST lets the first owner in; after that the users row decides.

    Revoking is the owner's Remove button now (test_teachers.py), not a config edit.
    """
    token = make_token(email="ken@example.com")
    assert (await client.post("/auth/teacher/session", headers=auth(token))).status_code == 200

    test_settings.teacher_email_allowlist = "someone-else@example.com"
    assert (await client.get("/auth/me", headers=auth(token))).status_code == 200


# --- /auth/me and the seam ---------------------------------------------------------


async def test_me_returns_the_profile(client, make_token) -> None:
    token = make_token(email="ken@example.com")
    await client.post("/auth/teacher/session", headers=auth(token))

    response = await client.get("/auth/me", headers=auth(token))
    assert response.status_code == 200
    assert response.json()["email"] == "ken@example.com"
    assert response.json()["centre"]["slug"] == "castle-hill"


async def test_me_tells_an_unprovisioned_caller_to_bootstrap(client, make_token) -> None:
    """A valid token with no users row is a distinct case the web app acts on."""
    response = await client.get("/auth/me", headers=auth(make_token(email="new@example.com")))
    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "profile_not_provisioned"


async def test_a_disabled_account_is_refused(client, make_token, session: AsyncSession) -> None:
    token = make_token(email="ken@example.com")
    await client.post("/auth/teacher/session", headers=auth(token))

    user = (await session.exec(select(User))).one()
    user.status = UserStatus.DISABLED
    session.add(user)
    await session.flush()

    assert (await client.get("/auth/me", headers=auth(token))).status_code == 403


async def test_an_unsigned_request_is_refused(client) -> None:
    assert (await client.get("/auth/me")).status_code == 401
    assert (await client.post("/auth/teacher/session")).status_code == 401


async def test_a_forged_token_is_refused(client, make_token) -> None:
    """Signed by a key that is not the project's — allowlisted email, still out."""
    forged = make_token(email="ken@example.com", key=ec.generate_private_key(ec.SECP256R1()))
    assert (await client.get("/auth/me", headers=auth(forged))).status_code == 401
    assert (await client.post("/auth/teacher/session", headers=auth(forged))).status_code == 401


async def test_a_malformed_authorization_header_is_refused(client) -> None:
    for header in ({"Authorization": "Basic abc"}, {"Authorization": "Bearer"}):
        assert (await client.get("/auth/me", headers=header)).status_code == 401


async def test_a_student_cookie_is_not_a_way_in_yet(client) -> None:
    """The student branch of the seam exists but must refuse until step 7."""
    client.cookies.set("student_session", "anything")
    assert (await client.get("/auth/me")).status_code == 401


async def test_the_principal_carries_the_centre(client, make_token, session: AsyncSession) -> None:
    """Every route authorises against Principal.centre_id, so it must be populated."""
    await client.post("/auth/teacher/session", headers=auth(make_token(email="ken@example.com")))

    user = (await session.exec(select(User))).one()
    centre = (await session.exec(select(Centre))).one()
    assert user.centre_id == centre.id
    assert user.role == UserRole.OWNER
    assert isinstance(user.id, uuid.UUID)
