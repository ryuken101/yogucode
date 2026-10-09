"""Several teachers on one class, and removing a child from a class (Ken's decisions,
10 Oct 2026).

- `class_teachers` is organisation, not permission: any teacher at the centre can still
  open any class, and any of them may change who is listed. A class always keeps a Lead.
- `is_mine` marks the classes the caller teaches, for "My classes".
- Removing a child from a class signs them out, so they cannot keep working in it.
- Everything is centre-scoped: another centre's class or teacher is a 404, and a student
  gets 403.
"""

import uuid

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.models import AuditLog, User, UserStatus

KEN = "ken@example.com"
SAM = "sam@example.com"


async def two_teachers(client, signed_in) -> tuple[dict, dict, str, str]:
    """Ken (owner) and Sam, both provisioned; returns headers and user ids."""
    ken = await signed_in(KEN)
    sam = await signed_in(SAM)
    ken_id = (await client.get("/auth/me", headers=ken)).json()["id"]
    sam_id = (await client.get("/auth/me", headers=sam)).json()["id"]
    return ken, sam, ken_id, sam_id


async def new_class(client, headers, name: str = "Year 4-6 Python") -> str:
    return (await client.post("/classes", json={"name": name}, headers=headers)).json()["id"]


# --- teachers on a class -----------------------------------------------------------------


async def test_the_creator_is_lead_and_the_class_is_theirs(client, signed_in):
    ken, sam, ken_id, _ = await two_teachers(client, signed_in)
    class_id = await new_class(client, ken)

    listing = (await client.get(f"/classes/{class_id}/teachers", headers=ken)).json()
    assert [(t["user_id"], t["role"], t["is_you"]) for t in listing] == [(ken_id, "lead", True)]

    assert (await client.get(f"/classes/{class_id}", headers=ken)).json()["is_mine"] is True
    assert (await client.get(f"/classes/{class_id}", headers=sam)).json()["is_mine"] is False
    mine = {c["id"]: c["is_mine"] for c in (await client.get("/classes", headers=sam)).json()}
    assert mine[class_id] is False


async def test_adding_a_teacher_makes_it_their_class_too(client, signed_in):
    ken, sam, _, sam_id = await two_teachers(client, signed_in)
    class_id = await new_class(client, ken)

    candidates = (await client.get(f"/classes/{class_id}/teachers/candidates", headers=ken)).json()
    assert [c["user_id"] for c in candidates] == [sam_id]

    response = await client.put(
        f"/classes/{class_id}/teachers/{sam_id}", json={"role": "assistant"}, headers=ken
    )
    assert response.status_code == 200
    assert [t["role"] for t in response.json()] == ["lead", "assistant"], "Lead first"
    assert (await client.get(f"/classes/{class_id}", headers=sam)).json()["is_mine"] is True
    after = (await client.get(f"/classes/{class_id}/teachers/candidates", headers=ken)).json()
    assert after == []


async def test_roles_change_and_a_class_always_keeps_a_lead(client, signed_in):
    ken, _, ken_id, sam_id = await two_teachers(client, signed_in)
    class_id = await new_class(client, ken)
    url = f"/classes/{class_id}/teachers"

    # The only Lead cannot step down or be removed.
    alone = await client.put(f"{url}/{ken_id}", json={"role": "assistant"}, headers=ken)
    assert alone.status_code == 409
    assert "Lead" in alone.json()["detail"]
    assert (await client.post(f"{url}/{ken_id}/remove", headers=ken)).status_code == 409

    # With a second Lead, the first can go.
    await client.put(f"{url}/{sam_id}", json={"role": "lead"}, headers=ken)
    assert (await client.post(f"{url}/{ken_id}/remove", headers=ken)).status_code == 200
    listing = (await client.get(url, headers=ken)).json()
    assert [(t["user_id"], t["role"]) for t in listing] == [(sam_id, "lead")]
    # Taken off the class, Ken can still open it — this is organisation, not a lock.
    assert (await client.get(f"/classes/{class_id}", headers=ken)).status_code == 200


async def test_every_change_is_audited(client, signed_in, session: AsyncSession):
    ken, _, ken_id, sam_id = await two_teachers(client, signed_in)
    class_id = await new_class(client, ken)
    url = f"/classes/{class_id}/teachers"
    await client.put(f"{url}/{sam_id}", json={"role": "assistant"}, headers=ken)
    await client.put(f"{url}/{sam_id}", json={"role": "lead"}, headers=ken)
    await client.post(f"{url}/{ken_id}/remove", headers=ken)

    actions = (await session.exec(select(AuditLog.action))).all()
    for action in ["class.teacher_added", "class.teacher_role_changed", "class.teacher_removed"]:
        assert action in actions, action


async def test_a_removed_teacher_is_hidden_and_cannot_be_added(
    client, signed_in, session: AsyncSession
):
    ken, _, _, sam_id = await two_teachers(client, signed_in)
    class_id = await new_class(client, ken)
    await client.put(
        f"/classes/{class_id}/teachers/{sam_id}", json={"role": "assistant"}, headers=ken
    )

    sam = await session.get(User, uuid.UUID(sam_id))
    assert sam is not None
    sam.status = UserStatus.DISABLED
    session.add(sam)
    await session.flush()

    listing = (await client.get(f"/classes/{class_id}/teachers", headers=ken)).json()
    assert sam_id not in [t["user_id"] for t in listing]
    candidates = (await client.get(f"/classes/{class_id}/teachers/candidates", headers=ken)).json()
    assert candidates == []
    again = await client.put(
        f"/classes/{class_id}/teachers/{sam_id}", json={"role": "lead"}, headers=ken
    )
    assert again.status_code == 404


async def test_another_centres_class_and_teacher_are_not_found(
    client, signed_in, foreign_centre, session: AsyncSession
):
    ken = await signed_in(KEN)
    class_id = await new_class(client, ken)
    theirs = foreign_centre["class"].id
    outsider = User(
        supabase_user_id=uuid.uuid4(),
        centre_id=foreign_centre["centre"].id,
        email="other@elsewhere.test",
        display_name="Other",
    )
    session.add(outsider)
    await session.flush()

    assert (await client.get(f"/classes/{theirs}/teachers", headers=ken)).status_code == 404
    assert (
        await client.get(f"/classes/{theirs}/teachers/candidates", headers=ken)
    ).status_code == 404
    put_outsider = await client.put(
        f"/classes/{class_id}/teachers/{outsider.id}", json={"role": "lead"}, headers=ken
    )
    assert put_outsider.status_code == 404
    candidates = (await client.get(f"/classes/{class_id}/teachers/candidates", headers=ken)).json()
    assert "other@elsewhere.test" not in str(candidates)


async def test_a_student_gets_403(client, signed_in_student):
    roster = await signed_in_student()
    class_id = roster["class_id"]
    assert (await client.get(f"/classes/{class_id}/teachers")).status_code == 403
    assert (await client.get(f"/classes/{class_id}/teachers/candidates")).status_code == 403
    assert (
        await client.put(f"/classes/{class_id}/teachers/{uuid.uuid4()}", json={"role": "lead"})
    ).status_code == 403
    assert (
        await client.post(f"/classes/{class_id}/teachers/{uuid.uuid4()}/remove")
    ).status_code == 403


# --- removing a child from a class ---------------------------------------------------------


async def test_removing_a_child_from_the_class_signs_them_out(client, signed_in_student):
    roster = await signed_in_student()
    assert (await client.get("/auth/student/me")).status_code == 200
    assert (await client.get("/me/documents")).status_code == 200

    response = await client.post(
        f"/classes/{roster['class_id']}/enrolments/{roster['student_id']}/withdraw",
        headers=roster["headers"],
    )
    assert response.status_code == 200
    assert response.json()["status"] == "withdrawn"

    assert (await client.get("/auth/student/me")).status_code == 401
    # The session itself is gone, not just the class: their files are out of reach too.
    # (/auth/student/me alone would pass without the sign-out — it needs a class anyway.)
    assert (await client.get("/me/documents")).status_code == 401
    # And the class code no longer offers them.
    lookup = (await client.post("/join/lookup", json={"code": roster["code"]})).json()
    assert roster["student_id"] not in str(lookup)


async def test_a_removed_child_can_be_put_back(client, student_on_roster, session: AsyncSession):
    roster = await student_on_roster()
    base = f"/classes/{roster['class_id']}"
    await client.post(
        f"{base}/enrolments/{roster['student_id']}/withdraw", headers=roster["headers"]
    )

    active = (await client.get(f"{base}/roster", headers=roster["headers"])).json()
    everyone = (
        await client.get(f"{base}/roster?include_withdrawn=true", headers=roster["headers"])
    ).json()
    assert active == []
    assert [e["status"] for e in everyone] == ["withdrawn"]

    back = await client.post(
        f"{base}/enrolments/{roster['student_id']}/reinstate", headers=roster["headers"]
    )
    assert back.json()["status"] == "active"

    entry = (
        await session.exec(select(AuditLog).where(AuditLog.action == "enrolment.withdrawn"))
    ).one()
    assert entry.payload["sessions_revoked"] == 0, "nobody was signed in"


# --- removing a whole class -----------------------------------------------------------------


async def test_removing_a_class_signs_its_children_out_and_keeps_everything(
    client, signed_in_student, session: AsyncSession
):
    roster = await signed_in_student()
    assert (await client.get("/me/documents")).status_code == 200

    archived = await client.post(
        f"/classes/{roster['class_id']}/archive", headers=roster["headers"]
    )
    assert archived.json()["status"] == "archived"

    assert (await client.get("/me/documents")).status_code == 401
    # The code no longer opens the door, and the roster is untouched (history kept).
    assert (await client.post("/join/lookup", json={"code": roster["code"]})).status_code != 200
    everyone = (
        await client.get(f"/classes/{roster['class_id']}/roster", headers=roster["headers"])
    ).json()
    assert [e["status"] for e in everyone] == ["active"]

    entry = (await session.exec(select(AuditLog).where(AuditLog.action == "class.archived"))).one()
    assert entry.payload["sessions_revoked"] == 1

    # Putting it back works; it needs a new code, as before.
    restored = await client.post(
        f"/classes/{roster['class_id']}/unarchive", headers=roster["headers"]
    )
    assert restored.json()["status"] == "active"
