"""YAML import: plan first, apply only an error-free file, never publish.

The rules that matter: a re-import of an unchanged file does nothing; a changed problem
that is already published gets a new-version draft and stays live meanwhile; and a key
belongs to one centre — another centre's problem with the same key is not "the same
problem".
"""

import uuid

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.models import Concept, Item, ItemStatus

FILE = """
problems:
  - key: add-five
    title: Add to the end
    concepts: [lists]
    starter: "numbers = [1, 2, 3]\\n"
    solution: "numbers = [1, 2, 3]\\nnumbers.append(5)\\nprint(numbers)\\n"
    tests:
      - name: prints the list
        prints: "[1, 2, 3, 5]"
      - name: last is 5
        call: numbers[-1]
        returns: "5"
    hints:
      - text: Lists have a method for this.
        after_minutes: 3
"""


async def lists_concept(session: AsyncSession) -> Concept:
    concept = Concept(key="lists", label="Lists")
    session.add(concept)
    await session.flush()
    return concept


async def run_import(client, headers, text: str, apply: bool) -> dict:
    response = await client.post(
        "/items/import", json={"yaml": text, "apply": apply}, headers=headers
    )
    assert response.status_code == 200, response.text
    return response.json()


async def test_a_dry_run_changes_nothing(client, signed_in, session: AsyncSession) -> None:
    headers = await signed_in()
    await lists_concept(session)

    report = await run_import(client, headers, FILE, apply=False)

    assert report["applied"] is False
    assert [(e["key"], e["action"]) for e in report["entries"]] == [("add-five", "create")]
    assert (await session.exec(select(Item))).all() == []


async def test_applying_creates_drafts_that_read_like_typed_ones(
    client, signed_in, session: AsyncSession
) -> None:
    headers = await signed_in()
    lists = await lists_concept(session)

    report = await run_import(client, headers, FILE, apply=True)
    assert report["applied"] is True
    item_id = report["entries"][0]["item_id"]

    problem = (await client.get(f"/items/{item_id}", headers=headers)).json()
    assert problem["status"] == "draft"
    assert problem["source_key"] == "add-five"
    assert problem["publish_problems"] == []
    doc = problem["document"]
    assert doc["primary_concept_id"] == str(lists.id), "the first concept is the main one"
    assert doc["tests"][0] == {
        "kind": "io",
        "name": "prints the list",
        "hidden": False,
        "stdin": "",
        "expected": "[1, 2, 3, 5]",
        "match": "exact",
    }
    assert doc["tests"][1]["kind"] == "function"
    assert doc["hints"][0]["unlock_after_seconds"] == 180


async def test_reimporting_an_unchanged_file_does_nothing(
    client, signed_in, session: AsyncSession
) -> None:
    headers = await signed_in()
    await lists_concept(session)
    await run_import(client, headers, FILE, apply=True)

    report = await run_import(client, headers, FILE, apply=True)
    assert report["entries"][0]["action"] == "unchanged"
    assert len((await session.exec(select(Item))).all()) == 1


async def test_a_changed_draft_is_updated_in_place(
    client, signed_in, session: AsyncSession
) -> None:
    headers = await signed_in()
    await lists_concept(session)
    first = await run_import(client, headers, FILE, apply=True)

    report = await run_import(
        client, headers, FILE.replace("Add to the end", "Append five"), apply=True
    )
    assert report["entries"][0]["action"] == "update_draft"
    assert report["entries"][0]["item_id"] == first["entries"][0]["item_id"]
    item = await session.get(Item, uuid.UUID(first["entries"][0]["item_id"]))
    await session.refresh(item)
    assert item.title == "Append five"


async def test_a_changed_published_problem_gets_a_new_version_and_stays_live(
    client, signed_in, session: AsyncSession
) -> None:
    headers = await signed_in()
    await lists_concept(session)
    first = await run_import(client, headers, FILE, apply=True)
    v1_id = first["entries"][0]["item_id"]
    v1 = (await client.get(f"/items/{v1_id}", headers=headers)).json()
    await client.post(
        f"/items/{v1_id}/publish",
        json={"verified_updated_at": v1["updated_at"]},
        headers=headers,
    )

    report = await run_import(
        client, headers, FILE.replace("Add to the end", "Append five"), apply=True
    )
    entry = report["entries"][0]
    assert entry["action"] == "new_version"
    v2 = (await client.get(f"/items/{entry['item_id']}", headers=headers)).json()
    assert (v2["status"], v2["version"], v2["supersedes_id"]) == ("draft", 2, v1_id)
    still_live = await session.get(Item, uuid.UUID(v1_id))
    await session.refresh(still_live)
    assert still_live.status == ItemStatus.PUBLISHED


async def test_one_bad_entry_applies_nothing(client, signed_in, session: AsyncSession) -> None:
    headers = await signed_in()
    await lists_concept(session)
    bad = (
        FILE
        + """
  - key: loops
    title: Uses a concept nobody has
    concepts: [time_travel]
"""
    )
    report = await run_import(client, headers, bad, apply=True)

    assert report["applied"] is False
    assert report["entries"][1]["action"] == "error"
    assert "time_travel" in report["entries"][1]["error"]
    assert (await session.exec(select(Item))).all() == []


async def test_a_broken_file_says_why(client, signed_in) -> None:
    headers = await signed_in()
    for text, expected in [
        ("problems: [", "not valid YAML"),
        ("problems:\n  - key: a\n    title: x\n    prompts: typo\n", "prompts"),
        ("problems:\n  - key: a\n    title: x\n  - key: a\n    title: y\n", "used twice"),
        (
            "problems:\n  - key: a\n    title: x\n    tests:\n      - name: t\n",
            "prints",
        ),
    ]:
        report = await run_import(client, headers, text, apply=False)
        assert report["error"] is not None and expected in report["error"], (text, report)


async def test_another_centres_key_is_not_this_centres_problem(
    client, signed_in, session: AsyncSession, foreign_centre
) -> None:
    headers = await signed_in()
    await lists_concept(session)
    theirs = Item(centre_id=foreign_centre["centre"].id, title="Theirs", source_key="add-five")
    session.add(theirs)
    await session.flush()

    report = await run_import(client, headers, FILE, apply=True)

    assert report["entries"][0]["action"] == "create"
    await session.refresh(theirs)
    assert theirs.title == "Theirs"


async def test_a_student_cannot_import(client, signed_in_student) -> None:
    await signed_in_student()
    response = await client.post("/items/import", json={"yaml": FILE, "apply": True})
    assert response.status_code == 403
