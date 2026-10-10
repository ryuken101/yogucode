"""A teacher's own files — "My code" (Ken's decisions, 10 Oct 2026).

The files are private to the teacher: another teacher at the same centre gets a 404 and
never sees them listed, another centre gets a 404, a student gets 403. Otherwise they
behave like a child's files: starter content, "Untitled n", one live file per name.
"""

import uuid

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.models import TeacherDocument, User
from app.routers.documents import MAX_CONTENT_BYTES, STARTER_CONTENT

URL = "/teacher/documents"


async def test_a_new_file_has_starter_code_and_a_default_name(client, signed_in):
    ken = await signed_in("ken@example.com")
    first = (await client.post(URL, json={}, headers=ken)).json()
    second = (await client.post(URL, json={}, headers=ken)).json()
    assert first["title"] == "Untitled"
    assert second["title"] == "Untitled 2"
    assert first["content"] == STARTER_CONTENT


async def test_save_rename_list_archive_and_restore(client, signed_in):
    ken = await signed_in("ken@example.com")
    doc = (await client.post(URL, json={"title": "squares"}, headers=ken)).json()

    saved = await client.patch(
        f"{URL}/{doc['id']}", json={"content": "print(2 * 2)\n"}, headers=ken
    )
    assert saved.json()["content"] == "print(2 * 2)\n"
    renamed = await client.patch(f"{URL}/{doc['id']}", json={"title": "Demo"}, headers=ken)
    assert renamed.json()["title"] == "Demo"
    assert (await client.get(f"{URL}/{doc['id']}", headers=ken)).json()["content"] == (
        "print(2 * 2)\n"
    )

    assert [d["title"] for d in (await client.get(URL, headers=ken)).json()] == ["Demo"]
    await client.post(f"{URL}/{doc['id']}/archive", headers=ken)
    assert (await client.get(URL, headers=ken)).json() == []
    restored = await client.post(f"{URL}/{doc['id']}/restore", headers=ken)
    assert restored.json()["status"] == "active"


async def test_two_live_files_cannot_share_a_name(client, signed_in):
    ken = await signed_in("ken@example.com")
    await client.post(URL, json={"title": "demo"}, headers=ken)
    clash = await client.post(URL, json={"title": "DEMO"}, headers=ken)
    assert clash.status_code == 409


async def test_content_is_capped(client, signed_in):
    ken = await signed_in("ken@example.com")
    doc = (await client.post(URL, json={}, headers=ken)).json()
    too_big = await client.patch(
        f"{URL}/{doc['id']}", json={"content": "x" * (MAX_CONTENT_BYTES + 1)}, headers=ken
    )
    assert too_big.status_code == 422


# --- privacy: the tests that matter most ---------------------------------------------------


async def test_another_teacher_at_the_centre_cannot_see_or_touch_my_files(client, signed_in):
    ken = await signed_in("ken@example.com")
    sam = await signed_in("sam@example.com")
    mine = (await client.post(URL, json={"title": "Ken's demo"}, headers=ken)).json()

    assert (await client.get(URL, headers=sam)).json() == []
    for method, path, body in [
        ("get", f"{URL}/{mine['id']}", None),
        ("patch", f"{URL}/{mine['id']}", {"content": "hacked"}),
        ("post", f"{URL}/{mine['id']}/archive", None),
        ("post", f"{URL}/{mine['id']}/restore", None),
    ]:
        kwargs = {"headers": sam} | ({"json": body} if body else {})
        response = await getattr(client, method)(path, **kwargs)
        assert response.status_code == 404, (method, path)

    assert (await client.get(f"{URL}/{mine['id']}", headers=ken)).json()["content"] != "hacked"


async def test_another_centres_teacher_file_is_not_found(
    client, signed_in, foreign_centre, session: AsyncSession
):
    ken = await signed_in("ken@example.com")
    outsider = User(
        supabase_user_id=uuid.uuid4(),
        centre_id=foreign_centre["centre"].id,
        email="other@elsewhere.test",
        display_name="Other",
    )
    session.add(outsider)
    await session.flush()
    theirs = TeacherDocument(
        centre_id=foreign_centre["centre"].id, user_id=outsider.id, title="theirs"
    )
    session.add(theirs)
    await session.flush()

    assert (await client.get(f"{URL}/{theirs.id}", headers=ken)).status_code == 404
    assert "theirs" not in str((await client.get(URL, headers=ken)).json())


async def test_a_student_gets_403(client, signed_in_student):
    await signed_in_student()
    assert (await client.get(URL)).status_code == 403
    assert (await client.post(URL, json={})).status_code == 403


async def test_a_new_file_belongs_to_the_teacher_who_made_it(
    client, signed_in, session: AsyncSession
):
    ken = await signed_in("ken@example.com")
    ken_id = (await client.get("/auth/me", headers=ken)).json()["id"]
    await client.post(URL, json={}, headers=ken)
    record = (await session.exec(select(TeacherDocument))).one()
    assert str(record.user_id) == ken_id
