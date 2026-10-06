"""Lesson ladders, classwork, and a child's attempts.

The subject-boundary tests lead, as in `test_documents.py`: **can a child reach another
child's work, or a class they are not in.** Then what a child is sent — never the
reference solution, never a hint they have not earned — and the hint gate itself, which is
the server's decision rather than the browser's.
"""

import uuid
from datetime import timedelta

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.models import Assignment, Attempt, Concept, Item
from work_builders import (
    SOLUTION,
    lesson_in_course,
    open_first,
    problem_doc,
    published,
    today,
)

# --- the subject boundary -------------------------------------------------------------


async def test_a_child_cannot_reach_another_childs_attempt(
    client, session: AsyncSession, signed_in_student
) -> None:
    aria = await signed_in_student("Aria K")
    await today(client, session, aria)
    arias = await open_first(client)
    attempt_id = arias["leaves"][0]["attempt"]["id"]
    assignment_id = arias["assignment_id"]

    await signed_in_student("Bella N")  # a different class; the cookie is now Bella's

    assert (await client.patch(f"/me/attempts/{attempt_id}", json={"code": "x"})).status_code == 404
    assert (await client.post(f"/me/attempts/{attempt_id}/runs", json={})).status_code == 404
    assert (await client.post(f"/me/attempts/{attempt_id}/hints")).status_code == 404
    opened = await client.post(f"/me/assignments/{assignment_id}/items/{arias['item_id']}/open")
    assert opened.status_code == 404, "not Bella's class"


async def test_a_withdrawn_child_loses_the_class_work_but_it_is_kept(
    client, session: AsyncSession, signed_in_student
) -> None:
    aria = await signed_in_student()
    await today(client, session, aria)
    opened = await open_first(client)
    await client.post(
        f"/classes/{aria['class_id']}/enrolments/{aria['student_id']}/withdraw",
        headers=aria["headers"],
    )

    response = await client.patch(
        f"/me/attempts/{opened['leaves'][0]['attempt']['id']}", json={"code": "x"}
    )
    assert response.status_code == 404
    assert len((await session.exec(select(Attempt))).all()) == 1


async def test_a_problem_not_on_the_ladder_cannot_be_opened(
    client, session: AsyncSession, signed_in_student
) -> None:
    aria = await signed_in_student()
    setup = await today(client, session, aria)
    off_ladder = await published(
        client, aria["headers"], problem_doc(str(setup["concept"].id), title="Elsewhere")
    )
    lesson = (await client.get("/me/lesson")).json()

    response = await client.post(
        f"/me/assignments/{lesson['assignment_id']}/items/{off_ladder['id']}/open"
    )
    assert response.status_code == 404


async def test_a_teacher_is_not_a_student(client, signed_in) -> None:
    headers = await signed_in()
    assert (await client.get("/me/lesson", headers=headers)).status_code == 403


# --- what a child is sent ---------------------------------------------------------------


async def test_a_child_never_receives_the_solution_or_a_locked_hint(
    client, session: AsyncSession, signed_in_student
) -> None:
    aria = await signed_in_student()
    await today(client, session, aria)
    lesson = (await client.get("/me/lesson")).json()
    item_id = lesson["problems"][0]["item_id"]

    response = await client.post(f"/me/assignments/{lesson['assignment_id']}/items/{item_id}/open")

    assert "append(5)" not in response.text, "the reference solution leaked"
    assert "NUDGE" not in response.text and "WORKED" not in response.text
    leaf = response.json()["leaves"][0]
    assert leaf["attempt"]["code"] == "numbers = [1, 2, 3]\n", "starts from the starter code"
    assert leaf["hints"] == []
    assert leaf["tests"][1]["hidden"] is True


# --- ladders and classwork --------------------------------------------------------------


async def test_choosing_todays_lesson_opens_its_ladder(
    client, session: AsyncSession, signed_in_student
) -> None:
    aria = await signed_in_student()
    await today(client, session, aria, problems=2)

    lesson = (await client.get("/me/lesson")).json()
    assert lesson["lesson_title"] == "Append"
    assert [p["title"] for p in lesson["problems"]] == ["Problem 0", "Problem 1"]
    assert {p["progress"] for p in lesson["problems"]} == {"not_started"}


async def test_a_ladder_written_after_the_lesson_was_chosen_opens_too(
    client, session: AsyncSession, signed_in_student
) -> None:
    aria = await signed_in_student()
    headers = aria["headers"]
    tree = await lesson_in_course(client, headers)
    await client.put(
        f"/classes/{aria['class_id']}/curriculum",
        json={"course_id": tree["course"]["id"], "current_lesson_id": tree["lesson"]["id"]},
        headers=headers,
    )
    assert (await client.get("/me/lesson")).json()["problems"] == []

    concept = Concept(key="lists", label="Lists")
    session.add(concept)
    await session.flush()
    item = await published(client, headers, problem_doc(str(concept.id)))
    await client.put(
        f"/lessons/{tree['lesson']['id']}/ladder", json={"item_ids": [item["id"]]}, headers=headers
    )

    assert len((await client.get("/me/lesson")).json()["problems"]) == 1


async def test_coming_back_to_a_lesson_keeps_last_weeks_attempts(
    client, session: AsyncSession, signed_in_student
) -> None:
    aria = await signed_in_student()
    setup = await today(client, session, aria)
    opened = await open_first(client)
    await client.patch(
        f"/me/attempts/{opened['leaves'][0]['attempt']['id']}", json={"code": "mine"}
    )
    body = {"course_id": setup["course"]["id"], "current_lesson_id": None}
    await client.put(f"/classes/{aria['class_id']}/curriculum", json=body, headers=aria["headers"])
    body["current_lesson_id"] = setup["lesson"]["id"]
    await client.put(f"/classes/{aria['class_id']}/curriculum", json=body, headers=aria["headers"])

    again = await open_first(client)
    assert again["leaves"][0]["attempt"]["code"] == "mine"
    assert len((await session.exec(select(Assignment))).all()) == 1


async def test_only_published_problems_go_on_a_ladder(
    client, session: AsyncSession, signed_in, foreign_centre
) -> None:
    headers = await signed_in()
    concept = Concept(key="lists", label="Lists")
    session.add(concept)
    await session.flush()
    draft = (await client.post("/items", json=problem_doc(str(concept.id)), headers=headers)).json()
    theirs = Item(centre_id=foreign_centre["centre"].id, title="Theirs", status="published")
    session.add(theirs)
    await session.flush()
    tree = await lesson_in_course(client, headers)

    for item_id in (draft["id"], str(theirs.id)):
        response = await client.put(
            f"/lessons/{tree['lesson']['id']}/ladder", json={"item_ids": [item_id]}, headers=headers
        )
        assert response.status_code == 422, item_id


async def test_a_ladder_says_when_a_newer_version_exists(
    client, session: AsyncSession, signed_in
) -> None:
    headers = await signed_in()
    concept = Concept(key="lists", label="Lists")
    session.add(concept)
    await session.flush()
    v1 = await published(client, headers, problem_doc(str(concept.id)))
    tree = await lesson_in_course(client, headers)
    path = f"/lessons/{tree['lesson']['id']}/ladder"
    await client.put(path, json={"item_ids": [v1["id"]]}, headers=headers)

    v2 = (await client.post(f"/items/{v1['id']}/new-version", headers=headers)).json()
    await client.post(
        f"/items/{v2['id']}/publish",
        json={"verified_updated_at": v2["updated_at"]},
        headers=headers,
    )

    ladder = (await client.get(path, headers=headers)).json()
    assert ladder[0]["id"] == v1["id"], "the ladder keeps the version it was given"
    assert ladder[0]["status"] == "superseded"
    assert ladder[0]["newer_version_id"] == v2["id"]
    # And a superseded version already on the ladder may stay there when it is re-saved.
    assert (
        await client.put(path, json={"item_ids": [v1["id"]]}, headers=headers)
    ).status_code == 200


# --- attempts -------------------------------------------------------------------------


async def test_work_autosaves_and_a_check_records_progress(
    client, session: AsyncSession, signed_in_student
) -> None:
    aria = await signed_in_student()
    await today(client, session, aria)
    attempt_id = (await open_first(client))["leaves"][0]["attempt"]["id"]

    saved = await client.patch(f"/me/attempts/{attempt_id}", json={"code": SOLUTION})
    assert saved.json()["code"] == SOLUTION
    checked = await client.post(f"/me/attempts/{attempt_id}/runs", json={"passed": 2, "total": 2})
    assert checked.json() | {"code": None} == {
        "id": attempt_id,
        "code": None,
        "status": "in_progress",
        "run_count": 1,
        "last_passed": 2,
        "last_total": 2,
    }
    lesson = (await client.get("/me/lesson")).json()
    assert lesson["problems"][0]["progress"] == "passing"


async def test_a_run_report_must_be_coherent(
    client, session: AsyncSession, signed_in_student
) -> None:
    aria = await signed_in_student()
    await today(client, session, aria)
    attempt_id = (await open_first(client))["leaves"][0]["attempt"]["id"]

    for body in ({"passed": 3, "total": 2}, {"passed": 1}):
        response = await client.post(f"/me/attempts/{attempt_id}/runs", json=body)
        assert response.status_code == 422, body


async def test_opening_twice_reuses_the_attempt(
    client, session: AsyncSession, signed_in_student
) -> None:
    aria = await signed_in_student()
    await today(client, session, aria)
    first = await open_first(client)
    second = await open_first(client)
    assert first["leaves"][0]["attempt"]["id"] == second["leaves"][0]["attempt"]["id"]


# --- the hint ladder ------------------------------------------------------------------


async def test_a_hint_unlocks_after_a_run(client, session: AsyncSession, signed_in_student) -> None:
    aria = await signed_in_student()
    await today(client, session, aria)
    leaf = (await open_first(client))["leaves"][0]
    attempt_id = leaf["attempt"]["id"]
    assert leaf["next_hint"] | {"seconds_needed": 0} == {
        "level": 1,
        "available": False,
        "runs_needed": 1,
        "seconds_needed": 0,
    }

    refused = await client.post(f"/me/attempts/{attempt_id}/hints")
    assert refused.status_code == 409
    assert "Not yet" in refused.json()["detail"]

    await client.post(f"/me/attempts/{attempt_id}/runs", json={})
    unlocked = await client.post(f"/me/attempts/{attempt_id}/hints")
    assert unlocked.status_code == 200
    body = unlocked.json()
    assert body["hints"] == [{"level": 1, "body_md": "NUDGE: lists have a method"}]
    assert body["next_hint"]["level"] == 2 and body["next_hint"]["available"] is False
    assert "WORKED" not in unlocked.text


async def test_a_hint_unlocks_after_enough_time(
    client, session: AsyncSession, signed_in_student
) -> None:
    aria = await signed_in_student()
    await today(client, session, aria)
    attempt_id = (await open_first(client))["leaves"][0]["attempt"]["id"]
    attempt = await session.get(Attempt, uuid.UUID(attempt_id))
    attempt.created_at -= timedelta(minutes=3)
    session.add(attempt)
    await session.flush()

    assert (await client.post(f"/me/attempts/{attempt_id}/hints")).status_code == 200


async def test_the_last_hint_is_the_last(client, session: AsyncSession, signed_in_student) -> None:
    aria = await signed_in_student()
    await today(client, session, aria)
    attempt_id = (await open_first(client))["leaves"][0]["attempt"]["id"]
    for _ in range(3):
        await client.post(f"/me/attempts/{attempt_id}/runs", json={})
    assert (await client.post(f"/me/attempts/{attempt_id}/hints")).status_code == 200
    final = await client.post(f"/me/attempts/{attempt_id}/hints")
    assert "WORKED" in final.text

    assert (await client.post(f"/me/attempts/{attempt_id}/hints")).status_code == 409
