"""Homework, marking and progress — steps 8 to 10.

Authorisation first: another centre's homework is unreachable; a child sees only their
class's *set* homework, and never a mark their teacher has not released. Then the flow a
fortnight of real use depends on: set → work → hand in (late allowed, again allowed) →
mark (from saved work too) → release → read-only.
"""

import uuid
from datetime import timedelta

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.models import Assignment, Attempt, AuditLog, ProblemSet, Submission
from app.models.base import utcnow
from work_builders import SOLUTION, homework


async def open_leaf(client, assignment_id: str, item_id: str) -> dict:
    response = await client.post(f"/me/assignments/{assignment_id}/items/{item_id}/open")
    assert response.status_code == 200, response.text
    return response.json()["leaves"][0]


async def as_student(client, roster: dict) -> None:
    """Put the roster's child's cookie back on the client."""
    response = await client.post(
        "/auth/student/session",
        json={"code": roster["code"], "student_id": roster["student_id"], "pin": roster["pin"]},
    )
    assert response.status_code == 200, response.text


# --- authorisation --------------------------------------------------------------------


async def test_another_centres_homework_is_unreachable(
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
        mode="homework",
    )
    session.add(theirs)
    await session.flush()

    assert (
        await client.get(f"/classes/{foreign_centre['class'].id}/homework", headers=headers)
    ).status_code == 404
    for method, path in [
        ("get", f"/assignments/{theirs.id}"),
        ("patch", f"/assignments/{theirs.id}"),
        ("post", f"/assignments/{theirs.id}/set"),
        ("post", f"/assignments/{theirs.id}/release"),
        ("get", f"/assignments/{theirs.id}/marking"),
        ("get", f"/assignments/{theirs.id}/grid"),
        ("put", f"/assignments/{theirs.id}/notes/{foreign_centre['student'].id}"),
    ]:
        body = {"note": "x"} if method == "put" else ({} if method == "patch" else None)
        response = await client.request(method, path, json=body, headers=headers)
        assert response.status_code == 404, (method, path, response.text)


async def test_a_teacher_cannot_mark_another_centres_attempt(
    client, session: AsyncSession, signed_in, foreign_centre
) -> None:
    headers = await signed_in()
    response = await client.put(
        f"/attempts/{uuid.uuid4()}/mark", json={"runs": True, "correct": 2}, headers=headers
    )
    assert response.status_code == 404


async def test_a_draft_is_invisible_to_the_class(
    client, session: AsyncSession, signed_in_student
) -> None:
    aria = await signed_in_student()
    hw = await homework(client, session, aria, set_it=False)

    assert (await client.get(f"/me/homework/{hw['assignment']['id']}")).status_code == 404
    assert (await client.get("/me/home")).json()["homework"] == []


async def test_a_child_cannot_reach_another_classs_homework(
    client, session: AsyncSession, signed_in_student
) -> None:
    aria = await signed_in_student("Aria K")
    hw = await homework(client, session, aria)
    await signed_in_student("Bella N")  # another class

    assignment_id = hw["assignment"]["id"]
    assert (await client.get(f"/me/homework/{assignment_id}")).status_code == 404
    assert (await client.post(f"/me/homework/{assignment_id}/hand-in", json={})).status_code == 404


async def test_students_cannot_use_teacher_routes(
    client, session: AsyncSession, signed_in_student
) -> None:
    aria = await signed_in_student()
    hw = await homework(client, session, aria)
    assignment_id = hw["assignment"]["id"]

    for method, path in [
        ("get", f"/assignments/{assignment_id}/marking"),
        ("post", f"/assignments/{assignment_id}/release"),
        ("get", f"/assignments/{assignment_id}/grid"),
        ("get", "/snippets"),
    ]:
        assert (await client.request(method, path)).status_code == 403, path


async def test_an_unreleased_mark_is_invisible_to_the_child(
    client, session: AsyncSession, signed_in_student
) -> None:
    aria = await signed_in_student()
    hw = await homework(client, session, aria)
    assignment_id = hw["assignment"]["id"]
    leaf = await open_leaf(client, assignment_id, hw["items"][0]["id"])
    await client.post(f"/me/homework/{assignment_id}/hand-in", json={})
    await client.put(
        f"/attempts/{leaf['attempt']['id']}/mark",
        json={"runs": True, "correct": 2, "comment_md": "SECRET until release"},
        headers=aria["headers"],
    )

    sheet = await client.get(f"/me/homework/{assignment_id}")
    assert "SECRET" not in sheet.text
    assert sheet.json()["returned"] is False
    assert sheet.json()["leaves"][0]["feedback"] is None


# --- setting homework -----------------------------------------------------------------


async def test_set_homework_appears_on_the_childs_home(
    client, session: AsyncSession, signed_in_student
) -> None:
    aria = await signed_in_student()
    hw = await homework(client, session, aria, problems=2)

    cards = (await client.get("/me/home")).json()["homework"]
    assert len(cards) == 1
    assert cards[0] | {"assignment_id": None, "due_at": None} == {
        "assignment_id": None,
        "mode": "homework",
        "title": "Lists practice",
        "due_at": None,
        "closed": False,
        "problems": 2,
        "started": 0,
        "handed_in_at": None,
        "changed_since_hand_in": False,
        "late": False,
        "returned": False,
    }
    assert cards[0]["assignment_id"] == hw["assignment"]["id"]


async def test_setting_needs_problems_and_a_due_date(
    client, session: AsyncSession, signed_in_student
) -> None:
    aria = await signed_in_student()
    headers = aria["headers"]
    empty = (
        await client.post(
            f"/classes/{aria['class_id']}/homework", json={"title": "Empty"}, headers=headers
        )
    ).json()
    assert (
        await client.post(f"/assignments/{empty['id']}/set", headers=headers)
    ).status_code == 409

    hw = await homework(client, session, aria, set_it=False)
    await client.patch(
        f"/assignments/{hw['assignment']['id']}", json={"due_at": None}, headers=headers
    )
    response = await client.post(f"/assignments/{hw['assignment']['id']}/set", headers=headers)
    assert response.status_code == 409


async def test_once_set_the_problems_are_fixed_but_the_due_date_is_not(
    client, session: AsyncSession, signed_in_student
) -> None:
    aria = await signed_in_student()
    hw = await homework(client, session, aria)
    path = f"/assignments/{hw['assignment']['id']}"

    refused = await client.patch(path, json={"item_ids": []}, headers=aria["headers"])
    assert refused.status_code == 409
    moved = await client.patch(
        path, json={"due_at": "2099-02-01T16:00:00+11:00", "hints": False}, headers=aria["headers"]
    )
    assert moved.status_code == 200
    assert moved.json()["due_at"].startswith("2099-02-01")
    assert moved.json()["hints"] is False


async def test_homework_with_hints_off_offers_none(
    client, session: AsyncSession, signed_in_student
) -> None:
    aria = await signed_in_student()
    hw = await homework(client, session, aria, hints=False)
    leaf = await open_leaf(client, hw["assignment"]["id"], hw["items"][0]["id"])

    assert leaf["next_hint"] is None
    response = await client.post(f"/me/attempts/{leaf['attempt']['id']}/hints")
    assert response.status_code == 409


# --- handing in -----------------------------------------------------------------------


async def test_handing_in_snapshots_every_problem_even_unopened_ones(
    client, session: AsyncSession, signed_in_student
) -> None:
    aria = await signed_in_student()
    hw = await homework(client, session, aria, problems=2)
    assignment_id = hw["assignment"]["id"]
    leaf = await open_leaf(client, assignment_id, hw["items"][0]["id"])
    await client.patch(f"/me/attempts/{leaf['attempt']['id']}", json={"code": SOLUTION})

    sheet = (
        await client.post(
            f"/me/homework/{assignment_id}/hand-in",
            json={"results": [{"attempt_id": leaf["attempt"]["id"], "passed": 2, "total": 2}]},
        )
    ).json()

    assert sheet["handed_in_at"] is not None and sheet["late"] is False
    assert [entry["handed_in"] for entry in sheet["leaves"]] == [True, True]
    rows = (await session.exec(select(Submission).order_by(Submission.code))).all()
    assert {r.code for r in rows} == {SOLUTION, "numbers = [1, 2, 3]\n"}
    assert {(r.passed, r.total) for r in rows} == {(2, 2), (None, None)}


async def test_late_is_a_flag_not_a_refusal(
    client, session: AsyncSession, signed_in_student
) -> None:
    aria = await signed_in_student()
    hw = await homework(client, session, aria, due_at="2020-01-01T16:00:00+11:00")

    response = await client.post(f"/me/homework/{hw['assignment']['id']}/hand-in", json={})
    assert response.status_code == 200
    assert response.json()["late"] is True


async def test_handing_in_again_replaces_the_one_that_counts(
    client, session: AsyncSession, signed_in_student
) -> None:
    aria = await signed_in_student()
    hw = await homework(client, session, aria)
    assignment_id = hw["assignment"]["id"]
    leaf = await open_leaf(client, assignment_id, hw["items"][0]["id"])
    attempt_id = leaf["attempt"]["id"]
    await client.post(f"/me/homework/{assignment_id}/hand-in", json={})

    await client.patch(f"/me/attempts/{attempt_id}", json={"code": "better"})
    sheet = (await client.get(f"/me/homework/{assignment_id}")).json()
    assert sheet["leaves"][0]["changed_since_hand_in"] is True

    await client.post(f"/me/homework/{assignment_id}/hand-in", json={})
    marking = (
        await client.get(
            f"/assignments/{assignment_id}/marking/{hw['items'][0]['id']}",
            headers=aria["headers"],
        )
    ).json()
    assert marking["entries"][0]["code"] == "better"


async def test_a_closed_homework_takes_no_more_hand_ins(
    client, session: AsyncSession, signed_in_student
) -> None:
    aria = await signed_in_student()
    hw = await homework(client, session, aria)
    assignment_id = hw["assignment"]["id"]
    await client.post(f"/assignments/{assignment_id}/close", headers=aria["headers"])

    assert (await client.post(f"/me/homework/{assignment_id}/hand-in", json={})).status_code == 409
    await client.post(f"/assignments/{assignment_id}/reopen", headers=aria["headers"])
    assert (await client.post(f"/me/homework/{assignment_id}/hand-in", json={})).status_code == 200


# --- marking --------------------------------------------------------------------------


async def test_the_marking_view_shows_every_child_however_far_they_got(
    client, session: AsyncSession, student_on_roster
) -> None:
    aria = await student_on_roster("Aria K")
    hw = await homework(client, session, aria)
    assignment_id = hw["assignment"]["id"]
    item_id = hw["items"][0]["id"]
    await as_student(client, aria)
    leaf = await open_leaf(client, assignment_id, item_id)
    await client.patch(f"/me/attempts/{leaf['attempt']['id']}", json={"code": "draft"})
    # A second child in the same class, who never opens it.
    bella = (
        await client.post("/students", json={"display_name": "Bella N"}, headers=aria["headers"])
    ).json()
    await client.post(
        f"/classes/{aria['class_id']}/enrolments",
        json={"student_id": bella["id"]},
        headers=aria["headers"],
    )

    view = (
        await client.get(f"/assignments/{assignment_id}/marking/{item_id}", headers=aria["headers"])
    ).json()
    entries = {e["display_name"]: e for e in view["entries"]}
    assert (entries["Aria K"]["source"], entries["Aria K"]["code"]) == ("not_handed_in", "draft")
    assert (entries["Bella N"]["source"], entries["Bella N"]["code"]) == ("not_started", None)
    assert view["solution_code"] == SOLUTION
    assert any(t["hidden"] for t in view["tests"]), "the teacher's re-run needs hidden tests"


async def test_marking_saved_work_freezes_a_copy_first(
    client, session: AsyncSession, signed_in_student
) -> None:
    aria = await signed_in_student()
    hw = await homework(client, session, aria)
    leaf = await open_leaf(client, hw["assignment"]["id"], hw["items"][0]["id"])
    await client.patch(f"/me/attempts/{leaf['attempt']['id']}", json={"code": "unsent"})

    response = await client.put(
        f"/attempts/{leaf['attempt']['id']}/mark",
        json={"runs": False, "correct": 0, "approach": 1, "comment_md": "Nearly"},
        headers=aria["headers"],
    )
    assert response.status_code == 200
    copy = (await session.exec(select(Submission))).one()
    assert (copy.code, copy.source) == ("unsent", "saved_work")
    audit = (await session.exec(select(AuditLog).where(AuditLog.action == "mark.saved"))).one()
    assert audit.target_id == uuid.UUID(aria["student_id"])


async def test_a_mark_goes_stale_when_the_child_hands_in_again(
    client, session: AsyncSession, signed_in_student
) -> None:
    aria = await signed_in_student()
    hw = await homework(client, session, aria)
    assignment_id = hw["assignment"]["id"]
    item_id = hw["items"][0]["id"]
    leaf = await open_leaf(client, assignment_id, item_id)
    await client.post(f"/me/homework/{assignment_id}/hand-in", json={})
    await client.put(
        f"/attempts/{leaf['attempt']['id']}/mark",
        json={"runs": True, "correct": 1},
        headers=aria["headers"],
    )
    await client.patch(f"/me/attempts/{leaf['attempt']['id']}", json={"code": "fixed"})
    await client.post(f"/me/homework/{assignment_id}/hand-in", json={})

    view = (
        await client.get(f"/assignments/{assignment_id}/marking/{item_id}", headers=aria["headers"])
    ).json()
    assert view["entries"][0]["mark"]["stale"] is True


async def test_release_returns_comments_and_colours_and_locks_the_sheet(
    client, session: AsyncSession, signed_in_student
) -> None:
    aria = await signed_in_student()
    hw = await homework(client, session, aria, problems=2)
    assignment_id = hw["assignment"]["id"]
    first = await open_leaf(client, assignment_id, hw["items"][0]["id"])
    await client.post(f"/me/homework/{assignment_id}/hand-in", json={})
    sheet = (await client.get(f"/me/homework/{assignment_id}")).json()
    second_attempt = sheet["leaves"][1]["attempt_id"]
    headers = aria["headers"]
    await client.put(
        f"/attempts/{first['attempt']['id']}/mark",
        json={"runs": True, "correct": 2, "approach": 2, "comment_md": "Lovely"},
        headers=headers,
    )
    await client.put(
        f"/attempts/{second_attempt}/mark",
        json={"runs": True, "correct": 1, "approach": 1, "comment_md": "Check the last line"},
        headers=headers,
    )
    await client.put(
        f"/assignments/{assignment_id}/notes/{aria['student_id']}",
        json={"note": "Great effort this week!"},
        headers=headers,
    )

    released = (await client.post(f"/assignments/{assignment_id}/release", headers=headers)).json()
    assert released == {"marks_released": 2, "notes_released": 1}

    back = await client.get(f"/me/homework/{assignment_id}")
    body = back.json()
    assert body["returned"] is True
    assert body["note"] == "Great effort this week!"
    assert [leaf["feedback"]["outcome"] for leaf in body["leaves"]] == ["good", "not_yet"]
    assert [leaf["feedback"]["comment_md"] for leaf in body["leaves"]] == [
        "Lovely",
        "Check the last line",
    ]
    # Never a number in front of a child.
    assert '"correct"' not in back.text and '"approach"' not in back.text

    attempt_id = first["attempt"]["id"]
    assert (await client.patch(f"/me/attempts/{attempt_id}", json={"code": "x"})).status_code == 409
    assert (await client.post(f"/me/homework/{assignment_id}/hand-in", json={})).status_code == 409


async def test_snippets_are_shared_counted_and_scoped(
    client, session: AsyncSession, signed_in_student, signed_in
) -> None:
    aria = await signed_in_student()
    hw = await homework(client, session, aria)
    headers = aria["headers"]
    snippet = (
        await client.post(
            "/snippets",
            json={"body": "Use == to compare, = to assign", "concept_id": str(hw["concept"].id)},
            headers=headers,
        )
    ).json()
    leaf = await open_leaf(client, hw["assignment"]["id"], hw["items"][0]["id"])
    await client.put(
        f"/attempts/{leaf['attempt']['id']}/mark",
        json={"runs": True, "correct": 1, "snippet_ids": [snippet["id"]]},
        headers=headers,
    )

    listed = (await client.get("/snippets?q=compare", headers=headers)).json()
    assert [(s["id"], s["use_count"]) for s in listed] == [(snippet["id"], 1)]
    sam = await client.get("/snippets", headers=await signed_in("sam@example.com"))
    assert [s["id"] for s in sam.json()] == [snippet["id"]], "the whole centre shares the bank"


# --- progress -------------------------------------------------------------------------


async def test_the_homework_grid_follows_a_child_through_the_week(
    client, session: AsyncSession, signed_in_student
) -> None:
    aria = await signed_in_student()
    hw = await homework(client, session, aria)
    assignment_id = hw["assignment"]["id"]
    grid_path = f"/assignments/{assignment_id}/grid"

    async def cell():
        return (await client.get(grid_path, headers=aria["headers"])).json()["rows"][0]["cells"][0]

    assert (await cell())["status"] == "not_started"
    leaf = await open_leaf(client, assignment_id, hw["items"][0]["id"])
    assert (await cell())["status"] == "started"
    await client.post(f"/me/attempts/{leaf['attempt']['id']}/runs", json={"passed": 2, "total": 2})
    assert (await cell())["status"] == "passing"
    await client.post(f"/me/homework/{assignment_id}/hand-in", json={})
    assert (await cell())["status"] == "handed_in"
    await client.put(
        f"/attempts/{leaf['attempt']['id']}/mark",
        json={"runs": True, "correct": 2},
        headers=aria["headers"],
    )
    assert (await cell())["status"] == "marked"
    await client.post(f"/assignments/{assignment_id}/release", headers=aria["headers"])
    assert (await cell())["status"] == "returned"


async def test_the_history_page_shows_the_teacher_the_numbers(
    client, session: AsyncSession, signed_in_student
) -> None:
    aria = await signed_in_student()
    hw = await homework(client, session, aria)
    leaf = await open_leaf(client, hw["assignment"]["id"], hw["items"][0]["id"])
    await client.put(
        f"/attempts/{leaf['attempt']['id']}/mark",
        json={"runs": True, "correct": 2, "approach": 1},
        headers=aria["headers"],
    )

    history = (
        await client.get(f"/students/{aria['student_id']}/history", headers=aria["headers"])
    ).json()
    assert history["homework"][0]["questions"] == [
        {"title": "Homework 0", "correct": 2, "approach": 1, "released": False}
    ]


async def test_late_hand_ins_show_on_the_grid(
    client, session: AsyncSession, signed_in_student
) -> None:
    aria = await signed_in_student()
    hw = await homework(client, session, aria, due_at="2099-01-01T16:00:00+11:00")
    assignment_id = hw["assignment"]["id"]
    assignment = await session.get(Assignment, uuid.UUID(assignment_id))
    assignment.due_at = utcnow() - timedelta(hours=1)
    session.add(assignment)
    await session.flush()
    await client.post(f"/me/homework/{assignment_id}/hand-in", json={})

    grid = (await client.get(f"/assignments/{assignment_id}/grid", headers=aria["headers"])).json()
    assert grid["rows"][0]["cells"][0] == {"status": "handed_in", "late": True}
    assert len((await session.exec(select(Attempt))).all()) == 1


async def test_an_illegal_move_says_what_state_it_is_in(
    client, session: AsyncSession, signed_in_student
) -> None:
    """Regression: a status read back from the database is a str, not the enum."""
    aria = await signed_in_student()
    hw = await homework(client, session, aria, set_it=False)
    response = await client.post(
        f"/assignments/{hw['assignment']['id']}/close", headers=aria["headers"]
    )
    assert response.status_code == 409
    assert response.json()["detail"] == "This homework is draft"
