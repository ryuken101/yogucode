"""The problem bank's folders. Authorisation first, as everywhere: another centre's folders
aren't there, and a child can't reach them. Then what makes them folders rather than a
filter: a problem in several, and staying in them across new versions and the Trash.
"""

import uuid
from datetime import timedelta

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.models import Concept, Item, ProblemFolder, ProblemFolderItem
from app.models.base import utcnow
from app.trash import TRASH_DAYS, purge_expired
from work_builders import problem_doc, published


async def a_problem(client, session: AsyncSession, headers, title: str = "Add to the end") -> dict:
    concept = Concept(key=f"f-{uuid.uuid4().hex[:6]}", label="Lists")
    session.add(concept)
    await session.flush()
    return await published(client, headers, problem_doc(str(concept.id), title=title))


async def a_folder(client, headers, name: str = "Term 4 quizzes") -> dict:
    made = await client.post("/problem-folders", json={"name": name}, headers=headers)
    assert made.status_code == 201, made.text
    return made.json()


async def folders_of(client, headers, item_id: str) -> list[str]:
    rows = (await client.get("/items", headers=headers)).json()
    return next(r["folder_ids"] for r in rows if r["id"] == item_id)


# --- authorisation --------------------------------------------------------------------------


async def test_another_centres_folder_is_not_there(
    client, session: AsyncSession, signed_in, foreign_centre
) -> None:
    headers = await signed_in()
    mine = await a_problem(client, session, headers)
    theirs = ProblemFolder(centre_id=foreign_centre["centre"].id, name="Theirs")
    session.add(theirs)
    await session.flush()

    assert (await client.get("/problem-folders", headers=headers)).json() == []
    for method, path, body in [
        ("patch", f"/problem-folders/{theirs.id}", {"name": "Mine now"}),
        ("post", f"/problem-folders/{theirs.id}/items", {"item_ids": [mine["id"]]}),
        ("delete", f"/problem-folders/{theirs.id}/items/{mine['id']}", None),
        ("post", f"/trash/problem_folder/{theirs.id}", None),
    ]:
        response = await client.request(method, path, json=body, headers=headers)
        assert response.status_code == 404, path
    assert (await session.exec(select(ProblemFolderItem))).all() == []


async def test_another_centres_problem_cannot_go_in_my_folder(
    client, session: AsyncSession, signed_in, foreign_centre
) -> None:
    headers = await signed_in()
    folder = await a_folder(client, headers)
    theirs = Item(centre_id=foreign_centre["centre"].id, title="Theirs")
    session.add(theirs)
    await session.flush()

    added = await client.post(
        f"/problem-folders/{folder['id']}/items",
        json={"item_ids": [str(theirs.id)]},
        headers=headers,
    )
    assert added.status_code == 404
    assert (await session.exec(select(ProblemFolderItem))).all() == []


async def test_a_child_cannot_reach_folders(client, signed_in_student) -> None:
    await signed_in_student()
    assert (await client.get("/problem-folders")).status_code == 403
    assert (await client.post("/problem-folders", json={"name": "Mine"})).status_code == 403


# --- names ----------------------------------------------------------------------------------


async def test_a_name_is_taken_ignoring_case_until_the_folder_is_in_the_trash(
    client, signed_in
) -> None:
    headers = await signed_in()
    folder = await a_folder(client, headers, "Revision")
    again = await client.post("/problem-folders", json={"name": "  REVISION "}, headers=headers)
    assert again.status_code == 409

    other = await a_folder(client, headers, "Extension")
    renamed = await client.patch(
        f"/problem-folders/{other['id']}", json={"name": "revision"}, headers=headers
    )
    assert renamed.status_code == 409

    assert (
        await client.post(f"/trash/problem_folder/{folder['id']}", headers=headers)
    ).status_code == 204
    await a_folder(client, headers, "Revision")
    # Its name has gone to someone else, so restoring it says so instead of failing oddly.
    restored = await client.post(f"/trash/problem_folder/{folder['id']}/restore", headers=headers)
    assert restored.status_code == 409


async def test_a_blank_name_is_refused_and_spaces_are_tidied(client, signed_in) -> None:
    headers = await signed_in()
    blank = await client.post("/problem-folders", json={"name": "   "}, headers=headers)
    assert blank.status_code == 422
    assert (await a_folder(client, headers, "  Term   4 "))["name"] == "Term 4"


# --- what is in them ------------------------------------------------------------------------


async def test_a_problem_can_be_in_several_and_adding_twice_is_harmless(
    client, session: AsyncSession, signed_in
) -> None:
    headers = await signed_in()
    problem = await a_problem(client, session, headers)
    one, two = await a_folder(client, headers, "One"), await a_folder(client, headers, "Two")
    for folder in (one, one, two):
        added = await client.post(
            f"/problem-folders/{folder['id']}/items",
            json={"item_ids": [problem["id"]]},
            headers=headers,
        )
        assert added.status_code == 204
    assert set(await folders_of(client, headers, problem["id"])) == {one["id"], two["id"]}

    removed = await client.delete(
        f"/problem-folders/{one['id']}/items/{problem['id']}", headers=headers
    )
    assert removed.status_code == 204
    assert await folders_of(client, headers, problem["id"]) == [two["id"]]


async def test_a_new_version_stays_in_its_folders(client, session: AsyncSession, signed_in) -> None:
    headers = await signed_in()
    problem = await a_problem(client, session, headers)
    folder = await a_folder(client, headers)
    await client.post(
        f"/problem-folders/{folder['id']}/items",
        json={"item_ids": [problem["id"]]},
        headers=headers,
    )

    draft = (await client.post(f"/items/{problem['id']}/new-version", headers=headers)).json()
    assert await folders_of(client, headers, draft["id"]) == [folder["id"]]

    # Removing either version while both are on the list takes both out.
    await client.delete(f"/problem-folders/{folder['id']}/items/{draft['id']}", headers=headers)
    assert await folders_of(client, headers, problem["id"]) == []
    # And adding either puts both in, so publishing the draft can't lose it.
    await client.post(
        f"/problem-folders/{folder['id']}/items",
        json={"item_ids": [problem["id"]]},
        headers=headers,
    )
    assert await folders_of(client, headers, draft["id"]) == [folder["id"]]


async def test_an_imported_new_version_stays_in_its_folders(
    client, session: AsyncSession, signed_in
) -> None:
    headers = await signed_in()
    session.add(Concept(key="variables", label="Variables"))
    await session.flush()
    first = """
problems:
  - key: hello
    title: Say hello
    concepts: [variables]
    starter: ""
    solution: print("hi")
    tests:
      - name: says hi
        prints: hi
"""
    report = await client.post(
        "/items/import", json={"yaml": first, "apply": True}, headers=headers
    )
    assert report.status_code == 200 and report.json()["applied"], report.text
    item_id = report.json()["entries"][0]["item_id"]
    item = (await client.get(f"/items/{item_id}", headers=headers)).json()
    published_now = await client.post(
        f"/items/{item_id}/publish",
        json={"verified_updated_at": item["updated_at"]},
        headers=headers,
    )
    assert published_now.status_code == 200, published_now.text
    folder = await a_folder(client, headers)
    await client.post(
        f"/problem-folders/{folder['id']}/items", json={"item_ids": [item_id]}, headers=headers
    )

    second = first.replace("title: Say hello", "title: Say hello nicely")
    report = await client.post(
        "/items/import", json={"yaml": second, "apply": True}, headers=headers
    )
    newer = report.json()["entries"][0]["item_id"]
    assert newer != item_id
    assert await folders_of(client, headers, newer) == [folder["id"]]


# --- the Trash ------------------------------------------------------------------------------


async def test_deleting_a_folder_leaves_its_problems_and_restoring_brings_it_all_back(
    client, session: AsyncSession, signed_in
) -> None:
    headers = await signed_in()
    problem = await a_problem(client, session, headers)
    folder = await a_folder(client, headers)
    await client.post(
        f"/problem-folders/{folder['id']}/items",
        json={"item_ids": [problem["id"]]},
        headers=headers,
    )

    assert (
        await client.post(f"/trash/problem_folder/{folder['id']}", headers=headers)
    ).status_code == 204
    assert (await client.get("/problem-folders", headers=headers)).json() == []
    assert await folders_of(client, headers, problem["id"]) == [], "a trashed folder isn't shown"
    trash = (await client.get("/trash", headers=headers)).json()
    assert [(t["kind"], t["name"]) for t in trash] == [("problem_folder", "Term 4 quizzes")]

    assert (
        await client.post(f"/trash/problem_folder/{folder['id']}/restore", headers=headers)
    ).status_code == 204
    assert await folders_of(client, headers, problem["id"]) == [folder["id"]]


async def test_deleting_a_folder_for_good_keeps_its_problems(
    client, session: AsyncSession, signed_in
) -> None:
    headers = await signed_in()
    problem = await a_problem(client, session, headers)
    folder = await a_folder(client, headers)
    await client.post(
        f"/problem-folders/{folder['id']}/items",
        json={"item_ids": [problem["id"]]},
        headers=headers,
    )
    await client.post(f"/trash/problem_folder/{folder['id']}", headers=headers)
    purged = await client.post(
        f"/trash/problem_folder/{folder['id']}/purge", json={}, headers=headers
    )
    assert purged.status_code == 204, purged.text

    assert (await session.exec(select(ProblemFolder))).all() == []
    assert (await session.exec(select(ProblemFolderItem))).all() == []
    assert await session.get(Item, uuid.UUID(problem["id"])) is not None


async def test_the_thirty_day_clock_takes_trashed_folders(
    client, session: AsyncSession, signed_in
) -> None:
    headers = await signed_in()
    folder = await a_folder(client, headers)
    await client.post(f"/trash/problem_folder/{folder['id']}", headers=headers)
    row = await session.get(ProblemFolder, uuid.UUID(folder["id"]))
    row.deleted_at = utcnow() - timedelta(days=TRASH_DAYS + 1)
    session.add(row)
    await session.flush()

    assert await purge_expired(session) == 1
    assert (await session.exec(select(ProblemFolder))).all() == []


async def test_deleting_a_problem_for_good_takes_it_out_of_its_folders(
    client, session: AsyncSession, signed_in
) -> None:
    headers = await signed_in()
    problem = await a_problem(client, session, headers)
    folder = await a_folder(client, headers)
    await client.post(
        f"/problem-folders/{folder['id']}/items",
        json={"item_ids": [problem["id"]]},
        headers=headers,
    )
    assert (
        await client.post(f"/trash/problem/{problem['id']}", headers=headers)
    ).status_code == 204
    purged = await client.post(f"/trash/problem/{problem['id']}/purge", json={}, headers=headers)
    assert purged.status_code == 204, purged.text

    assert (await session.exec(select(ProblemFolderItem))).all() == []
    assert (await client.get("/problem-folders", headers=headers)).json()[0]["id"] == folder["id"]
