"""Quizzes: one clock for the class, the quiz as the only reachable work, and everyone's
work handed in exactly once when it ends.

Authorisation first, then the clock: Start switches the class over, Stop ends it, and an
end noticed late (the timer lost to a restart) is still finalised — once.
"""

import uuid
from datetime import timedelta

import pytest
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.live.hub import hub
from app.models import Assignment, ProblemSet, Submission
from app.models.base import utcnow
from work_builders import SOLUTION, homework, problem_doc, published


@pytest.fixture
def pushed(monkeypatch):
    """What the hub would have pushed to children, by class."""
    sent: list[dict] = []

    async def to_students(class_id, message):
        sent.append(message)

    monkeypatch.setattr(hub, "to_students", to_students)
    return sent


async def make_quiz(client, session, roster, *, checks=False, minutes=20) -> dict:
    from app.models import Concept

    concept = Concept(key=f"q-{uuid.uuid4().hex[:6]}", label="Lists")
    session.add(concept)
    await session.flush()
    item = await published(client, roster["headers"], problem_doc(str(concept.id)))
    created = await client.post(
        f"/classes/{roster['class_id']}/quizzes",
        json={
            "title": "Lists quiz",
            "item_ids": [item["id"]],
            "duration_minutes": minutes,
            "checks": checks,
        },
        headers=roster["headers"],
    )
    assert created.status_code == 201, created.text
    return {"quiz": created.json(), "item": item}


async def start(client, roster, quiz_id):
    response = await client.post(f"/quizzes/{quiz_id}/start", headers=roster["headers"])
    assert response.status_code == 200, response.text
    return response.json()


# --- authorisation ------------------------------------------------------------------------


async def test_another_centres_quiz_is_unreachable(
    client, session: AsyncSession, signed_in, foreign_centre
) -> None:
    headers = await signed_in()
    their_set = ProblemSet(centre_id=foreign_centre["centre"].id, title="Theirs")
    session.add(their_set)
    await session.flush()
    theirs = Assignment(
        centre_id=foreign_centre["centre"].id,
        class_id=foreign_centre["class"].id,
        set_id=their_set.id,
        title="Theirs",
        mode="quiz",
        status="draft",
    )
    session.add(theirs)
    await session.flush()

    for method, path in [
        ("get", f"/quizzes/{theirs.id}"),
        ("post", f"/quizzes/{theirs.id}/start"),
        ("post", f"/quizzes/{theirs.id}/stop"),
        ("get", f"/classes/{foreign_centre['class'].id}/quizzes"),
    ]:
        assert (await client.request(method, path, headers=headers)).status_code == 404, path


async def test_a_student_cannot_start_a_quiz(client, session, signed_in_student) -> None:
    aria = await signed_in_student()
    q = await make_quiz(client, session, aria)
    assert (await client.post(f"/quizzes/{q['quiz']['id']}/start")).status_code == 403


# --- setting and starting -------------------------------------------------------------------


async def test_a_new_quiz_is_a_draft_with_quiz_rules(client, session, signed_in_student) -> None:
    aria = await signed_in_student()
    q = (await make_quiz(client, session, aria))["quiz"]
    assert (q["status"], q["running"], q["checks"], q["duration_minutes"]) == (
        "draft",
        False,
        False,
        20,
    )
    assert (await client.get("/me/quiz")).json() is None, "a draft is invisible"


async def test_start_switches_the_class_over_with_quiz_rules(
    client, session, signed_in_student, pushed
) -> None:
    aria = await signed_in_student()
    q = await make_quiz(client, session, aria)
    started = await start(client, aria, q["quiz"]["id"])

    assert started["running"] is True
    assert pushed and pushed[0]["type"] == "quiz_started"
    active = (await client.get("/me/quiz")).json()
    assert active["assignment_id"] == q["quiz"]["id"]

    opened = (
        await client.post(f"/me/assignments/{q['quiz']['id']}/items/{q['item']['id']}/open")
    ).json()
    assert (opened["mode"], opened["completions"], opened["checks"]) == ("quiz", False, False)
    assert opened["leaves"][0]["next_hint"] is None, "no hints in a quiz"


async def test_one_quiz_at_a_time_per_class(client, session, signed_in_student) -> None:
    aria = await signed_in_student()
    first = await make_quiz(client, session, aria)
    second = await make_quiz(client, session, aria)
    await start(client, aria, first["quiz"]["id"])
    response = await client.post(f"/quizzes/{second['quiz']['id']}/start", headers=aria["headers"])
    assert response.status_code == 409


async def test_a_started_quiz_cannot_be_edited(client, session, signed_in_student) -> None:
    aria = await signed_in_student()
    q = await make_quiz(client, session, aria)
    await start(client, aria, q["quiz"]["id"])
    response = await client.patch(
        f"/quizzes/{q['quiz']['id']}", json={"duration_minutes": 99}, headers=aria["headers"]
    )
    assert response.status_code == 409


# --- lock-down ----------------------------------------------------------------------------------


async def test_while_a_quiz_runs_it_is_the_only_work_a_child_can_change(
    client, session, signed_in_student
) -> None:
    aria = await signed_in_student()
    hw = await homework(client, session, aria)
    hw_leaf = (
        await client.post(
            f"/me/assignments/{hw['assignment']['id']}/items/{hw['items'][0]['id']}/open"
        )
    ).json()["leaves"][0]
    file_id = (await client.post("/me/documents", json={})).json()["id"]
    q = await make_quiz(client, session, aria)
    await start(client, aria, q["quiz"]["id"])

    assert (
        await client.patch(f"/me/attempts/{hw_leaf['attempt']['id']}", json={"code": "x"})
    ).status_code == 409
    assert (
        await client.patch(f"/me/documents/{file_id}", json={"content": "x"})
    ).status_code == 409
    assert (
        await client.post(
            f"/me/assignments/{hw['assignment']['id']}/items/{hw['items'][0]['id']}/open"
        )
    ).status_code == 409

    quiz_leaf = (
        await client.post(f"/me/assignments/{q['quiz']['id']}/items/{q['item']['id']}/open")
    ).json()["leaves"][0]
    saved = await client.patch(
        f"/me/attempts/{quiz_leaf['attempt']['id']}", json={"code": SOLUTION}
    )
    assert saved.status_code == 200


# --- the end ------------------------------------------------------------------------------------


async def test_stop_hands_in_everyones_work_and_frees_the_class(
    client, session, student_on_roster, pushed
) -> None:
    from test_homework import as_student

    aria = await student_on_roster("Aria K")
    # A second child who never opens the quiz still gets a hand-in (of the starter code).
    bella = (
        await client.post("/students", json={"display_name": "Bella N"}, headers=aria["headers"])
    ).json()
    await client.post(
        f"/classes/{aria['class_id']}/enrolments",
        json={"student_id": bella["id"]},
        headers=aria["headers"],
    )
    q = await make_quiz(client, session, aria)
    await start(client, aria, q["quiz"]["id"])
    await as_student(client, aria)
    leaf = (
        await client.post(f"/me/assignments/{q['quiz']['id']}/items/{q['item']['id']}/open")
    ).json()["leaves"][0]
    await client.patch(f"/me/attempts/{leaf['attempt']['id']}", json={"code": SOLUTION})

    stopped = (
        await client.post(f"/quizzes/{q['quiz']['id']}/stop", headers=aria["headers"])
    ).json()

    assert (stopped["status"], stopped["running"]) == ("closed", False)
    codes = sorted(s.code for s in (await session.exec(select(Submission))).all())
    assert codes == sorted([SOLUTION, "numbers = [1, 2, 3]\n"])
    assert {m["type"] for m in pushed} >= {"quiz_started", "quiz_ended"}
    assert (await client.get("/me/quiz")).json() is None
    late = await client.patch(f"/me/attempts/{leaf['attempt']['id']}", json={"code": "after"})
    assert late.status_code in (404, 409)


async def test_an_end_noticed_late_is_still_finalised_once(
    client, session, signed_in_student
) -> None:
    aria = await signed_in_student()
    q = await make_quiz(client, session, aria)
    await start(client, aria, q["quiz"]["id"])
    quiz = await session.get(Assignment, uuid.UUID(q["quiz"]["id"]))
    quiz.ends_at = utcnow() - timedelta(seconds=1)  # the timer was lost to a restart
    session.add(quiz)
    await session.flush()

    for _ in range(3):
        read = (await client.get(f"/quizzes/{q['quiz']['id']}", headers=aria["headers"])).json()
        assert read["status"] == "closed"
    assert len((await session.exec(select(Submission))).all()) == 1


async def test_a_quiz_is_marked_and_given_back_like_homework(
    client, session, signed_in_student
) -> None:
    aria = await signed_in_student()
    q = await make_quiz(client, session, aria)
    await start(client, aria, q["quiz"]["id"])
    leaf = (
        await client.post(f"/me/assignments/{q['quiz']['id']}/items/{q['item']['id']}/open")
    ).json()["leaves"][0]
    await client.post(f"/quizzes/{q['quiz']['id']}/stop", headers=aria["headers"])

    marked = await client.put(
        f"/attempts/{leaf['attempt']['id']}/mark",
        json={"runs": True, "correct": 2, "comment_md": "Well done"},
        headers=aria["headers"],
    )
    assert marked.status_code == 200
    await client.post(f"/assignments/{q['quiz']['id']}/release", headers=aria["headers"])

    sheet = (await client.get(f"/me/homework/{q['quiz']['id']}")).json()
    assert sheet["returned"] is True
    assert sheet["leaves"][0]["feedback"]["comment_md"] == "Well done"
    cards = (await client.get("/me/home")).json()["homework"]
    assert [(c["mode"], c["returned"]) for c in cards] == [("quiz", True)]
