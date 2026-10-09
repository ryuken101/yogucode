"""Teacher accounts by invitation, and the owner's Teachers page (routers/teachers.py).

What is being defended (Ken's decisions, 10 Oct 2026):

- Supabase will create an account for anyone, so an account is not a teacher. Only an
  address the owner invited (or the bootstrap allowlist) provisions.
- Only the owner invites and removes. A teacher and a student both get 403.
- Removing a teacher takes effect on their next request, and inviting them again brings
  the same profile back rather than a second one.
- Everything is scoped to the owner's centre.
"""

import uuid

from sqlmodel import func, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.models import AuditLog, InviteStatus, TeacherInvite, User, UserStatus

# The test allowlist is "@example.com", so invited teachers use another domain.
SAM = "sam@school.test"


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def owner(signed_in) -> dict[str, str]:
    return await signed_in("ken@example.com")


async def invite(client, headers, email: str = SAM):
    return await client.post("/teachers/invites", headers=headers, json={"email": email})


# --- who may become a teacher ---------------------------------------------------------


async def test_an_uninvited_address_cannot_become_a_teacher(client, make_token, signed_in):
    await owner(signed_in)
    response = await client.post("/auth/teacher/session", headers=auth(make_token(email=SAM)))
    assert response.status_code == 403
    assert "invited" in response.json()["detail"]


async def test_an_invited_address_becomes_a_teacher_and_the_invite_is_used(
    client, make_token, signed_in, session: AsyncSession
):
    headers = await owner(signed_in)
    assert (await invite(client, headers, "Sam@School.test ")).status_code == 201

    response = await client.post(
        "/auth/teacher/session", headers=auth(make_token(email=SAM, full_name="Sam Lee"))
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["role"] == "teacher"
    assert body["display_name"] == "Sam Lee", "the name from the sign-up form"

    stored = (await session.exec(select(TeacherInvite))).one()
    assert stored.status == InviteStatus.ACCEPTED
    assert stored.accepted_at is not None


async def test_signup_allowed_answers_yes_or_no_and_nothing_else(client, signed_in):
    headers = await owner(signed_in)
    await invite(client, headers)

    yes = await client.get("/auth/signup-allowed", params={"email": "SAM@school.test"})
    no = await client.get("/auth/signup-allowed", params={"email": "stranger@school.test"})
    bootstrap = await client.get("/auth/signup-allowed", params={"email": "anyone@example.com"})
    assert yes.json() == {"allowed": True}
    assert no.json() == {"allowed": False}
    assert bootstrap.json() == {"allowed": True}
    assert (await client.get("/auth/signup-allowed", params={"email": "nope"})).status_code == 422


async def test_a_revoked_invite_no_longer_lets_anyone_in(client, make_token, signed_in):
    headers = await owner(signed_in)
    invite_id = (await invite(client, headers)).json()["id"]
    assert (
        await client.post(f"/teachers/invites/{invite_id}/revoke", headers=headers)
    ).status_code == 204

    response = await client.post("/auth/teacher/session", headers=auth(make_token(email=SAM)))
    assert response.status_code == 403
    allowed = await client.get("/auth/signup-allowed", params={"email": SAM})
    assert allowed.json() == {"allowed": False}


# --- removing a teacher ---------------------------------------------------------------


async def test_a_removed_teacher_is_out_on_their_next_request(client, make_token, signed_in):
    headers = await owner(signed_in)
    await invite(client, headers)
    sam = auth(make_token(email=SAM))
    sam_id = (await client.post("/auth/teacher/session", headers=sam)).json()["id"]
    assert (await client.get("/classes", headers=sam)).status_code == 200

    assert (await client.post(f"/teachers/{sam_id}/remove", headers=headers)).status_code == 204

    assert (await client.get("/classes", headers=sam)).status_code == 403
    assert (await client.get("/auth/me", headers=sam)).status_code == 403
    # Signing in again does not get round it.
    again = await client.post("/auth/teacher/session", headers=sam)
    assert again.status_code == 403
    assert "removed" in again.json()["detail"]


async def test_inviting_a_removed_teacher_again_brings_back_the_same_profile(
    client, make_token, signed_in, session: AsyncSession
):
    headers = await owner(signed_in)
    await invite(client, headers)
    token = make_token(email=SAM)
    sam_id = (await client.post("/auth/teacher/session", headers=auth(token))).json()["id"]
    await client.post(f"/teachers/{sam_id}/remove", headers=headers)

    assert (await invite(client, headers)).status_code == 201
    back = await client.post("/auth/teacher/session", headers=auth(token))
    assert back.status_code == 200
    assert back.json()["id"] == sam_id, "the same teacher, with their history"
    count = (await session.exec(select(func.count()).select_from(User))).one()
    assert count == 2


async def test_the_owner_cannot_remove_themselves(client, signed_in):
    headers = await owner(signed_in)
    me = (await client.get("/auth/me", headers=headers)).json()
    response = await client.post(f"/teachers/{me['id']}/remove", headers=headers)
    assert response.status_code == 409


# --- the page itself ------------------------------------------------------------------


async def test_the_owner_sees_teachers_and_open_invites(client, make_token, signed_in):
    headers = await owner(signed_in)
    await invite(client, headers)
    await invite(client, headers, "kim@school.test")
    await client.post("/auth/teacher/session", headers=auth(make_token(email=SAM)))

    body = (await client.get("/teachers", headers=headers)).json()
    assert [t["email"] for t in body["teachers"]] == ["ken@example.com", SAM]
    assert body["teachers"][0]["is_you"] is True
    assert body["teachers"][0]["role"] == "owner"
    assert [i["email"] for i in body["invites"]] == ["kim@school.test"], "used ones drop off"


async def test_inviting_twice_is_the_same_invite(client, signed_in, session: AsyncSession):
    headers = await owner(signed_in)
    first = (await invite(client, headers)).json()
    second = (await invite(client, headers, "SAM@school.test")).json()
    assert first["id"] == second["id"]
    count = (await session.exec(select(func.count()).select_from(TeacherInvite))).one()
    assert count == 1


async def test_an_existing_teacher_or_a_non_email_is_refused(client, signed_in):
    headers = await owner(signed_in)
    assert (await invite(client, headers, "ken@example.com")).status_code == 409
    assert (await invite(client, headers, "not an email")).status_code == 422


async def test_every_change_is_audited(client, make_token, signed_in, session: AsyncSession):
    headers = await owner(signed_in)
    invite_id = (await invite(client, headers)).json()["id"]
    await client.post(f"/teachers/invites/{invite_id}/revoke", headers=headers)
    await invite(client, headers)
    sam_id = (
        await client.post("/auth/teacher/session", headers=auth(make_token(email=SAM)))
    ).json()["id"]
    await client.post(f"/teachers/{sam_id}/remove", headers=headers)

    actions = (await session.exec(select(AuditLog.action))).all()
    for action in ["teacher.invited", "teacher.invite_revoked", "teacher.removed"]:
        assert action in actions, action


# --- authorisation: the tests that matter most ----------------------------------------


async def test_a_teacher_who_is_not_the_owner_gets_403_everywhere(client, make_token, signed_in):
    headers = await owner(signed_in)
    await invite(client, headers)
    sam = auth(make_token(email=SAM))
    await client.post("/auth/teacher/session", headers=sam)
    ken_id = (await client.get("/auth/me", headers=headers)).json()["id"]
    invite_id = (await invite(client, headers, "kim@school.test")).json()["id"]

    assert (await client.get("/teachers", headers=sam)).status_code == 403
    assert (await invite(client, sam, "eve@school.test")).status_code == 403
    assert (
        await client.post(f"/teachers/invites/{invite_id}/revoke", headers=sam)
    ).status_code == 403
    assert (await client.post(f"/teachers/{ken_id}/remove", headers=sam)).status_code == 403


async def test_a_student_gets_403(client, signed_in_student):
    await signed_in_student()
    assert (await client.get("/teachers")).status_code == 403
    assert (await invite(client, {}, "eve@school.test")).status_code == 403


async def test_another_centres_invites_and_teachers_are_not_found(
    client, signed_in, foreign_centre, session: AsyncSession
):
    headers = await owner(signed_in)
    outsider = User(
        supabase_user_id=uuid.uuid4(),
        centre_id=foreign_centre["centre"].id,
        email="other@elsewhere.test",
        display_name="Other",
    )
    session.add(outsider)
    await session.flush()
    theirs = TeacherInvite(
        centre_id=foreign_centre["centre"].id, email="x@elsewhere.test", invited_by=outsider.id
    )
    session.add(theirs)
    await session.flush()

    assert (
        await client.post(f"/teachers/{outsider.id}/remove", headers=headers)
    ).status_code == 404
    assert (
        await client.post(f"/teachers/invites/{theirs.id}/revoke", headers=headers)
    ).status_code == 404
    await session.refresh(outsider)
    await session.refresh(theirs)
    assert outsider.status == UserStatus.ACTIVE
    assert theirs.status == InviteStatus.PENDING
    listing = (await client.get("/teachers", headers=headers)).json()
    assert "other@elsewhere.test" not in str(listing)
