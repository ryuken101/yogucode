"""Class CRUD and, more importantly, the tenancy boundary.

The cross-centre tests are the reason this step exists. Until now `Principal.centre_id`
was populated but nothing filtered by it; these are the first tests that can prove a
teacher cannot reach another centre's data.
"""

import uuid

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.models import (
    AuditLog,
    Class,
    ClassJoinCode,
    ClassStatus,
    ClassTeacher,
    ClassTeacherRole,
    Enrolment,
    Student,
    User,
)
from app.models.base import utcnow

# --- creating and listing ----------------------------------------------------------


async def test_create_returns_the_class(client, signed_in) -> None:
    headers = await signed_in()
    response = await client.post(
        "/classes", json={"name": "Year 4-6 Python", "term_label": "2026 T4"}, headers=headers
    )

    assert response.status_code == 201
    body = response.json()
    assert body["name"] == "Year 4-6 Python"
    assert body["term_label"] == "2026 T4"
    assert body["status"] == "active"
    assert uuid.UUID(body["id"]).version == 7


async def test_the_creator_is_recorded_as_lead(client, signed_in, session: AsyncSession) -> None:
    headers = await signed_in()
    created = await client.post("/classes", json={"name": "Year 4-6 Python"}, headers=headers)

    link = (await session.exec(select(ClassTeacher))).one()
    teacher = (await session.exec(select(User))).one()
    assert link.class_id == uuid.UUID(created.json()["id"])
    assert link.user_id == teacher.id
    assert link.role == ClassTeacherRole.LEAD


async def test_term_label_is_optional(client, signed_in) -> None:
    headers = await signed_in()
    response = await client.post("/classes", json={"name": "Holiday workshop"}, headers=headers)
    assert response.status_code == 201
    assert response.json()["term_label"] is None


async def test_an_empty_name_is_rejected(client, signed_in) -> None:
    headers = await signed_in()
    assert (await client.post("/classes", json={"name": ""}, headers=headers)).status_code == 422


async def test_the_list_is_newest_first(client, signed_in) -> None:
    headers = await signed_in()
    for name in ("First", "Second", "Third"):
        await client.post("/classes", json={"name": name}, headers=headers)

    names = [item["name"] for item in (await client.get("/classes", headers=headers)).json()]
    assert names == ["Third", "Second", "First"]


async def test_a_second_teacher_at_the_centre_sees_the_same_classes(client, signed_in) -> None:
    """Teachers cover each other's lessons, so visibility is per centre, not per teacher."""
    ken = await signed_in("ken@example.com")
    await client.post("/classes", json={"name": "Year 4-6 Python"}, headers=ken)

    sam = await signed_in("sam@example.com")
    listed = (await client.get("/classes", headers=sam)).json()
    assert [item["name"] for item in listed] == ["Year 4-6 Python"]


# --- the tenancy boundary ----------------------------------------------------------


async def test_another_centres_class_is_not_listed(client, signed_in, foreign_centre) -> None:
    headers = await signed_in()
    listed = (await client.get("/classes?include_archived=true", headers=headers)).json()
    assert listed == []


async def test_another_centres_class_cannot_be_read(client, signed_in, foreign_centre) -> None:
    """404 rather than 403: a 403 would confirm the id exists."""
    headers = await signed_in()
    foreign_id = foreign_centre["class"].id
    assert (await client.get(f"/classes/{foreign_id}", headers=headers)).status_code == 404


async def test_another_centres_class_cannot_be_modified(
    client, signed_in, foreign_centre, session: AsyncSession
) -> None:
    headers = await signed_in()
    foreign = foreign_centre["class"]

    for method, path in (
        ("patch", f"/classes/{foreign.id}"),
        ("post", f"/classes/{foreign.id}/archive"),
        ("post", f"/classes/{foreign.id}/unarchive"),
    ):
        response = await client.request(method, path, json={"name": "Hijacked"}, headers=headers)
        assert response.status_code == 404, f"{method} {path}"

    await session.refresh(foreign)
    assert foreign.name == "Someone else's class"
    assert foreign.status == ClassStatus.ACTIVE


async def test_an_unknown_id_is_also_404(client, signed_in) -> None:
    headers = await signed_in()
    assert (await client.get(f"/classes/{uuid.uuid4()}", headers=headers)).status_code == 404


# --- renaming ----------------------------------------------------------------------


async def test_rename_persists(client, signed_in) -> None:
    headers = await signed_in()
    created = (await client.post("/classes", json={"name": "Typo"}, headers=headers)).json()

    patched = await client.patch(
        f"/classes/{created['id']}", json={"name": "Year 4-6 Python"}, headers=headers
    )
    assert patched.status_code == 200
    assert patched.json()["name"] == "Year 4-6 Python"

    fetched = await client.get(f"/classes/{created['id']}", headers=headers)
    assert fetched.json()["name"] == "Year 4-6 Python"


async def test_patching_one_field_leaves_the_other_alone(client, signed_in) -> None:
    headers = await signed_in()
    created = (
        await client.post(
            "/classes", json={"name": "Year 4-6 Python", "term_label": "2026 T4"}, headers=headers
        )
    ).json()

    patched = await client.patch(
        f"/classes/{created['id']}", json={"name": "Year 4-6 Python B"}, headers=headers
    )
    assert patched.json()["term_label"] == "2026 T4"


async def test_term_label_can_be_cleared_explicitly(client, signed_in) -> None:
    """An explicit null clears it; an absent field leaves it."""
    headers = await signed_in()
    created = (
        await client.post(
            "/classes", json={"name": "Year 4-6 Python", "term_label": "2026 T4"}, headers=headers
        )
    ).json()

    patched = await client.patch(
        f"/classes/{created['id']}", json={"term_label": None}, headers=headers
    )
    assert patched.json()["term_label"] is None


# --- archiving ---------------------------------------------------------------------


async def test_archiving_hides_the_class_from_the_default_list(client, signed_in) -> None:
    headers = await signed_in()
    created = (await client.post("/classes", json={"name": "Last term"}, headers=headers)).json()

    archived = await client.post(f"/classes/{created['id']}/archive", headers=headers)
    assert archived.status_code == 200
    assert archived.json()["status"] == "archived"

    assert (await client.get("/classes", headers=headers)).json() == []
    included = (await client.get("/classes?include_archived=true", headers=headers)).json()
    assert [item["name"] for item in included] == ["Last term"]


async def test_archiving_revokes_live_join_codes(client, signed_in, session: AsyncSession) -> None:
    """A code for a finished class should not still open a door."""
    headers = await signed_in()
    created = (
        await client.post("/classes", json={"name": "Year 4-6 Python"}, headers=headers)
    ).json()
    class_id = uuid.UUID(created["id"])
    teacher = (await session.exec(select(User))).one()

    already_revoked_at = utcnow()
    session.add_all(
        [
            ClassJoinCode(class_id=class_id, code="HMTKQR", created_by=teacher.id),
            ClassJoinCode(class_id=class_id, code="WNPXYZ", created_by=teacher.id),
            ClassJoinCode(
                class_id=class_id,
                code="OLDONE",
                created_by=teacher.id,
                revoked_at=already_revoked_at,
            ),
        ]
    )
    await session.flush()

    await client.post(f"/classes/{class_id}/archive", headers=headers)

    codes = (await session.exec(select(ClassJoinCode))).all()
    assert all(code.revoked_at is not None for code in codes)
    # An already-revoked code keeps its original timestamp rather than being re-stamped.
    old = next(code for code in codes if code.code == "OLDONE")
    assert old.revoked_at == already_revoked_at


async def test_archiving_leaves_enrolments_alone(client, signed_in, session: AsyncSession) -> None:
    """Enrolments are the term's history that Phase 8 mastery reads."""
    headers = await signed_in()
    created = (
        await client.post("/classes", json={"name": "Year 4-6 Python"}, headers=headers)
    ).json()
    class_id = uuid.UUID(created["id"])

    teacher = (await session.exec(select(User))).one()
    student = Student(centre_id=teacher.centre_id, display_name="Aria K", username="aria.k")
    session.add(student)
    await session.flush()
    session.add(Enrolment(class_id=class_id, student_id=student.id))
    await session.flush()

    await client.post(f"/classes/{class_id}/archive", headers=headers)

    enrolment = (await session.exec(select(Enrolment))).one()
    assert enrolment.status == "active"
    assert enrolment.withdrawn_at is None


async def test_unarchive_restores_the_class(client, signed_in) -> None:
    headers = await signed_in()
    created = (await client.post("/classes", json={"name": "Back again"}, headers=headers)).json()

    await client.post(f"/classes/{created['id']}/archive", headers=headers)
    restored = await client.post(f"/classes/{created['id']}/unarchive", headers=headers)

    assert restored.json()["status"] == "active"
    assert len((await client.get("/classes", headers=headers)).json()) == 1


# --- centre ------------------------------------------------------------------------


async def test_read_centre(client, signed_in) -> None:
    headers = await signed_in()
    response = await client.get("/centre", headers=headers)
    assert response.status_code == 200
    assert response.json()["slug"] == "castle-hill"
    assert response.json()["name"] == "Magikid Castle Hill"


# --- authentication ----------------------------------------------------------------


async def test_every_route_requires_a_signed_in_teacher(client) -> None:
    class_id = uuid.uuid4()
    calls = [
        ("get", "/centre", None),
        ("get", "/classes", None),
        ("post", "/classes", {"name": "x"}),
        ("get", f"/classes/{class_id}", None),
        ("patch", f"/classes/{class_id}", {"name": "x"}),
        ("post", f"/classes/{class_id}/archive", None),
        ("post", f"/classes/{class_id}/unarchive", None),
    ]
    for method, path, payload in calls:
        response = await client.request(method, path, json=payload)
        assert response.status_code == 401, f"{method} {path}"


async def test_a_student_cookie_does_not_reach_class_routes(client) -> None:
    client.cookies.set("student_session", "anything")
    assert (await client.get("/classes")).status_code == 401


async def test_an_unprovisioned_teacher_is_refused(client, make_token) -> None:
    """A valid token with no users row cannot list classes."""
    headers = {"Authorization": f"Bearer {make_token(email='new@example.com')}"}
    response = await client.get("/classes", headers=headers)
    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "profile_not_provisioned"


# --- audit -------------------------------------------------------------------------


async def test_mutations_are_audited(client, signed_in, session: AsyncSession) -> None:
    headers = await signed_in()
    created = (
        await client.post("/classes", json={"name": "Year 4-6 Python"}, headers=headers)
    ).json()
    await client.patch(f"/classes/{created['id']}", json={"name": "Renamed"}, headers=headers)
    await client.post(f"/classes/{created['id']}/archive", headers=headers)
    await client.post(f"/classes/{created['id']}/unarchive", headers=headers)

    actions = [
        entry.action
        for entry in (
            await session.exec(select(AuditLog).where(AuditLog.target_type == "class"))
        ).all()
    ]
    assert sorted(actions) == [
        "class.archived",
        "class.created",
        "class.renamed",
        "class.unarchived",
    ]


async def test_a_no_op_patch_writes_no_audit_row(client, signed_in, session: AsyncSession) -> None:
    headers = await signed_in()
    created = (
        await client.post("/classes", json={"name": "Year 4-6 Python"}, headers=headers)
    ).json()

    await client.patch(f"/classes/{created['id']}", json={}, headers=headers)

    renames = (await session.exec(select(AuditLog).where(AuditLog.action == "class.renamed"))).all()
    assert renames == []


async def test_the_archive_audit_records_how_many_codes_it_revoked(
    client, signed_in, session: AsyncSession
) -> None:
    headers = await signed_in()
    created = (
        await client.post("/classes", json={"name": "Year 4-6 Python"}, headers=headers)
    ).json()
    teacher = (await session.exec(select(User))).one()
    # Two live codes: the one create_class minted, plus a hand-written second so the
    # count is proving a count rather than a constant.
    session.add(
        ClassJoinCode(class_id=uuid.UUID(created["id"]), code="HMTKQR", created_by=teacher.id)
    )
    await session.flush()

    await client.post(f"/classes/{created['id']}/archive", headers=headers)

    entry = (await session.exec(select(AuditLog).where(AuditLog.action == "class.archived"))).one()
    assert entry.payload["join_codes_revoked"] == 2


async def test_classes_are_scoped_by_the_principals_centre(
    client, signed_in, session: AsyncSession
) -> None:
    headers = await signed_in()
    await client.post("/classes", json={"name": "Year 4-6 Python"}, headers=headers)

    teacher = (await session.exec(select(User))).one()
    record = (await session.exec(select(Class))).one()
    assert record.centre_id == teacher.centre_id
