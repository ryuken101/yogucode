"""A child's files, for a teacher in the Files app (16 Oct 2026; organising, 17 Oct).

The tenancy cases carry the weight: another centre's child is a 404, a file or folder id
belonging to a different child is a 404 under this child's path, and a student cannot use
these routes at all. The writes are audited, and none of them can change what a file says.
"""

import uuid

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.models import AuditLog, DocumentStatus, Student, StudentDocument, StudentFolder


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


# --- organising a child's files (17 Oct 2026) -------------------------------------------


async def test_a_teacher_organises_a_childs_files_and_each_change_is_audited(
    client, student_on_roster, session: AsyncSession
) -> None:
    aria = await student_on_roster()
    work = await a_childs_work(session, aria)
    base, headers = f"/students/{aria['student_id']}", aria["headers"]

    made = await client.post(f"{base}/folders", json={"name": "Week 2"}, headers=headers)
    assert made.status_code == 201
    week2 = made.json()["id"]
    copied = await client.post(
        f"{base}/documents",
        json={"title": "handout.py", "content": "print(1)\n", "folder_id": week2},
        headers=headers,
    )
    assert copied.status_code == 201 and copied.json()["content"] == "print(1)\n"

    moved = await client.patch(
        f"{base}/documents/{work['loose'].id}",
        json={"title": "ideas.txt", "folder_id": week2},
        headers=headers,
    )
    assert moved.json()["title"] == "ideas.txt" and moved.json()["folder_id"] == week2
    renamed = await client.patch(
        f"{base}/folders/{work['folder'].id}", json={"name": "Lesson six"}, headers=headers
    )
    assert renamed.json()["name"] == "Lesson six"
    gone = await client.post(f"{base}/documents/{work['inside'].id}/archive", headers=headers)
    assert gone.json()["status"] == "archived"
    deleted = await client.post(f"{base}/folders/{week2}/delete", headers=headers)
    assert deleted.json() == {"files_archived": 2}

    rows = (
        await session.exec(select(AuditLog).where(AuditLog.target_id == work["folder"].student_id))
    ).all()
    assert sorted(r.action for r in rows if r.action.startswith("student_file.")) == sorted(
        [
            "student_file.folder_created",
            "student_file.created",
            "student_file.changed",
            "student_file.folder_changed",
            "student_file.deleted",
            "student_file.folder_deleted",
        ]
    )


async def test_a_teacher_cannot_change_what_a_childs_file_says(
    client, student_on_roster, session: AsyncSession
) -> None:
    aria = await student_on_roster()
    work = await a_childs_work(session, aria)
    response = await client.patch(
        f"/students/{aria['student_id']}/documents/{work['inside'].id}",
        json={"content": "print('teacher')"},
        headers=aria["headers"],
    )
    assert response.status_code == 200
    await session.refresh(work["inside"])
    assert work["inside"].content == 'print("*")\n'


async def test_the_childs_own_rules_apply(client, student_on_roster, session: AsyncSession) -> None:
    aria = await student_on_roster("Aria K")
    ben = await student_on_roster("Ben T", class_name="Year 2-3")
    arias = await a_childs_work(session, aria)
    bens = await a_childs_work(session, ben)
    base, headers = f"/students/{aria['student_id']}", aria["headers"]

    into_bens = await client.patch(
        f"{base}/documents/{arias['loose'].id}",
        json={"folder_id": str(bens["folder"].id)},
        headers=headers,
    )
    assert into_bens.status_code == 404, "another child's folder is not a place in Aria's files"
    bens_file = await client.post(f"{base}/documents/{bens['inside'].id}/archive", headers=headers)
    assert bens_file.status_code == 404
    await session.refresh(bens["inside"])
    assert bens["inside"].status == DocumentStatus.ACTIVE
    # Last: a refused insert rolls the test's session back.
    clash = await client.post(f"{base}/documents", json={"title": "notes.txt"}, headers=headers)
    assert clash.status_code == 409


async def test_writes_are_refused_outside_the_centre_and_to_students(
    client, signed_in, foreign_centre, signed_in_student
) -> None:
    headers = await signed_in()
    base = f"/students/{foreign_centre['student'].id}"
    assert (
        await client.post(f"{base}/folders", json={"name": "x"}, headers=headers)
    ).status_code == 404
    assert (await client.post(f"{base}/documents", json={}, headers=headers)).status_code == 404

    aria = await signed_in_student()
    mine = f"/students/{aria['student_id']}"
    assert (await client.post(f"{mine}/folders", json={"name": "x"})).status_code == 403
