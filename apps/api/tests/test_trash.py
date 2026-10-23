"""The Trash (`app/trash.py`, Ken's decision, 23 Oct 2026).

The authorisation tests matter most, as everywhere: who may see, restore and delete for
good, and that another centre's Trash is not there at all. Then the behaviour: a trashed
thing is gone from every ordinary page, comes back as it was, and is erased by the 30-day
clock.
"""

import uuid
from datetime import timedelta

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.models import Class, Student, StudentDocument
from app.models.base import utcnow
from app.trash import TRASH_DAYS, purge_expired
from work_builders import homework, today

# --- a child's files ----------------------------------------------------------------------


async def test_a_child_deletes_a_file_and_gets_it_back(client, signed_in_student) -> None:
    await signed_in_student()
    made = (await client.post("/me/documents", json={"title": "game.py"})).json()

    assert (await client.post(f"/me/documents/{made['id']}/archive")).status_code == 200
    assert made["id"] not in [d["id"] for d in (await client.get("/me/documents")).json()]
    trash = (await client.get("/me/trash")).json()
    assert [(t["kind"], t["name"], t["can_purge"]) for t in trash] == [("file", "game.py", False)]

    assert (await client.post(f"/me/trash/file/{made['id']}/restore")).status_code == 204
    assert made["id"] in [d["id"] for d in (await client.get("/me/documents")).json()]
    assert (await client.get("/me/trash")).json() == []


async def test_a_folder_goes_with_everything_in_it_and_comes_back_together(
    client, signed_in_student
) -> None:
    await signed_in_student()
    folder = (await client.post("/me/folders", json={"name": "games"})).json()
    inner = (
        await client.post("/me/folders", json={"name": "old", "parent_id": folder["id"]})
    ).json()
    file = (
        await client.post("/me/documents", json={"title": "a.py", "folder_id": inner["id"]})
    ).json()

    await client.post(f"/me/folders/{folder['id']}/delete")
    trash = (await client.get("/me/trash")).json()
    assert [(t["kind"], t["name"]) for t in trash] == [("folder", "games")], "only the top shows"

    await client.post(f"/me/trash/folder/{folder['id']}/restore")
    files = (await client.get("/me/documents")).json()
    assert [(f["id"], f["folder_id"]) for f in files] == [(file["id"], inner["id"])]


async def test_a_child_cannot_delete_for_good_or_see_the_teachers_trash(
    client, signed_in_student
) -> None:
    await signed_in_student()
    made = (await client.post("/me/documents", json={"title": "keep.py"})).json()
    await client.post(f"/me/documents/{made['id']}/archive")
    assert (await client.get("/trash")).status_code == 403
    purge = await client.post(f"/trash/file/{made['id']}/purge", json={})
    assert purge.status_code == 403
    assert (await client.post(f"/me/trash/class/{uuid.uuid4()}/restore")).status_code == 422


async def test_a_child_cannot_restore_another_childs_file(
    client, session: AsyncSession, signed_in_student
) -> None:
    await signed_in_student("Aria K")
    arias = (await client.post("/me/documents", json={"title": "aria.py"})).json()
    await client.post(f"/me/documents/{arias['id']}/archive")
    await signed_in_student("Bella N")
    assert (await client.post(f"/me/trash/file/{arias['id']}/restore")).status_code == 404
    assert (await client.get("/me/trash")).json() == []


# --- classes and children ---------------------------------------------------------------


async def test_a_trashed_class_is_gone_everywhere_until_restored(client, signed_in_student) -> None:
    aria = await signed_in_student()
    headers, class_id = aria["headers"], aria["class_id"]

    assert (await client.post(f"/trash/class/{class_id}", headers=headers)).status_code == 204
    every = (await client.get("/classes?include_archived=true", headers=headers)).json()
    assert class_id not in [c["id"] for c in every], "not even among removed classes"
    assert (await client.get(f"/classes/{class_id}", headers=headers)).status_code == 404
    assert (await client.get("/auth/student/me")).status_code == 401, "its children signed out"

    await client.post(f"/trash/class/{class_id}/restore", headers=headers)
    assert (await client.get(f"/classes/{class_id}", headers=headers)).json()["status"] == "active"


async def test_only_the_owner_deletes_a_class_for_good_and_types_its_name(
    client, signed_in, signed_in_student, session: AsyncSession
) -> None:
    aria = await signed_in_student()
    owner, class_id = aria["headers"], aria["class_id"]
    sam = await signed_in("sam@example.com")  # a teacher, not the owner
    await client.post(f"/trash/class/{class_id}", headers=sam)

    assert (
        await client.post(f"/trash/class/{class_id}/purge", json={}, headers=sam)
    ).status_code == 403
    wrong = await client.post(
        f"/trash/class/{class_id}/purge", json={"confirm_name": "nope"}, headers=owner
    )
    assert wrong.status_code == 422
    right = await client.post(
        f"/trash/class/{class_id}/purge",
        json={"confirm_name": "year 4-6 python"},
        headers=owner,
    )
    assert right.status_code == 204, right.text
    assert await session.get(Class, uuid.UUID(class_id)) is None


async def test_a_trashed_child_cannot_sign_in_and_leaves_the_roster(
    client, student_on_roster, session: AsyncSession
) -> None:
    roster = await student_on_roster()
    headers = roster["headers"]
    await client.post(f"/trash/student/{roster['student_id']}", headers=headers)

    signin = await client.post(
        "/auth/student/session", json={"username": roster["username"], "pin": roster["pin"]}
    )
    assert signin.status_code in (401, 403)
    on_roster = (await client.get(f"/classes/{roster['class_id']}/roster", headers=headers)).json()
    assert on_roster == []

    await client.post(f"/trash/student/{roster['student_id']}/restore", headers=headers)
    student = await session.get(Student, uuid.UUID(roster["student_id"]))
    await session.refresh(student)
    assert student.status == "active"


async def test_another_centres_things_are_not_in_reach(client, signed_in, foreign_centre) -> None:
    headers = await signed_in()
    for kind, row in [("class", foreign_centre["class"]), ("student", foreign_centre["student"])]:
        for path in [f"/trash/{kind}/{row.id}", f"/trash/{kind}/{row.id}/restore"]:
            assert (await client.post(path, headers=headers)).status_code == 404, path
        purge = await client.post(
            f"/trash/{kind}/{row.id}/purge",
            json={"confirm_name": row.name if kind == "class" else row.display_name},
            headers=headers,
        )
        assert purge.status_code == 404


# --- problems, homework, curriculum --------------------------------------------------------


async def test_a_problem_still_in_use_cannot_be_trashed(
    client, session: AsyncSession, signed_in_student
) -> None:
    aria = await signed_in_student()
    work = await homework(client, session, aria)
    item = work["items"][0]["id"]
    refused = await client.post(f"/trash/problem/{item}", headers=aria["headers"])
    assert refused.status_code == 409
    assert "Lists practice" in refused.json()["detail"]

    # Once the homework is in the Trash, the problem can follow it.
    await client.post(f"/trash/homework/{work['assignment']['id']}", headers=aria["headers"])
    assert (await client.post(f"/trash/problem/{item}", headers=aria["headers"])).status_code == 204


async def test_trashed_homework_disappears_for_children_and_teachers(
    client, session: AsyncSession, signed_in_student
) -> None:
    aria = await signed_in_student()
    work = await homework(client, session, aria)
    hw = work["assignment"]["id"]
    await client.post(f"/trash/homework/{hw}", headers=aria["headers"])

    listed = (
        await client.get(f"/classes/{aria['class_id']}/homework", headers=aria["headers"])
    ).json()
    assert hw not in [h["id"] for h in listed]
    assert (await client.get(f"/me/homework/{hw}")).status_code == 404
    entry = (await client.get("/trash", headers=aria["headers"])).json()[0]
    assert (entry["kind"], entry["detail"], entry["can_purge"]) == (
        "homework",
        "Homework · Year 4-6 Python",
        True,
    )
    purged = await client.post(f"/trash/homework/{hw}/purge", json={}, headers=aria["headers"])
    assert purged.status_code == 204


async def test_a_unit_takes_its_lessons_and_a_class_forgets_todays_lesson(
    client, session: AsyncSession, signed_in_student
) -> None:
    aria = await signed_in_student()
    tree = await today(client, session, aria)
    unit_id = (
        await client.get(f"/courses/{tree['course']['id']}", headers=aria["headers"])
    ).json()["units"][0]["id"]
    await client.post(f"/trash/unit/{unit_id}", headers=aria["headers"])

    klass = (await client.get(f"/classes/{aria['class_id']}", headers=aria["headers"])).json()
    assert klass["current_lesson_id"] is None
    trash = (await client.get("/trash", headers=aria["headers"])).json()
    assert [t["kind"] for t in trash] == ["unit"], "its lesson goes with it, unlisted"
    lesson = await client.post(
        f"/trash/lesson/{tree['lesson']['id']}/restore", headers=aria["headers"]
    )
    assert lesson.status_code == 409, "restore the unit, not the lesson on its own"


# --- the 30-day clock ------------------------------------------------------------------------


async def test_the_clock_deletes_what_has_been_in_the_trash_long_enough(
    client, session: AsyncSession, signed_in_student
) -> None:
    await signed_in_student()
    old = (await client.post("/me/documents", json={"title": "old.py"})).json()
    new = (await client.post("/me/documents", json={"title": "new.py"})).json()
    for made in (old, new):
        await client.post(f"/me/documents/{made['id']}/archive")
    record = await session.get(StudentDocument, uuid.UUID(old["id"]))
    record.deleted_at = utcnow() - timedelta(days=TRASH_DAYS + 1)
    session.add(record)
    await session.flush()

    assert await purge_expired(session) == 1
    left = (await session.exec(select(StudentDocument.title))).all()
    assert list(left) == ["new.py"]
