"""A child's files, read by a teacher in the Files app (16 Oct 2026).

Read-only, and the tenancy cases carry the weight: another centre's child is a 404, a file
id belonging to a different child is a 404 under this child's path, and a student cannot
use these routes at all.
"""

import uuid

from sqlmodel.ext.asyncio.session import AsyncSession

from app.models import Student, StudentDocument, StudentFolder


async def a_childs_work(session: AsyncSession, student: dict) -> dict:
    """A folder with a file in it, plus a loose file, written directly."""
    child = await session.get(Student, uuid.UUID(student["student_id"]))
    folder = StudentFolder(centre_id=child.centre_id, student_id=child.id, name="Lesson 6")
    session.add(folder)
    await session.flush()
    inside = StudentDocument(
        centre_id=child.centre_id,
        student_id=child.id,
        folder_id=folder.id,
        title="stars.py",
        content='print("*")\n',
    )
    loose = StudentDocument(centre_id=child.centre_id, student_id=child.id, title="notes.txt")
    session.add_all([inside, loose])
    await session.flush()
    return {"folder": folder, "inside": inside, "loose": loose}


async def test_a_teacher_sees_a_childs_folders_and_files(
    client, student_on_roster, session: AsyncSession
) -> None:
    aria = await student_on_roster()
    work = await a_childs_work(session, aria)
    base = f"/students/{aria['student_id']}"

    folders = (await client.get(f"{base}/folders", headers=aria["headers"])).json()
    assert [f["name"] for f in folders] == ["Lesson 6"]
    files = (await client.get(f"{base}/documents", headers=aria["headers"])).json()
    assert {f["title"] for f in files} == {"stars.py", "notes.txt"}
    assert all("content" not in f for f in files)

    one = await client.get(f"{base}/documents/{work['inside'].id}", headers=aria["headers"])
    assert one.status_code == 200
    assert one.json()["content"] == 'print("*")\n'
    assert one.json()["folder_id"] == str(work["folder"].id)


async def test_another_teacher_at_the_centre_may_look(
    client, student_on_roster, signed_in, session: AsyncSession
) -> None:
    aria = await student_on_roster()
    await a_childs_work(session, aria)
    other = await signed_in("mia@example.com")
    response = await client.get(f"/students/{aria['student_id']}/documents", headers=other)
    assert response.status_code == 200 and len(response.json()) == 2


async def test_another_centres_child_is_404(client, signed_in, foreign_centre) -> None:
    headers = await signed_in()
    base = f"/students/{foreign_centre['student'].id}"
    assert (await client.get(f"{base}/folders", headers=headers)).status_code == 404
    assert (await client.get(f"{base}/documents", headers=headers)).status_code == 404


async def test_a_file_under_the_wrong_childs_path_is_404(
    client, student_on_roster, session: AsyncSession
) -> None:
    aria = await student_on_roster("Aria K")
    ben = await student_on_roster("Ben T", class_name="Year 2-3")
    work = await a_childs_work(session, aria)
    response = await client.get(
        f"/students/{ben['student_id']}/documents/{work['inside'].id}", headers=aria["headers"]
    )
    assert response.status_code == 404


async def test_archived_files_and_folders_are_left_out(
    client, student_on_roster, session: AsyncSession
) -> None:
    aria = await student_on_roster()
    work = await a_childs_work(session, aria)
    work["loose"].status = "archived"
    work["folder"].status = "archived"
    session.add_all([work["loose"], work["folder"]])
    await session.flush()
    base = f"/students/{aria['student_id']}"
    assert (await client.get(f"{base}/folders", headers=aria["headers"])).json() == []
    titles = [
        f["title"] for f in (await client.get(f"{base}/documents", headers=aria["headers"])).json()
    ]
    assert titles == ["stars.py"]


async def test_a_student_cannot_use_these_routes(client, signed_in_student) -> None:
    aria = await signed_in_student()
    response = await client.get(f"/students/{aria['student_id']}/documents")
    assert response.status_code in (401, 403)


async def test_without_credentials_it_is_401(client, student_on_roster) -> None:
    aria = await student_on_roster()
    response = await client.get(f"/students/{aria['student_id']}/documents")
    assert response.status_code == 401
