"""Quizzes: one clock for the class, the quiz as the only reachable work, and everyone's
work handed in exactly once when it ends.

Authorisation first, then the clock: Start switches the class over, Stop ends it, and an
end noticed late (the timer lost to a restart) is still finalised — once.
"""

import uuid
from datetime import timedelta

import pytest
from sqlmodel import select, update
from sqlmodel.ext.asyncio.session import AsyncSession

from app.live.hub import hub
from app.models import Assignment, Attempt, Item, ProblemSet, QuizSitting, Submission
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
    # The timer was lost to a restart.
    quiz.ends_at = quiz.hand_in_at = utcnow() - timedelta(seconds=1)
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


# --- the clock and the hand-in are two moments -------------------------------------------


async def _past_the_clock(session, quiz_id: str, *, grace_seconds: int) -> None:
    """The clock has just read 0:00; the hand-in is this far off."""
    quiz = await session.get(Assignment, uuid.UUID(quiz_id))
    quiz.ends_at = utcnow() - timedelta(seconds=1)
    quiz.hand_in_at = utcnow() + timedelta(seconds=grace_seconds)
    session.add(quiz)
    await session.flush()


async def test_a_save_after_the_clock_but_before_the_hand_in_is_handed_in(
    client, session, signed_in_student
) -> None:
    aria = await signed_in_student()
    q = await make_quiz(client, session, aria)
    quiz_id = q["quiz"]["id"]
    await start(client, aria, quiz_id)
    leaf = (await client.post(f"/me/assignments/{quiz_id}/items/{q['item']['id']}/open")).json()[
        "leaves"
    ][0]
    await _past_the_clock(session, quiz_id, grace_seconds=30)

    saved = await client.patch(f"/me/attempts/{leaf['attempt']['id']}", json={"code": "last words"})
    assert saved.status_code == 200, "the page's last save must still land"
    assert (await client.get(f"/quizzes/{quiz_id}", headers=aria["headers"])).json()[
        "status"
    ] == "open"

    # Now the hand-in comes due.
    quiz = await session.get(Assignment, uuid.UUID(quiz_id))
    quiz.hand_in_at = utcnow() - timedelta(seconds=1)
    session.add(quiz)
    await session.flush()
    assert (await client.get(f"/quizzes/{quiz_id}", headers=aria["headers"])).json()[
        "status"
    ] == "closed"
    assert [s.code for s in (await session.exec(select(Submission))).all()] == ["last words"]
    refused = await client.patch(f"/me/attempts/{leaf['attempt']['id']}", json={"code": "too late"})
    assert refused.status_code in (404, 409)


async def test_stop_stops_the_clock_now_and_leaves_time_to_save(
    client, session, signed_in_student, pushed, test_settings
) -> None:
    aria = await signed_in_student()
    q = await make_quiz(client, session, aria)
    quiz_id = q["quiz"]["id"]
    await start(client, aria, quiz_id)
    test_settings.quiz_hand_in_grace_seconds = 30

    stopped = (await client.post(f"/quizzes/{quiz_id}/stop", headers=aria["headers"])).json()

    assert (stopped["status"], stopped["running"]) == ("open", True), "not handed in yet"
    assert {m["type"] for m in pushed} >= {"quiz_ending"}
    quiz = await session.get(Assignment, uuid.UUID(quiz_id))
    assert quiz.ends_at <= utcnow() < quiz.hand_in_at


async def test_finalising_rereads_the_row_so_a_racing_caller_hands_in_once(
    client, session, signed_in_student
) -> None:
    """Two callers both read the quiz as open. The second to get the lock must see it closed,
    not the copy its session already holds."""
    from app.quiz import finalise_if_due

    aria = await signed_in_student()
    q = await make_quiz(client, session, aria)
    await start(client, aria, q["quiz"]["id"])
    quiz = await session.get(Assignment, uuid.UUID(q["quiz"]["id"]))
    quiz.ends_at = quiz.hand_in_at = utcnow() - timedelta(seconds=1)
    session.add(quiz)
    await session.flush()
    # Another session closes it behind this one's back: the object here still says "open".
    await session.exec(
        update(Assignment)
        .where(Assignment.id == quiz.id)
        .values(status="closed")
        .execution_options(synchronize_session=False)
    )
    assert quiz.status == "open"

    assert await finalise_if_due(session, quiz) is False
    assert (await session.exec(select(Submission))).all() == []


# --- only once it has finished: marking --------------------------------------------------


async def test_a_running_quiz_cannot_be_marked_or_given_back(
    client, session, signed_in_student
) -> None:
    aria = await signed_in_student()
    q = await make_quiz(client, session, aria)
    quiz_id = q["quiz"]["id"]
    await start(client, aria, quiz_id)
    leaf = (await client.post(f"/me/assignments/{quiz_id}/items/{q['item']['id']}/open")).json()[
        "leaves"
    ][0]
    headers = aria["headers"]

    assert (await client.get(f"/assignments/{quiz_id}/marking", headers=headers)).status_code == 409
    released = await client.post(f"/assignments/{quiz_id}/release", headers=headers)
    assert released.status_code == 409
    marked = await client.put(
        f"/attempts/{leaf['attempt']['id']}/mark",
        json={"runs": True, "correct": 2, "comment_md": "early"},
        headers=headers,
    )
    assert marked.status_code == 409
    sheet = (await client.get(f"/me/homework/{quiz_id}")).json()
    assert sheet["returned"] is False


# --- taking a child out mid-quiz ---------------------------------------------------------


async def test_a_child_removed_mid_quiz_has_their_work_handed_in(
    client, session, signed_in_student
) -> None:
    aria = await signed_in_student()
    q = await make_quiz(client, session, aria)
    quiz_id = q["quiz"]["id"]
    await start(client, aria, quiz_id)
    leaf = (await client.post(f"/me/assignments/{quiz_id}/items/{q['item']['id']}/open")).json()[
        "leaves"
    ][0]
    await client.patch(f"/me/attempts/{leaf['attempt']['id']}", json={"code": SOLUTION})

    student_id = (await session.exec(select(Attempt.student_id))).first()
    withdrawn = await client.post(
        f"/classes/{aria['class_id']}/enrolments/{student_id}/withdraw", headers=aria["headers"]
    )
    assert withdrawn.status_code == 200, withdrawn.text

    assert [s.code for s in (await session.exec(select(Submission))).all()] == [SOLUTION]


# --- I'm finished, and leaving the page --------------------------------------------------


async def test_finished_keeps_them_in_the_quiz_and_able_to_edit(
    client, session, signed_in_student
) -> None:
    aria = await signed_in_student()
    q = await make_quiz(client, session, aria)
    quiz_id = q["quiz"]["id"]
    await start(client, aria, quiz_id)
    leaf = (await client.post(f"/me/assignments/{quiz_id}/items/{q['item']['id']}/open")).json()[
        "leaves"
    ][0]

    assert (await client.post(f"/me/quiz/{quiz_id}/finish")).json()["finished"] is True
    assert (await client.get("/me/quiz")).json()["finished"] is True, "stays in force on reload"
    # Nothing handed in, the answers still open, and everything else still closed.
    assert (await session.exec(select(Submission))).all() == []
    saved = await client.patch(f"/me/attempts/{leaf['attempt']['id']}", json={"code": "better"})
    assert saved.status_code == 200
    assert (await client.post("/me/documents", json={"title": "x.py"})).status_code == 409

    sittings = (await client.get(f"/quizzes/{quiz_id}/sittings", headers=aria["headers"])).json()
    assert sittings[0]["finished_at"] is not None

    assert (await client.post(f"/me/quiz/{quiz_id}/resume")).json()["finished"] is False
    assert (await client.get("/me/quiz")).json()["finished"] is False


async def test_finish_and_away_only_for_the_quiz_running_for_this_child(
    client, session, signed_in_student
) -> None:
    aria = await signed_in_student()
    q = await make_quiz(client, session, aria)
    quiz_id = q["quiz"]["id"]  # still a draft
    assert (await client.post(f"/me/quiz/{quiz_id}/finish")).status_code == 409
    away = await client.post(f"/me/quiz/{quiz_id}/away", json={"away": True})
    assert away.status_code == 409


async def test_time_away_is_counted_and_stops_at_the_end_of_the_clock(
    client, session, signed_in_student
) -> None:
    aria = await signed_in_student()
    q = await make_quiz(client, session, aria)
    quiz_id = q["quiz"]["id"]
    await start(client, aria, quiz_id)

    assert (await client.post(f"/me/quiz/{quiz_id}/away", json={"away": True})).status_code == 204
    # A second report of the same absence is not a second absence.
    await client.post(f"/me/quiz/{quiz_id}/away", json={"away": True})
    sitting = (await session.exec(select(QuizSitting))).one()
    assert (sitting.away_count, sitting.left_at is not None) == (1, True)

    # They left 90 seconds ago and never came back; the clock ran out 30 seconds ago.
    sitting.left_at = utcnow() - timedelta(seconds=90)
    session.add(sitting)
    quiz = await session.get(Assignment, uuid.UUID(quiz_id))
    quiz.ends_at = quiz.hand_in_at = utcnow() - timedelta(seconds=30)
    session.add(quiz)
    await session.flush()

    rows = (await client.get(f"/quizzes/{quiz_id}/sittings", headers=aria["headers"])).json()
    assert rows[0]["away_now"] is False, "the quiz closing ends the absence"
    assert rows[0]["away_seconds"] == 60


async def test_files_and_folders_stay_locked_during_a_quiz(
    client, session, signed_in_student
) -> None:
    aria = await signed_in_student()
    document = (await client.post("/me/documents", json={"title": "mine.py"})).json()
    q = await make_quiz(client, session, aria)
    await start(client, aria, q["quiz"]["id"])

    assert (await client.post("/me/documents", json={"title": "x.py"})).status_code == 409
    archive = await client.post(f"/me/documents/{document['id']}/archive")
    assert archive.status_code == 409
    restore = await client.post(f"/me/documents/{document['id']}/restore")
    assert restore.status_code == 409
    assert (await client.post("/me/folders", json={"name": "f"})).status_code == 409


# --- the teacher's views of a running quiz -----------------------------------------------


async def test_running_quizzes_are_the_centres_own_and_for_teachers_only(
    client, session, signed_in_student, foreign_centre
) -> None:
    aria = await signed_in_student()
    their_set = ProblemSet(centre_id=foreign_centre["centre"].id, title="Theirs")
    session.add(their_set)
    await session.flush()
    session.add(
        Assignment(
            centre_id=foreign_centre["centre"].id,
            class_id=foreign_centre["class"].id,
            set_id=their_set.id,
            title="Theirs",
            mode="quiz",
            status="open",
            ends_at=utcnow() + timedelta(minutes=10),
        )
    )
    await session.flush()
    q = await make_quiz(client, session, aria)
    assert (await client.get("/quizzes/running", headers=aria["headers"])).json() == []
    await start(client, aria, q["quiz"]["id"])

    running = (await client.get("/quizzes/running", headers=aria["headers"])).json()
    assert [r["id"] for r in running] == [q["quiz"]["id"]]
    assert running[0]["class_id"] == aria["class_id"]
    assert (await client.get("/quizzes/running")).status_code == 403, "a child, with their cookie"


async def test_another_centres_sittings_and_answers_are_unreachable(
    client, session, signed_in, foreign_centre
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
        status="open",
    )
    session.add(theirs)
    await session.flush()
    their_item = Item(centre_id=foreign_centre["centre"].id, title="Theirs", prompt_md="SECRET")
    session.add(their_item)
    await session.flush()
    their_attempt = Attempt(
        centre_id=foreign_centre["centre"].id,
        student_id=foreign_centre["student"].id,
        assignment_id=theirs.id,
        item_id=their_item.id,
    )
    session.add(their_attempt)
    await session.flush()
    someone = uuid.uuid4()
    for path in [
        f"/quizzes/{theirs.id}/sittings",
        f"/quizzes/{theirs.id}/students/{someone}/answers",
        f"/attempts/{their_attempt.id}/question",
        f"/classes/{foreign_centre['class'].id}/todays-work",
    ]:
        assert (await client.get(path, headers=headers)).status_code == 404, path


async def test_a_teacher_goes_through_what_a_child_has_saved_and_a_child_cannot(
    client, session, signed_in_student
) -> None:
    from test_mcq import concept, mcq, published_mcq

    aria = await signed_in_student()
    headers = aria["headers"]
    c = await concept(session, "answers")
    question = await published_mcq(client, headers, mcq(str(c.id)))
    q = await make_quiz(client, session, aria)
    # Both a code question and a multiple-choice one.
    await client.patch(
        f"/quizzes/{q['quiz']['id']}",
        json={"item_ids": [q["item"]["id"], question["id"]]},
        headers=headers,
    )
    quiz_id = q["quiz"]["id"]
    await start(client, aria, quiz_id)
    code = (await client.post(f"/me/assignments/{quiz_id}/items/{q['item']['id']}/open")).json()
    choice = (await client.post(f"/me/assignments/{quiz_id}/items/{question['id']}/open")).json()
    # What a child is sent carries no key, even during a quiz.
    assert "correct" not in str(choice) and "SECRET" not in str(choice)
    await client.patch(f"/me/attempts/{code['leaves'][0]['attempt']['id']}", json={"code": "x = 1"})
    await client.put(
        f"/me/attempts/{choice['leaves'][0]['attempt']['id']}/choice", json={"choice": 1}
    )

    student_id = (await session.exec(select(Attempt.student_id))).first()
    path = f"/quizzes/{quiz_id}/students/{student_id}/answers"
    answers = (await client.get(path, headers=headers)).json()
    assert [(a["kind"], a["answered"]) for a in answers] == [("code", True), ("mcq", True)]
    assert answers[0]["code"] == "x = 1"
    assert answers[1]["choice"] == 1
    assert answers[1]["prompt_md"] == "What does `list(range(5))` print?"
    assert [o["correct"] for o in answers[1]["options"]] == [True, False, False]

    assert (await client.get(path)).status_code == 403, "a child, with their cookie"


async def test_blank_titles_are_refused(client, session, signed_in_student) -> None:
    aria = await signed_in_student()
    q = await make_quiz(client, session, aria)
    created = await client.post(
        f"/classes/{aria['class_id']}/quizzes",
        json={"title": "   ", "item_ids": []},
        headers=aria["headers"],
    )
    assert created.status_code == 422
    patched = await client.patch(
        f"/quizzes/{q['quiz']['id']}", json={"title": "   "}, headers=aria["headers"]
    )
    assert patched.status_code == 422


async def test_a_draft_offers_a_newer_version_and_can_still_be_saved_without_it(
    client, session, signed_in_student
) -> None:
    aria = await signed_in_student()
    headers = aria["headers"]
    q = await make_quiz(client, session, aria)
    old = q["item"]["id"]
    new = (await client.post(f"/items/{old}/new-version", json={}, headers=headers)).json()
    published = await client.post(
        f"/items/{new['id']}/publish",
        json={"verified_updated_at": new["updated_at"]},
        headers=headers,
    )
    assert published.status_code == 200, published.text

    read = (await client.get(f"/quizzes/{q['quiz']['id']}", headers=headers)).json()
    assert read["questions"][0]["newer_version_id"] == new["id"]
    assert read["questions"][0]["superseded"] is True
    kept = await client.patch(
        f"/quizzes/{q['quiz']['id']}", json={"item_ids": [old]}, headers=headers
    )
    assert kept.status_code == 200, kept.text


async def test_a_sat_quiz_is_on_the_childs_list_handed_in(
    client, session, signed_in_student
) -> None:
    aria = await signed_in_student()
    q = await make_quiz(client, session, aria)
    await start(client, aria, q["quiz"]["id"])
    await client.post(f"/quizzes/{q['quiz']['id']}/stop", headers=aria["headers"])
    cards = (await client.get("/me/home")).json()["homework"]
    assert [(c["mode"], c["returned"], c["handed_in_at"] is not None) for c in cards] == [
        ("quiz", False, True)
    ]


async def test_erasing_takes_a_childs_sittings_with_it(client, session, signed_in_student) -> None:
    from app.erase import erase_student

    aria = await signed_in_student()
    q = await make_quiz(client, session, aria)
    await start(client, aria, q["quiz"]["id"])
    await client.post(f"/me/quiz/{q['quiz']['id']}/finish")
    sitting = (await session.exec(select(QuizSitting))).one()
    await erase_student(session, sitting.student_id)
    assert (await session.exec(select(QuizSitting))).all() == []
