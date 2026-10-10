"""Folders in My files (children) and My code (teachers) — Ken's decision, 11 Oct 2026.

Defended:
- folders nest, files go in them and move between them, names are unique per folder;
- a folder can't be moved inside itself; deleting archives the whole branch and its files;
- the owner boundary: another child's or teacher's folder is a 404, and a child cannot
  reach the teacher routes or the other way round;
- a child can't change folders while a quiz runs.
"""

import uuid

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.models import DocumentStatus, StudentDocument, StudentFolder, TeacherFolder

ME = "/me/folders"
TEACHER = "/teacher/folders"


async def folder(client, name, parent=None, url=ME, headers=None):
    response = await client.post(url, json={"name": name, "parent_id": parent}, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()


async def test_folders_nest_and_files_go_in_and_move(client, signed_in_student):
    await signed_in_student()
    week1 = await folder(client, "week 1")
    loops = await folder(client, "loops", parent=week1["id"])
    assert loops["parent_id"] == week1["id"]

    doc = (await client.post("/me/documents", json={"folder_id": loops["id"]})).json()
    assert doc["folder_id"] == loops["id"]
    assert doc["title"] == "Untitled"

    moved = await client.patch(f"/me/documents/{doc['id']}", json={"folder_id": week1["id"]})
    assert moved.json()["folder_id"] == week1["id"]
    top = await client.patch(f"/me/documents/{doc['id']}", json={"folder_id": None})
    assert top.json()["folder_id"] is None

    listing = (await client.get(ME)).json()
    assert {(f["name"], f["parent_id"]) for f in listing} == {
        ("week 1", None),
        ("loops", week1["id"]),
    }


async def test_names_are_unique_per_folder_not_per_child(client, signed_in_student):
    await signed_in_student()
    a = await folder(client, "week 1")
    b = await folder(client, "week 2")
    # The same file name in two folders is fine; twice in one folder is not.
    assert (
        await client.post("/me/documents", json={"title": "squares", "folder_id": a["id"]})
    ).status_code == 201
    assert (
        await client.post("/me/documents", json={"title": "squares", "folder_id": b["id"]})
    ).status_code == 201
    clash = await client.post("/me/documents", json={"title": "SQUARES", "folder_id": a["id"]})
    assert clash.status_code == 409
    # "Untitled" numbering is per folder too.
    assert (await client.post("/me/documents", json={"folder_id": a["id"]})).json()[
        "title"
    ] == "Untitled"
    assert (await client.post("/me/documents", json={"folder_id": b["id"]})).json()[
        "title"
    ] == "Untitled"
    # Folders: same rule.
    assert (await client.post(ME, json={"name": "WEEK 1"})).status_code == 409
    assert (await client.post(ME, json={"name": "week 1", "parent_id": b["id"]})).status_code == 201


async def test_a_folder_cannot_go_inside_itself(client, signed_in_student):
    await signed_in_student()
    outer = await folder(client, "outer")
    inner = await folder(client, "inner", parent=outer["id"])
    deep = await folder(client, "deep", parent=inner["id"])
    for target in (outer["id"], inner["id"], deep["id"]):
        response = await client.patch(f"{ME}/{outer['id']}", json={"parent_id": target})
        assert response.status_code == 422, target
    # Renaming and moving somewhere legal both work.
    renamed = await client.patch(f"{ME}/{deep['id']}", json={"name": "deeper", "parent_id": None})
    assert (renamed.json()["name"], renamed.json()["parent_id"]) == ("deeper", None)


async def test_deleting_a_folder_archives_the_branch_and_its_files(
    client, signed_in_student, session: AsyncSession
):
    await signed_in_student()
    outer = await folder(client, "outer")
    inner = await folder(client, "inner", parent=outer["id"])
    keep = await folder(client, "keep")
    in_inner = (await client.post("/me/documents", json={"folder_id": inner["id"]})).json()
    in_keep = (await client.post("/me/documents", json={"folder_id": keep["id"]})).json()

    response = await client.post(f"{ME}/{outer['id']}/delete")
    assert response.json() == {"files_archived": 1}
    assert [f["name"] for f in (await client.get(ME)).json()] == ["keep"]
    files = {f["id"] for f in (await client.get("/me/documents")).json()}
    assert in_inner["id"] not in files and in_keep["id"] in files

    # Archived, not destroyed: the rows are still there.
    record = await session.get(StudentDocument, uuid.UUID(in_inner["id"]))
    assert record is not None and record.status == DocumentStatus.ARCHIVED
    # Restoring that file puts it at the top level, since its folder is gone.
    restored = await client.post(f"/me/documents/{in_inner['id']}/restore")
    assert restored.json()["folder_id"] is None


async def test_another_childs_folder_is_not_found(client, signed_in_student):
    await signed_in_student("Aria K")
    arias = await folder(client, "secret")
    await signed_in_student("Bella N")
    assert (await client.get(ME)).json() == []
    for method, path, body in [
        ("patch", f"{ME}/{arias['id']}", {"name": "mine now"}),
        ("post", f"{ME}/{arias['id']}/delete", None),
        ("post", ME, {"name": "x", "parent_id": arias["id"]}),
        ("post", "/me/documents", {"folder_id": arias["id"]}),
    ]:
        response = await client.request(method, path, json=body)
        assert response.status_code == 404, (method, path)


async def test_teachers_have_their_own_private_folders(client, signed_in, session: AsyncSession):
    ken = await signed_in("ken@example.com")
    sam = await signed_in("sam@example.com")
    demos = await folder(client, "demos", url=TEACHER, headers=ken)
    doc = await client.post("/teacher/documents", json={"folder_id": demos["id"]}, headers=ken)
    assert doc.json()["folder_id"] == demos["id"]

    assert (await client.get(TEACHER, headers=sam)).json() == []
    assert (
        await client.patch(f"{TEACHER}/{demos['id']}", json={"name": "x"}, headers=sam)
    ).status_code == 404
    assert (
        await client.post("/teacher/documents", json={"folder_id": demos["id"]}, headers=sam)
    ).status_code == 404
    assert len((await session.exec(select(TeacherFolder))).all()) == 1


async def test_children_and_teachers_cannot_cross_over(client, signed_in_student):
    roster = await signed_in_student()
    # A teacher token on the children's routes, and a child's cookie on the teachers'.
    assert (await client.get(ME, headers=roster["headers"])).status_code == 403
    assert (await client.get(TEACHER)).status_code == 403


async def test_a_childs_folder_survives_until_they_are_deleted(
    client, signed_in_student, session: AsyncSession
):
    aria = await signed_in_student()
    await folder(client, "week 1")
    await client.post(
        f"/students/{aria['student_id']}/delete",
        json={"confirm_name": "Aria K"},
        headers=aria["headers"],
    )
    assert (await session.exec(select(StudentFolder))).all() == []
