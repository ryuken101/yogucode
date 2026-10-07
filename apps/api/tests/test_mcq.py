"""Multiple-choice questions: authored, answered, handed in, marked, read as misconceptions.

What a child must never receive comes first: which option is right, and the misconceptions
the wrong ones encode. Then the payoff — the marking view counts how many chose each
option, which is spec §3.6's "six students think range is inclusive".
"""

from sqlmodel.ext.asyncio.session import AsyncSession

from app.models import Concept
from work_builders import homework


def mcq(concept_id: str, **overrides) -> dict:
    return {
        "kind": "mcq",
        "title": "What does range(5) give?",
        "prompt_md": "What does `list(range(5))` print?",
        "concept_ids": [concept_id],
        "primary_concept_id": concept_id,
        "options": [
            {"text": "[0, 1, 2, 3, 4]", "correct": True},
            {"text": "[1, 2, 3, 4, 5]", "misconception": "SECRET-starts-at-one"},
            {"text": "[0, 1, 2, 3, 4, 5]", "misconception": "SECRET-inclusive-end"},
        ],
    } | overrides


async def concept(session: AsyncSession, key: str = "range") -> Concept:
    row = Concept(key=key, label=key.title())
    session.add(row)
    await session.flush()
    return row


async def published_mcq(client, headers, doc: dict) -> dict:
    created = (await client.post("/items", json=doc, headers=headers)).json()
    response = await client.post(
        f"/items/{created['id']}/publish",
        json={"verified_updated_at": created["updated_at"]},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    return response.json()


async def sheet_with_mcq(client, session, roster) -> dict:
    """A homework holding one multiple-choice question, set for the roster's class."""
    c = await concept(session)
    item = await published_mcq(client, roster["headers"], mcq(str(c.id)))
    hw = await homework(client, session, roster, set_it=False)
    await client.patch(
        f"/assignments/{hw['assignment']['id']}",
        json={"item_ids": [item["id"]]},
        headers=roster["headers"],
    )
    await client.post(f"/assignments/{hw['assignment']['id']}/set", headers=roster["headers"])
    return {"assignment_id": hw["assignment"]["id"], "item_id": item["id"]}


async def open_mcq(client, sheet) -> dict:
    response = await client.post(
        f"/me/assignments/{sheet['assignment_id']}/items/{sheet['item_id']}/open"
    )
    assert response.status_code == 200, response.text
    return response.json()


# --- what a child is sent -----------------------------------------------------------------


async def test_a_child_never_sees_the_answer_or_the_misconceptions(
    client, session: AsyncSession, signed_in_student
) -> None:
    aria = await signed_in_student()
    sheet = await sheet_with_mcq(client, session, aria)

    response = await client.post(
        f"/me/assignments/{sheet['assignment_id']}/items/{sheet['item_id']}/open"
    )

    body = response.json()
    assert body["kind"] == "mcq"
    assert body["options"] == ["[0, 1, 2, 3, 4]", "[1, 2, 3, 4, 5]", "[0, 1, 2, 3, 4, 5]"]
    assert "SECRET" not in response.text
    assert '"correct"' not in response.text


async def test_a_child_cannot_answer_in_another_childs_attempt(
    client, session: AsyncSession, signed_in_student
) -> None:
    aria = await signed_in_student("Aria K")
    sheet = await sheet_with_mcq(client, session, aria)
    attempt_id = (await open_mcq(client, sheet))["leaves"][0]["attempt"]["id"]
    await signed_in_student("Bella N")

    response = await client.put(f"/me/attempts/{attempt_id}/choice", json={"choice": 0})
    assert response.status_code == 404


# --- authoring ----------------------------------------------------------------------------


async def test_publishing_needs_two_options_one_correct_and_a_main_concept(
    client, session: AsyncSession, signed_in
) -> None:
    headers = await signed_in()
    c = await concept(session)
    lonely = mcq(str(c.id), options=[{"text": "only", "correct": True}], primary_concept_id=None)
    created = (await client.post("/items", json=lonely, headers=headers)).json()
    assert set(created["publish_problems"]) == {
        "The question needs at least two options",
        "The question needs a main concept",
    }
    two_right = mcq(
        str(c.id), options=[{"text": "a", "correct": True}, {"text": "b", "correct": True}]
    )
    created = (await client.post("/items", json=two_right, headers=headers)).json()
    assert created["publish_problems"] == ["Exactly one option should be marked correct"]


async def test_a_wrong_option_without_a_misconception_is_a_warning_not_a_block(
    client, session: AsyncSession, signed_in
) -> None:
    headers = await signed_in()
    c = await concept(session)
    doc = mcq(str(c.id), options=[{"text": "a", "correct": True}, {"text": "b"}])
    created = (await client.post("/items", json=doc, headers=headers)).json()
    assert created["publish_problems"] == []
    assert created["publish_warnings"] == [
        "1 wrong option without a misconception — naming it is what makes the answers diagnostic"
    ]


async def test_a_multiple_choice_question_has_no_parts(
    client, session: AsyncSession, signed_in
) -> None:
    headers = await signed_in()
    c = await concept(session)
    response = await client.post(
        "/items", json=mcq(str(c.id), parts=[{"label": "a"}]), headers=headers
    )
    assert response.status_code == 422


async def test_yaml_options_make_a_multiple_choice_question(
    client, session: AsyncSession, signed_in
) -> None:
    headers = await signed_in()
    await concept(session)
    text = """
problems:
  - key: range-five
    title: What does range(5) give?
    concepts: [range]
    options:
      - text: "[0, 1, 2, 3, 4]"
        correct: true
      - text: "[0, 1, 2, 3, 4, 5]"
        misconception: thinks range includes the end
"""
    report = (
        await client.post("/items/import", json={"yaml": text, "apply": True}, headers=headers)
    ).json()
    problem = (
        await client.get(f"/items/{report['entries'][0]['item_id']}", headers=headers)
    ).json()
    assert problem["document"]["kind"] == "mcq"
    assert problem["document"]["options"][1]["misconception"] == "thinks range includes the end"
    assert problem["publish_problems"] == []


# --- answering, handing in, marking -------------------------------------------------------


async def test_a_choice_is_saved_checked_and_never_shown_as_passing(
    client, session: AsyncSession, signed_in_student
) -> None:
    aria = await signed_in_student()
    sheet = await sheet_with_mcq(client, session, aria)
    attempt_id = (await open_mcq(client, sheet))["leaves"][0]["attempt"]["id"]

    assert (
        await client.put(f"/me/attempts/{attempt_id}/choice", json={"choice": 3})
    ).status_code == 422
    saved = await client.put(f"/me/attempts/{attempt_id}/choice", json={"choice": 0})
    assert saved.json()["choice"] == 0

    leaf = (await client.get(f"/me/homework/{sheet['assignment_id']}")).json()["leaves"][0]
    assert leaf["progress"] == "started", "a right answer must not show as 'passing'"


async def test_marking_counts_each_option_and_auto_marks(
    client, session: AsyncSession, student_on_roster
) -> None:
    from test_homework import as_student

    aria = await student_on_roster("Aria K")
    sheet = await sheet_with_mcq(client, session, aria)
    await as_student(client, aria)
    attempt_id = (await open_mcq(client, sheet))["leaves"][0]["attempt"]["id"]
    await client.put(f"/me/attempts/{attempt_id}/choice", json={"choice": 2})
    await client.post(f"/me/homework/{sheet['assignment_id']}/hand-in", json={})

    path = f"/assignments/{sheet['assignment_id']}/marking/{sheet['item_id']}"
    view = (await client.get(path, headers=aria["headers"])).json()
    assert view["kind"] == "mcq"
    assert [(o["chosen_by"], o["misconception"]) for o in view["options"]] == [
        (0, None),
        (0, "SECRET-starts-at-one"),
        (1, "SECRET-inclusive-end"),
    ]
    assert view["entries"][0]["choice"] == 2

    marked = await client.post(f"{path}/auto", headers=aria["headers"])
    assert marked.json() == {"marked": 1}
    again = await client.post(f"{path}/auto", headers=aria["headers"])
    assert again.json() == {"marked": 0}, "already-marked answers are left alone"
    entry = (await client.get(path, headers=aria["headers"])).json()["entries"][0]
    assert (entry["mark"]["correct"], entry["mark"]["runs"]) == (0, True)

    await client.post(f"/assignments/{sheet['assignment_id']}/release", headers=aria["headers"])
    back = (await client.get(f"/me/homework/{sheet['assignment_id']}")).json()["leaves"][0]
    assert back["feedback"]["answer"] == "[0, 1, 2, 3, 4, 5]"
    assert back["feedback"]["outcome"] == "not_yet"


async def test_code_questions_are_never_marked_automatically(
    client, session: AsyncSession, signed_in_student
) -> None:
    aria = await signed_in_student()
    hw = await homework(client, session, aria)
    response = await client.post(
        f"/assignments/{hw['assignment']['id']}/marking/{hw['items'][0]['id']}/auto",
        headers=aria["headers"],
    )
    assert response.status_code == 409
