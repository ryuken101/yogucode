"""Examples, shared files, and lesson work a child can come back to (Ken, 17 Oct 2026).

- **Examples** are sample runs a child watches. The teacher gives the inputs; the run is
  their browser's, stored at publish — never at save, and never one that does not fit.
- **A shared file** is one program for a problem's parts: each part keeps its own attempt,
  but the code in them is the same file.
- **My work** lists every lesson problem a child has started, so a problem from an earlier
  lesson can be finished at home.
"""

import base64
import uuid

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.models import Attempt, Concept
from work_builders import lesson_in_course, open_first, problem_doc, published, today

GREET = 'name = input("Name? ")\nprint("Hi", name)\n'
RUN = [
    {"kind": "out", "text": "Name? "},
    {"kind": "in", "text": "Ken"},
    {"kind": "out", "text": "Hi Ken\n"},
]


async def a_concept(session: AsyncSession) -> str:
    concept = Concept(key=f"ex-{uuid.uuid4().hex[:6]}", label="Input")
    session.add(concept)
    await session.flush()
    return str(concept.id)


def greet_doc(concept: str, **overrides) -> dict:
    return problem_doc(
        concept,
        title="Greet",
        starter_code="",
        solution_code=GREET,
        tests=[{"kind": "io", "name": "greets", "stdin": "Ken", "expected": "Hi Ken"}],
        examples=[{"inputs": ["Ken"]}],
        **overrides,
    )


def shared_doc(concept: str) -> dict:
    """Two parts, one file: (a) defines `double`, (b) defines `triple`."""
    part = {"difficulty": 1, "concept_ids": [concept], "primary_concept_id": concept}
    return {
        "title": "Times tables",
        "prompt_md": "Write both.",
        "shared_file": True,
        "starter_code": "# your code\n",
        "solution_code": "def double(n):\n    return n * 2\n\ndef triple(n):\n    return n * 3\n",
        "parts": [
            part
            | {
                "label": "a",
                "prompt_md": "Write `double`.",
                "tests": [{"kind": "function", "name": "d", "call": "double(2)", "expected": "4"}],
            },
            part
            | {
                "label": "b",
                "prompt_md": "Write `triple`.",
                "tests": [{"kind": "function", "name": "t", "call": "triple(2)", "expected": "6"}],
            },
        ],
    }


async def publish(client, headers, created: dict, transcripts: dict):
    return await client.post(
        f"/items/{created['id']}/publish",
        json={"verified_updated_at": created["updated_at"], "transcripts": transcripts},
        headers=headers,
    )


async def on_today(client, roster: dict, item_ids: list[str]) -> dict:
    headers = roster["headers"]
    tree = await lesson_in_course(client, headers)
    await client.put(
        f"/lessons/{tree['lesson']['id']}/ladder", json={"item_ids": item_ids}, headers=headers
    )
    chosen = await client.put(
        f"/classes/{roster['class_id']}/curriculum",
        json={"course_id": tree["course"]["id"], "current_lesson_id": tree["lesson"]["id"]},
        headers=headers,
    )
    assert chosen.status_code == 200, chosen.text
    return tree


# --- examples -------------------------------------------------------------------------


async def test_a_save_keeps_the_inputs_and_never_a_transcript(
    client, session: AsyncSession, signed_in
) -> None:
    headers = await signed_in()
    doc = greet_doc(await a_concept(session))
    doc["examples"] = [{"inputs": ["Ken"], "transcript": RUN}]
    created = (await client.post("/items", json=doc, headers=headers)).json()
    assert created["document"]["examples"] == [{"inputs": ["Ken"], "transcript": None}]

    doc["examples"] = [{"inputs": [str(n)]} for n in range(4)]
    too_many = await client.put(f"/items/{created['id']}", json=doc, headers=headers)
    assert too_many.status_code == 422


async def test_publishing_stores_the_runs_and_refuses_ones_that_do_not_fit(
    client, session: AsyncSession, signed_in
) -> None:
    headers = await signed_in()
    created = (
        await client.post("/items", json=greet_doc(await a_concept(session)), headers=headers)
    ).json()

    missing = await publish(client, headers, created, {})
    assert missing.status_code == 409
    other_input = [{**line, "text": "Bella"} if line["kind"] == "in" else line for line in RUN]
    assert (await publish(client, headers, created, {"": [other_input]})).status_code == 409
    assert (await publish(client, headers, created, {"": [RUN, RUN]})).status_code == 409
    assert (await publish(client, headers, created, {"a": [RUN]})).status_code == 409

    done = await publish(client, headers, created, {"": [RUN]})
    assert done.status_code == 200, done.text
    assert done.json()["document"]["examples"] == [{"inputs": ["Ken"], "transcript": RUN}]


async def test_a_child_sees_the_run_but_not_the_solution(
    client, session: AsyncSession, signed_in_student
) -> None:
    aria = await signed_in_student()
    created = (
        await client.post(
            "/items", json=greet_doc(await a_concept(session)), headers=aria["headers"]
        )
    ).json()
    item = (await publish(client, aria["headers"], created, {"": [RUN]})).json()
    await on_today(client, aria, [item["id"]])

    opened = await open_first(client)
    assert opened["leaves"][0]["examples"] == [RUN]
    assert "input(" not in str(opened), "the solution never reaches a child"


# --- one file across parts --------------------------------------------------------------


async def test_a_shared_file_keeps_its_code_on_the_problem(
    client, session: AsyncSession, signed_in
) -> None:
    headers = await signed_in()
    doc = shared_doc(await a_concept(session))
    created = (await client.post("/items", json=doc, headers=headers)).json()
    assert created["document"]["shared_file"] is True
    assert created["publish_problems"] == []

    doc["parts"][0]["solution_code"] = "def double(n): return n * 2\n"
    doc["solution_code"] = ""
    saved = (await client.put(f"/items/{created['id']}", json=doc, headers=headers)).json()
    assert "The file needs a reference solution" in saved["publish_problems"]
    assert (
        "Part (a) shares the problem's file, so has no code of its own" in saved["publish_problems"]
    )


async def test_every_part_of_a_shared_file_is_the_same_code(
    client, session: AsyncSession, signed_in_student
) -> None:
    aria = await signed_in_student()
    item = await published(client, aria["headers"], shared_doc(await a_concept(session)))
    await on_today(client, aria, [item["id"]])

    opened = await open_first(client)
    assert opened["shared_file"] is True
    a, b = opened["leaves"]
    assert opened["file_attempt_id"] == a["attempt"]["id"]
    assert a["attempt"]["code"] == b["attempt"]["code"] == "# your code\n"

    saved = await client.patch(
        f"/me/attempts/{a['attempt']['id']}", json={"code": "def double(n):\n    return 2 * n\n"}
    )
    assert saved.status_code == 200
    codes = {row.code for row in (await session.exec(select(Attempt))).all()}
    assert codes == {"def double(n):\n    return 2 * n\n"}
    # Checks stay each part's own.
    await client.post(f"/me/attempts/{a['attempt']['id']}/runs", json={"passed": 1, "total": 1})
    again = await open_first(client)
    assert [leaf["attempt"]["last_passed"] for leaf in again["leaves"]] == [1, None]


async def test_parts_with_their_own_code_stay_separate(
    client, session: AsyncSession, signed_in_student
) -> None:
    aria = await signed_in_student()
    doc = shared_doc(await a_concept(session))
    doc["shared_file"] = False
    for part, name in zip(doc["parts"], ["double", "triple"], strict=True):
        part["starter_code"] = f"# {name}\n"
        part["solution_code"] = doc["solution_code"]
    doc["solution_code"] = doc["starter_code"] = ""
    item = await published(client, aria["headers"], doc)
    await on_today(client, aria, [item["id"]])

    opened = await open_first(client)
    assert opened["shared_file"] is False and opened["file_attempt_id"] is None
    a, b = opened["leaves"]
    await client.patch(f"/me/attempts/{a['attempt']['id']}", json={"code": "mine"})
    again = await open_first(client)
    assert [leaf["attempt"]["code"] for leaf in again["leaves"]] == ["mine", "# triple\n"]


# --- my work: lessons a child can come back to ------------------------------------------


async def test_a_problem_from_an_earlier_lesson_stays_in_my_work(
    client, session: AsyncSession, signed_in_student
) -> None:
    aria = await signed_in_student()
    setup = await today(client, session, aria)
    opened = await open_first(client)
    assert (await client.get("/me/problems")).json()[0]["lesson_title"] == "Append"

    # The class moves on to another lesson.
    await on_today(client, aria, [setup["items"][0]["id"]])
    assert (await client.get("/me/lesson")).json()["assignment_id"] != opened["assignment_id"]

    listed = (await client.get("/me/problems")).json()
    assert [(p["assignment_id"], p["item_id"]) for p in listed] == [
        (opened["assignment_id"], opened["item_id"])
    ]
    back = await client.post(
        f"/me/assignments/{opened['assignment_id']}/items/{opened['item_id']}/open"
    )
    assert back.status_code == 200
    attempt_id = back.json()["leaves"][0]["attempt"]["id"]
    saved = await client.patch(f"/me/attempts/{attempt_id}", json={"code": "at home"})
    assert saved.status_code == 200


async def test_my_work_is_only_my_own(client, session: AsyncSession, signed_in_student) -> None:
    aria = await signed_in_student("Aria K")
    await today(client, session, aria)
    await open_first(client)

    await signed_in_student("Bella N")  # another class, at the same centre
    assert (await client.get("/me/problems")).json() == []


async def test_a_teacher_has_no_lesson_work(client, signed_in) -> None:
    headers = await signed_in()
    assert (await client.get("/me/problems", headers=headers)).status_code == 403


# --- "matches my solution": the solution, scrambled, for the child's browser -------------

COMPARE = {
    "kind": "compare",
    "name": "plays like mine",
    "hidden": False,
    "inputs": [{"mode": "range", "start": 0, "end": 9}],
    "chosen": [
        {
            "name": "ships",
            "rule": {"type": "numbers", "count": 3, "min": 0, "max": 9, "distinct": True},
        }
    ],
    "match": "exact",
}


async def test_a_compare_check_round_trips_without_the_solution_in_it(
    client, session: AsyncSession, signed_in
) -> None:
    headers = await signed_in()
    doc = greet_doc(await a_concept(session)) | {"tests": [COMPARE], "examples": []}
    created = (await client.post("/items", json=doc, headers=headers)).json()
    assert created["document"]["tests"] == [COMPARE | {"reference": None}]

    too_many = COMPARE | {
        "inputs": [
            {"mode": "range", "start": 0, "end": 20},
            {"mode": "range", "start": 0, "end": 20},
        ]
    }
    refused = await client.put(
        f"/items/{created['id']}", json=doc | {"tests": [too_many]}, headers=headers
    )
    assert refused.status_code == 422


async def test_a_child_gets_the_solution_only_scrambled_inside_the_check(
    client, session: AsyncSession, signed_in_student
) -> None:
    from app.problem_bank import SCRAMBLE_KEY

    aria = await signed_in_student()
    doc = greet_doc(await a_concept(session)) | {"tests": [COMPARE], "examples": []}
    item = await published(client, aria["headers"], doc)
    await on_today(client, aria, [item["id"]])

    opened = await open_first(client)
    reference = opened["leaves"][0]["tests"][0]["reference"]
    assert reference and GREET not in str(opened)
    raw = base64.b64decode(reference)
    plain = bytes(b ^ SCRAMBLE_KEY[i % len(SCRAMBLE_KEY)] for i, b in enumerate(raw)).decode()
    assert plain == GREET


# --- Save: the work kept in a file of the child's choosing (17 Oct 2026) -----------------


async def test_saving_to_a_file_keeps_the_file_up_to_date(
    client, session: AsyncSession, signed_in_student
) -> None:
    from app.models import StudentDocument

    aria = await signed_in_student()
    await today(client, session, aria)
    opened = await open_first(client)
    attempt_id = opened["leaves"][0]["attempt"]["id"]
    made = (
        await client.post("/me/documents", json={"title": "battleship.py", "content": "x = 1\n"})
    ).json()

    linked = await client.put(f"/me/attempts/{attempt_id}/file", json={"document_id": made["id"]})
    assert linked.status_code == 200 and linked.json()["document_id"] == made["id"]
    # Linking writes the work into the file at once.
    file = (await client.get(f"/me/documents/{made['id']}")).json()
    assert file["content"] == opened["leaves"][0]["attempt"]["code"]

    await client.patch(f"/me/attempts/{attempt_id}", json={"code": "print('saved')\n"})
    assert (await client.get(f"/me/documents/{made['id']}")).json()["content"] == "print('saved')\n"
    again = await open_first(client)
    assert again["leaves"][0]["attempt"]["document_id"] == made["id"]

    # A deleted file ends the link rather than failing the save.
    await client.post(f"/me/documents/{made['id']}/archive")
    saved = await client.patch(f"/me/attempts/{attempt_id}", json={"code": "print(2)\n"})
    assert saved.status_code == 200 and saved.json()["document_id"] is None
    row = await session.get(StudentDocument, uuid.UUID(made["id"]))
    assert row is not None and row.content == "print('saved')\n"


async def test_only_my_own_file_can_be_chosen(
    client, session: AsyncSession, signed_in_student
) -> None:
    await signed_in_student("Bella N")
    bellas = (await client.post("/me/documents", json={"title": "mine.py"})).json()

    aria = await signed_in_student("Aria K")
    await today(client, session, aria)
    opened = await open_first(client)
    refused = await client.put(
        f"/me/attempts/{opened['leaves'][0]['attempt']['id']}/file",
        json={"document_id": bellas["id"]},
    )
    assert refused.status_code == 404
