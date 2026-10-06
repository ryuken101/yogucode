"""Builders shared by the classwork, homework and marking tests.

Everything here goes through the API the way a teacher would: problems are created and
published, a lesson gets a ladder, a class is put on the lesson. Only concepts are inserted
directly — they are seeded from YAML in real life, not created through a route.
"""

import uuid

from sqlmodel.ext.asyncio.session import AsyncSession

from app.models import Concept

SOLUTION = "numbers = [1, 2, 3]\nnumbers.append(5)\nprint(numbers)\n"


def problem_doc(concept_id: str, title: str = "Add to the end", **overrides) -> dict:
    return {
        "title": title,
        "prompt_md": "Add 5 to the end.",
        "difficulty": 1,
        "concept_ids": [concept_id],
        "primary_concept_id": concept_id,
        "starter_code": "numbers = [1, 2, 3]\n",
        "solution_code": SOLUTION,
        "tests": [
            {"kind": "io", "name": "prints it", "expected": "[1, 2, 3, 5]"},
            {"kind": "io", "name": "secret", "expected": "5", "match": "contains", "hidden": True},
        ],
        "hints": [
            {
                "body_md": "NUDGE: lists have a method",
                "unlock_after_runs": 1,
                "unlock_after_seconds": 120,
            },
            {
                "body_md": "WORKED: numbers.append(5)",
                "unlock_after_runs": 3,
                "unlock_after_seconds": 600,
            },
        ],
    } | overrides


async def published(client, headers, doc: dict) -> dict:
    created = (await client.post("/items", json=doc, headers=headers)).json()
    response = await client.post(
        f"/items/{created['id']}/publish",
        json={"verified_updated_at": created["updated_at"]},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    return response.json()


async def lesson_in_course(client, headers) -> dict:
    course = (await client.post("/courses", json={"title": "Python 1"}, headers=headers)).json()
    unit = (
        await client.post(
            f"/courses/{course['id']}/units", json={"title": "Lists"}, headers=headers
        )
    ).json()
    lesson = (
        await client.post(f"/units/{unit['id']}/lessons", json={"title": "Append"}, headers=headers)
    ).json()
    return {"course": course, "lesson": lesson}


async def today(client, session: AsyncSession, roster: dict, *, problems: int = 1) -> dict:
    """A class on a lesson whose ladder holds `problems` published problems."""
    headers = roster["headers"]
    concept = Concept(key=f"lists-{uuid.uuid4().hex[:6]}", label="Lists")
    session.add(concept)
    await session.flush()
    items = [
        await published(client, headers, problem_doc(str(concept.id), title=f"Problem {n}"))
        for n in range(problems)
    ]
    tree = await lesson_in_course(client, headers)
    saved = await client.put(
        f"/lessons/{tree['lesson']['id']}/ladder",
        json={"item_ids": [i["id"] for i in items]},
        headers=headers,
    )
    assert saved.status_code == 200, saved.text
    chosen = await client.put(
        f"/classes/{roster['class_id']}/curriculum",
        json={"course_id": tree["course"]["id"], "current_lesson_id": tree["lesson"]["id"]},
        headers=headers,
    )
    assert chosen.status_code == 200, chosen.text
    return {"items": items, "concept": concept, **tree}


async def open_first(client) -> dict:
    lesson = (await client.get("/me/lesson")).json()
    item_id = lesson["problems"][0]["item_id"]
    response = await client.post(f"/me/assignments/{lesson['assignment_id']}/items/{item_id}/open")
    assert response.status_code == 200, response.text
    return response.json()


async def homework(
    client,
    session: AsyncSession,
    roster: dict,
    *,
    problems: int = 1,
    due_at: str = "2099-01-01T16:00:00+11:00",
    hints: bool = True,
    set_it: bool = True,
) -> dict:
    """A homework for the roster's class, set (visible) unless `set_it=False`."""
    headers = roster["headers"]
    concept = Concept(key=f"hw-{uuid.uuid4().hex[:6]}", label="Lists")
    session.add(concept)
    await session.flush()
    items = [
        await published(client, headers, problem_doc(str(concept.id), title=f"Homework {n}"))
        for n in range(problems)
    ]
    created = await client.post(
        f"/classes/{roster['class_id']}/homework",
        json={
            "title": "Lists practice",
            "item_ids": [i["id"] for i in items],
            "due_at": due_at,
            "hints": hints,
        },
        headers=headers,
    )
    assert created.status_code == 201, created.text
    assignment = created.json()
    if set_it:
        response = await client.post(f"/assignments/{assignment['id']}/set", headers=headers)
        assert response.status_code == 200, response.text
        assignment = response.json()
    return {"assignment": assignment, "items": items, "concept": concept}
