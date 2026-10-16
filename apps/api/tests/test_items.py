"""The problem bank: one document per problem, drafts editable, published ones versioned.

The tenancy tests lead, as everywhere. After them, the rules that keep marks honest: a
published problem cannot be edited in place, and publishing requires proof that the
reference solution was run against the version being published.
"""

import uuid

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.models import Concept, Item, ItemStatus, TestCase


async def make_concepts(session: AsyncSession, *keys: str, centre_id=None) -> list[Concept]:
    concepts = [
        Concept(key=key, label=key.title(), sort_order=i * 10, centre_id=centre_id)
        for i, key in enumerate(keys)
    ]
    session.add_all(concepts)
    await session.flush()
    return concepts


def complete_doc(concept: Concept, **overrides) -> dict:
    """A problem that is ready to publish."""
    doc = {
        "title": "Add to the list",
        "prompt_md": "Add the number 5 to the end of `numbers`, then print it.",
        "difficulty": 1,
        "concept_ids": [str(concept.id)],
        "primary_concept_id": str(concept.id),
        "starter_code": "numbers = [1, 2, 3]\n",
        "solution_code": "numbers = [1, 2, 3]\nnumbers.append(5)\nprint(numbers)\n",
        "tests": [
            {"kind": "io", "name": "prints the list", "expected": "[1, 2, 3, 5]"},
            {
                "kind": "io",
                "name": "a hidden one",
                "expected": "5",
                "match": "contains",
                "hidden": True,
            },
        ],
        "hints": [{"body_md": "Lists have a method for adding to the end."}],
    }
    return doc | overrides


async def create(client, headers, doc: dict) -> dict:
    response = await client.post("/items", json=doc, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()


async def publish(client, headers, problem: dict):
    return await client.post(
        f"/items/{problem['id']}/publish",
        json={"verified_updated_at": problem["updated_at"]},
        headers=headers,
    )


async def foreign_item(session: AsyncSession, centre_id) -> Item:
    item = Item(centre_id=centre_id, title="Someone else's problem", solution_code="print(1)")
    session.add(item)
    await session.flush()
    return item


# --- tenancy --------------------------------------------------------------------------


async def test_another_centres_problem_is_unreachable(
    client, signed_in, session: AsyncSession, foreign_centre
) -> None:
    headers = await signed_in()
    theirs = await foreign_item(session, foreign_centre["centre"].id)

    assert (await client.get("/items", headers=headers)).json() == []
    for method, path, body in [
        ("get", f"/items/{theirs.id}", None),
        ("put", f"/items/{theirs.id}", {"title": "Mine now"}),
        ("post", f"/items/{theirs.id}/publish", {"verified_updated_at": "2026-01-01T00:00:00Z"}),
        ("post", f"/items/{theirs.id}/new-version", None),
        ("post", f"/items/{theirs.id}/archive", None),
        ("post", f"/items/{theirs.id}/unarchive", None),
    ]:
        response = await client.request(method, path, json=body, headers=headers)
        assert response.status_code == 404, (method, path, response.text)


async def test_another_centres_private_concept_cannot_be_tagged(
    client, signed_in, session: AsyncSession, foreign_centre
) -> None:
    headers = await signed_in()
    (private,) = await make_concepts(session, "vex", centre_id=foreign_centre["centre"].id)

    response = await client.post("/items", json=complete_doc(private), headers=headers)
    assert response.status_code == 422


async def test_a_part_is_not_addressable_on_its_own(
    client, signed_in, session: AsyncSession
) -> None:
    """Parts change with their parent; a route taking a part's id would be a side door."""
    headers = await signed_in()
    (lists,) = await make_concepts(session, "lists")
    created = await create(
        client, headers, {"title": "Two parts", "parts": [{"label": "a"}, {"label": "b"}]}
    )

    part_id = created["parts"][0]["id"]
    assert (await client.get(f"/items/{part_id}", headers=headers)).status_code == 404
    assert (
        await client.put(f"/items/{part_id}", json=complete_doc(lists), headers=headers)
    ).status_code == 404


async def test_a_student_cannot_reach_the_bank(client, signed_in_student) -> None:
    """The bank holds reference solutions and hidden tests."""
    await signed_in_student()
    assert (await client.get("/items")).status_code == 403
    assert (await client.post("/items", json={"title": "Mine"})).status_code == 403


# --- the document ---------------------------------------------------------------------


async def test_a_problem_round_trips_as_one_document(
    client, signed_in, session: AsyncSession
) -> None:
    headers = await signed_in()
    lists, methods = await make_concepts(session, "lists", "list_methods")
    doc = complete_doc(lists, concept_ids=[str(lists.id), str(methods.id)])
    doc["tests"].append({"kind": "function", "name": "adds", "call": "add(2, 3)", "expected": "5"})
    created = await create(client, headers, doc)

    read = (await client.get(f"/items/{created['id']}", headers=headers)).json()
    assert read["status"] == "draft"
    assert read["version"] == 1
    body = read["document"]
    assert body["title"] == "Add to the list"
    assert body["primary_concept_id"] == str(lists.id)
    assert set(body["concept_ids"]) == {str(lists.id), str(methods.id)}
    assert [t["name"] for t in body["tests"]] == ["prints the list", "a hidden one", "adds"]
    assert body["tests"][1]["hidden"] is True
    assert body["tests"][1]["match"] == "contains"
    assert body["tests"][2] == {
        "kind": "function",
        "name": "adds",
        "hidden": False,
        "call": "add(2, 3)",
        "expected": "5",
    }
    assert body["hints"][0]["unlock_after_runs"] == 1
    assert read["publish_problems"] == []


async def test_a_draft_may_be_half_written(client, signed_in) -> None:
    headers = await signed_in()
    created = await create(client, headers, {"title": "Ideas for Tuesday"})

    assert created["status"] == "draft"
    assert set(created["publish_problems"]) == {
        "The problem needs a reference solution",
        "The problem needs a main concept",
    }
    # Checks are optional (Ken, 17 Oct 2026): their absence is a warning, not a gap.
    assert created["publish_warnings"] == [
        "The problem has no checks — students can Run it, but there is nothing to Check"
    ]


async def test_the_main_concept_must_be_one_of_the_tags(
    client, signed_in, session: AsyncSession
) -> None:
    headers = await signed_in()
    lists, loops = await make_concepts(session, "lists", "for_loops")
    doc = complete_doc(lists, primary_concept_id=str(loops.id))
    assert (await client.post("/items", json=doc, headers=headers)).status_code == 422


async def test_a_function_test_needs_a_call(client, signed_in, session: AsyncSession) -> None:
    headers = await signed_in()
    (lists,) = await make_concepts(session, "lists")
    doc = complete_doc(lists, tests=[{"kind": "function", "name": "x", "expected": "5"}])
    assert (await client.post("/items", json=doc, headers=headers)).status_code == 422


async def test_saving_replaces_the_tests(client, signed_in, session: AsyncSession) -> None:
    headers = await signed_in()
    (lists,) = await make_concepts(session, "lists")
    created = await create(client, headers, complete_doc(lists))

    doc = complete_doc(lists, tests=[{"kind": "io", "name": "only one", "expected": "x"}])
    saved = await client.put(f"/items/{created['id']}", json=doc, headers=headers)

    assert saved.status_code == 200
    assert [t["name"] for t in saved.json()["document"]["tests"]] == ["only one"]
    rows = (
        await session.exec(select(TestCase).where(TestCase.item_id == uuid.UUID(created["id"])))
    ).all()
    assert len(rows) == 1


# --- parts ----------------------------------------------------------------------------


async def test_parts_keep_their_ids_across_saves(client, signed_in, session: AsyncSession) -> None:
    headers = await signed_in()
    (lists,) = await make_concepts(session, "lists")
    created = await create(
        client, headers, {"title": "Shopping", "parts": [{"label": "a"}, {"label": "b"}]}
    )
    part_a = created["parts"][0]["id"]

    saved = (
        await client.put(
            f"/items/{created['id']}",
            json={"title": "Shopping", "parts": [complete_doc(lists) | {"label": "a"}]},
            headers=headers,
        )
    ).json()

    assert saved["parts"] == [{"id": part_a, "label": "a"}]
    assert await session.get(Item, uuid.UUID(created["parts"][1]["id"])) is None
    assert saved["document"]["parts"][0]["tests"][0]["name"] == "prints the list"


async def test_a_problem_with_parts_is_checked_part_by_part(
    client, signed_in, session: AsyncSession
) -> None:
    headers = await signed_in()
    (lists,) = await make_concepts(session, "lists")
    part_a = complete_doc(lists) | {"label": "a"}
    created = await create(
        client, headers, {"title": "Shopping", "parts": [part_a, {"label": "b"}]}
    )

    assert set(created["publish_problems"]) == {
        "Part (b) needs a reference solution",
        "Part (b) needs a main concept",
    }


async def test_parts_with_the_same_label_are_refused(client, signed_in) -> None:
    headers = await signed_in()
    doc = {"title": "Twins", "parts": [{"label": "a"}, {"label": "A"}]}
    assert (await client.post("/items", json=doc, headers=headers)).status_code == 422


async def test_a_concept_on_a_part_finds_the_problem(
    client, signed_in, session: AsyncSession
) -> None:
    """A teacher looking for list problems wants the problem whose part (b) drills lists."""
    headers = await signed_in()
    lists, loops = await make_concepts(session, "lists", "for_loops")
    await create(client, headers, complete_doc(loops, title="Loops only"))
    await create(
        client,
        headers,
        {
            "title": "Mixed",
            "parts": [complete_doc(loops) | {"label": "a"}, complete_doc(lists) | {"label": "b"}],
        },
    )

    found = (await client.get(f"/items?concept_id={lists.id}", headers=headers)).json()
    assert [p["title"] for p in found] == ["Mixed"]
    assert found[0]["part_labels"] == ["a", "b"]
    assert found[0]["test_count"] == 4


async def test_the_bank_filters_by_difficulty_and_title(
    client, signed_in, session: AsyncSession
) -> None:
    headers = await signed_in()
    (lists,) = await make_concepts(session, "lists")
    await create(client, headers, complete_doc(lists, title="Easy append", difficulty=1))
    await create(client, headers, complete_doc(lists, title="Hard append", difficulty=3))

    hard = (await client.get("/items?difficulty=3", headers=headers)).json()
    assert [p["title"] for p in hard] == ["Hard append"]
    easy = (await client.get("/items?q=easy", headers=headers)).json()
    assert [p["title"] for p in easy] == ["Easy append"]


# --- publishing -----------------------------------------------------------------------


async def test_a_complete_draft_publishes(client, signed_in, session: AsyncSession) -> None:
    headers = await signed_in()
    (lists,) = await make_concepts(session, "lists")
    created = await create(client, headers, complete_doc(lists))

    response = await publish(client, headers, created)
    assert response.status_code == 200
    assert response.json()["status"] == "published"


async def test_an_incomplete_draft_does_not_publish(client, signed_in) -> None:
    headers = await signed_in()
    created = await create(client, headers, {"title": "Not yet"})

    response = await publish(client, headers, created)
    assert response.status_code == 422
    assert "The problem needs a reference solution" in response.json()["detail"]


async def test_a_test_run_against_an_older_save_does_not_count(
    client, signed_in, session: AsyncSession
) -> None:
    """Changing only a test case must still invalidate the run: it changed what passes."""
    headers = await signed_in()
    (lists,) = await make_concepts(session, "lists")
    created = await create(client, headers, complete_doc(lists))
    doc = complete_doc(lists, tests=[{"kind": "io", "name": "changed", "expected": "nope"}])
    await client.put(f"/items/{created['id']}", json=doc, headers=headers)

    response = await publish(client, headers, created)
    assert response.status_code == 409


async def test_a_published_problem_cannot_be_edited_in_place(
    client, signed_in, session: AsyncSession
) -> None:
    headers = await signed_in()
    (lists,) = await make_concepts(session, "lists")
    created = await create(client, headers, complete_doc(lists))
    await publish(client, headers, created)

    response = await client.put(
        f"/items/{created['id']}", json=complete_doc(lists, title="Sneaky"), headers=headers
    )
    assert response.status_code == 409


async def test_a_new_version_replaces_the_old_one_when_published(
    client, signed_in, session: AsyncSession
) -> None:
    headers = await signed_in()
    (lists,) = await make_concepts(session, "lists")
    v1 = await create(client, headers, complete_doc(lists))
    await publish(client, headers, v1)

    v2 = (await client.post(f"/items/{v1['id']}/new-version", headers=headers)).json()
    assert v2["status"] == "draft"
    assert v2["version"] == 2
    assert v2["supersedes_id"] == v1["id"]
    assert (
        v2["document"]
        == (await client.get(f"/items/{v1['id']}", headers=headers)).json()["document"]
    )

    again = (await client.post(f"/items/{v1['id']}/new-version", headers=headers)).json()
    assert again["id"] == v2["id"], "a second press lands on the same draft"

    await publish(client, headers, v2)
    old = await session.get(Item, uuid.UUID(v1["id"]))
    await session.refresh(old)
    assert old.status == ItemStatus.SUPERSEDED
    listed = (await client.get("/items", headers=headers)).json()
    assert [p["id"] for p in listed] == [v2["id"]]


async def test_publishing_a_problem_publishes_its_parts(
    client, signed_in, session: AsyncSession
) -> None:
    headers = await signed_in()
    (lists,) = await make_concepts(session, "lists")
    created = await create(
        client, headers, {"title": "Shopping", "parts": [complete_doc(lists) | {"label": "a"}]}
    )
    await publish(client, headers, created)

    part = await session.get(Item, uuid.UUID(created["parts"][0]["id"]))
    await session.refresh(part)
    assert part.status == ItemStatus.PUBLISHED


async def test_an_archived_problem_comes_back_as_a_draft(
    client, signed_in, session: AsyncSession
) -> None:
    headers = await signed_in()
    (lists,) = await make_concepts(session, "lists")
    created = await create(client, headers, complete_doc(lists))
    await publish(client, headers, created)

    archived = await client.post(f"/items/{created['id']}/archive", headers=headers)
    assert archived.json()["status"] == "archived"
    assert (await client.get("/items", headers=headers)).json() == []
    restored = await client.post(f"/items/{created['id']}/unarchive", headers=headers)
    assert restored.json()["status"] == "draft"


async def test_a_custom_check_is_saved_and_read_back(client, signed_in, session) -> None:
    """The teacher's own Python check (17 Oct 2026): stored as `{code}`, read back whole."""
    from app.models import Concept

    headers = await signed_in()
    concept = Concept(key="input-ex", label="Input")
    session.add(concept)
    await session.flush()
    check = {
        "kind": "script",
        "name": "hits and misses",
        "hidden": False,
        "code": (
            "for g in range(10):\n"
            "    out, v = run(g)\n"
            "    check(('HIT!' in out) == (g in v['ships']))\n"
        ),
    }
    body = {
        "title": "Battleship",
        "concept_ids": [str(concept.id)],
        "primary_concept_id": str(concept.id),
        "solution_code": "ships = [2]\nprint('HIT!' if int(input()) in ships else 'MISS!')\n",
        "tests": [check],
    }
    created = await client.post("/items", json=body, headers=headers)
    assert created.status_code == 201, created.text
    assert created.json()["document"]["tests"] == [check]
    assert created.json()["publish_problems"] == []

    empty = await client.put(
        f"/items/{created.json()['id']}",
        json=body | {"tests": [check | {"code": ""}]},
        headers=headers,
    )
    assert empty.status_code == 422
