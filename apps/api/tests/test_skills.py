"""Skills: how strong each child is on each concept (Ken, 21 Nov 2026; `app/skills.py`).

The rules first, on hand-made evidence, then the routes — and the routes' tenancy, since
these are children's results.
"""

import uuid
from datetime import UTC, datetime, timedelta

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.models import (
    AssignmentMode,
    Attempt,
    AttemptStatus,
    AuditLog,
    Class,
    Concept,
    Event,
    EventType,
)
from app.skills import Evidence, RevisitSettings, _outcome, assess, skill_tree

NOW = datetime(2026, 11, 21, 12, tzinfo=UTC)
ALL = RevisitSettings()
A, B, C = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()


def ev(
    concept: uuid.UUID = A,
    *,
    outcome: float = 1.0,
    mode: AssignmentMode = AssignmentMode.HOMEWORK,
    days_ago: float = 0,
    hints: int = 0,
    helped: bool = False,
) -> Evidence:
    return Evidence(
        attempt_id=uuid.uuid4(),
        student_id=uuid.uuid4(),
        assignment_id=uuid.uuid4(),
        assignment_title="Practice",
        mode=mode,
        item_id=uuid.uuid4(),
        item_title="A problem",
        concept_ids=frozenset({concept}),
        outcome=outcome,
        hints=hints,
        helped=helped,
        marked=False,
        at=NOW - timedelta(days=days_ago),
    )


# --- the rules --------------------------------------------------------------------------


def test_secure_needs_passes_on_two_different_days() -> None:
    same_day = assess([ev(days_ago=1), ev(days_ago=1)], ALL, NOW, covered=True)
    assert (same_day.level, same_day.confident) == ("learning", True)
    two_days = assess([ev(days_ago=8), ev(days_ago=1)], ALL, NOW, covered=True)
    assert two_days.level == "secure"


def test_help_and_hints_count_for_less() -> None:
    # A homework miss outweighs one classwork pass made with hints…
    helped = assess(
        [
            ev(mode=AssignmentMode.CLASSWORK, hints=2, days_ago=9),
            ev(mode=AssignmentMode.CLASSWORK, helped=True, days_ago=8),
            ev(outcome=0.0, days_ago=1),
        ],
        ALL,
        NOW,
        covered=True,
    )
    assert (helped.level, helped.confident) == ("learning", True)
    # …while the same passes on their own are worth twice as much.
    assert ev(mode=AssignmentMode.CLASSWORK, hints=1).weight == 0.5
    assert ev(mode=AssignmentMode.CLASSWORK, helped=True).weight == 0.5
    assert ev(mode=AssignmentMode.QUIZ).weight == 3.0
    thin = assess([ev(mode=AssignmentMode.CLASSWORK, hints=1)], ALL, NOW, covered=True)
    assert thin.confident is False, "one helped classwork pass is too early to tell"


def test_a_mark_overrides_the_checks() -> None:
    assert _outcome("code", [], None, 3, 3, None) == 1.0
    assert _outcome("code", [], None, 3, 3, 1) == 0.5, "the mark wins"
    assert _outcome("code", [], None, 1, 4, None) == 0.25
    assert _outcome("code", [], None, None, None, None) is None, "never checked is not evidence"
    options = [{"correct": False}, {"correct": True}]
    assert _outcome("mcq", options, 1, None, None, None) == 1.0
    assert _outcome("mcq", options, 0, None, None, None) == 0.0
    assert _outcome("mcq", options, None, None, None, None) is None


def test_slipping_is_losing_what_was_secure_and_can_be_switched_off() -> None:
    history = [ev(days_ago=20), ev(days_ago=10), ev(outcome=0.0, days_ago=1)]
    assert assess(history, ALL, NOW, covered=True).revisit == ["slipping"]
    off = RevisitSettings(slipping=False)
    assert assess(history, off, NOW, covered=True).revisit == []
    # A classwork miss is practice, not a slip.
    practice = [ev(days_ago=20), ev(days_ago=10), ev(outcome=0, mode=AssignmentMode.CLASSWORK)]
    assert assess(practice, ALL, NOW, covered=True).revisit == []


def test_stuck_is_three_tries_without_a_full_pass() -> None:
    tries = [ev(outcome=0.5, days_ago=3), ev(outcome=0.0, days_ago=2)]
    assert assess(tries, ALL, NOW, covered=True).revisit == []
    tries.append(ev(outcome=0.5, days_ago=1))
    assert assess(tries, ALL, NOW, covered=True).revisit == ["stuck"]
    assert assess(tries, RevisitSettings(stuck=False), NOW, covered=True).revisit == []


def test_stale_is_secure_but_not_practised_for_three_weeks() -> None:
    old = [ev(days_ago=40), ev(days_ago=30)]
    assert assess(old, ALL, NOW, covered=True).revisit == ["stale"]
    recent = [ev(days_ago=20), ev(days_ago=10)]
    assert assess(recent, ALL, NOW, covered=True).revisit == []
    assert assess(old, RevisitSettings(stale=False), NOW, covered=True).revisit == []


def test_untouched_is_not_taught_unless_the_class_was_set_it() -> None:
    assert assess([], ALL, NOW, covered=False).level == "not_taught"
    assert assess([], ALL, NOW, covered=True).level == "not_yet"


def test_a_concept_reads_its_whole_branch_and_says_when_something_below_needs_revisiting() -> None:
    top = Concept(id=A, key="dicts", label="Dictionaries")
    mid = Concept(id=B, key="values", label=".values()", parent_id=A)
    leaf = Concept(id=C, key="loop", label="in a loop", parent_id=B)
    stuck = [ev(C, outcome=0.0, days_ago=d) for d in (3, 2, 1)]
    tree = skill_tree([top, mid, leaf], stuck, {C}, ALL, NOW)

    assert tree[C].revisit == ["stuck"] and tree[C].below is False
    assert tree[B].evidence == 3 and tree[B].below is True
    assert tree[A].level == "not_yet" and tree[A].below is True


# --- the routes -----------------------------------------------------------------------


async def _class_with_homework(
    client, session: AsyncSession, student_on_roster, problems: int = 1
) -> dict:
    from work_builders import homework

    roster = await student_on_roster()
    hw = await homework(client, session, roster, problems=problems)
    klass = await session.get(Class, uuid.UUID(roster["class_id"]))
    return {**roster, **hw, "centre_id": klass.centre_id}


async def _attempt(
    session: AsyncSession, built: dict, *, passed: int, total: int = 2, problem: int = 0
) -> Attempt:
    attempt = Attempt(
        centre_id=built["centre_id"],
        student_id=uuid.UUID(built["student_id"]),
        assignment_id=uuid.UUID(built["assignment"]["id"]),
        item_id=uuid.UUID(built["items"][problem]["id"]),
        status=AttemptStatus.SUBMITTED,
        last_passed=passed,
        last_total=total,
    )
    session.add(attempt)
    await session.flush()
    return attempt


async def test_the_class_grid_shows_each_child_on_each_top_concept(
    client, session: AsyncSession, student_on_roster
) -> None:
    built = await _class_with_homework(client, session, student_on_roster)
    await _attempt(session, built, passed=2)

    response = await client.get(f"/classes/{built['class_id']}/skills", headers=built["headers"])
    assert response.status_code == 200, response.text
    grid = response.json()
    column = [c["concept_id"] for c in grid["columns"]].index(str(built["concept"].id))
    (row,) = grid["rows"]
    assert row["display_name"] == "Aria K"
    cell = row["cells"][column]
    assert (cell["level"], cell["evidence"], cell["revisit"]) == ("learning", 1, [])
    assert grid["settings"] == {"slipping": True, "stuck": True, "stale": True}


async def test_a_childs_tree_and_the_evidence_behind_a_node(
    client, session: AsyncSession, student_on_roster
) -> None:
    built = await _class_with_homework(client, session, student_on_roster)
    headers = built["headers"]
    parent = (await client.post("/concepts", json={"label": "Collections"}, headers=headers)).json()
    # The homework's tag goes under Collections; the copy-in gave it a new id.
    tags = (await client.get("/concepts", headers=headers)).json()
    lists = next(t for t in tags if t["key"] == built["concept"].key)
    moved = await client.patch(
        f"/concepts/{lists['id']}", json={"parent_id": parent["id"]}, headers=headers
    )
    assert moved.status_code == 200, moved.text
    lists = moved.json()
    attempt = await _attempt(session, built, passed=0)
    session.add(
        Event(
            id=uuid.uuid4(),
            centre_id=built["centre_id"],
            student_id=attempt.student_id,
            attempt_id=attempt.id,
            editor_session_id=uuid.uuid4(),
            seq=1,
            type=EventType.TEACHER_EDIT,
            client_ts=NOW,
        )
    )
    await session.flush()

    base = f"/classes/{built['class_id']}/students/{built['student_id']}/skills"
    tree = (await client.get(base, headers=headers)).json()
    nodes = {n["concept_id"]: n for n in tree["nodes"]}
    assert nodes[lists["id"]]["parent_id"] == parent["id"]
    assert (nodes[lists["id"]]["level"], nodes[parent["id"]]["evidence"]) == ("not_yet", 1)

    evidence = (await client.get(f"{base}/{parent['id']}/evidence", headers=headers)).json()
    assert [(e["attempt_id"], e["mode"], e["helped"], e["weight"]) for e in evidence] == [
        (str(attempt.id), "homework", True, 1.0)
    ]


async def test_the_switches_are_per_class_and_audited(
    client, session: AsyncSession, student_on_roster
) -> None:
    built = await _class_with_homework(client, session, student_on_roster, problems=3)
    for problem in range(3):
        await _attempt(session, built, passed=0, problem=problem)
    url = f"/classes/{built['class_id']}"
    headers = built["headers"]

    def cell(grid: dict) -> dict:
        column = [c["concept_id"] for c in grid["columns"]].index(str(built["concept"].id))
        return grid["rows"][0]["cells"][column]

    before = (await client.get(f"{url}/skills", headers=headers)).json()
    assert cell(before)["revisit"] == ["stuck"]

    off = await client.patch(f"{url}/skill-settings", json={"stuck": False}, headers=headers)
    assert off.json() == {"slipping": True, "stuck": False, "stale": True}
    after = (await client.get(f"{url}/skills", headers=headers)).json()
    assert cell(after)["revisit"] == []
    audit = (
        await session.exec(select(AuditLog).where(AuditLog.action == "class.skill_settings"))
    ).one()
    assert audit.payload == {"stuck": False}


async def test_skills_are_teachers_only_and_never_another_centres(
    client, session: AsyncSession, student_on_roster, foreign_centre, signed_in_student
) -> None:
    built = await _class_with_homework(client, session, student_on_roster)
    theirs = foreign_centre
    headers = built["headers"]
    their_class = theirs["class"].id
    their_child = theirs["student"].id

    for url in (
        f"/classes/{their_class}/skills",
        f"/classes/{their_class}/students/{their_child}/skills",
        f"/classes/{built['class_id']}/students/{their_child}/skills",
    ):
        assert (await client.get(url, headers=headers)).status_code == 404, url
    assert (
        await client.patch(
            f"/classes/{their_class}/skill-settings", json={"stuck": False}, headers=headers
        )
    ).status_code == 404

    # A child of this centre who is not in the class is a 404 here too.
    other = await student_on_roster("Ben T", class_name="Another class")
    url = f"/classes/{built['class_id']}/students/{other['student_id']}/skills"
    assert (await client.get(url, headers=headers)).status_code == 404

    client.headers.pop("Authorization", None)
    await signed_in_student("Cleo M")
    assert (await client.get(f"/classes/{built['class_id']}/skills")).status_code == 403


async def test_a_quiz_still_running_is_not_read(
    client, session: AsyncSession, student_on_roster
) -> None:
    from app.models import Assignment, AssignmentStatus
    from app.models.base import utcnow
    from app.skills import load_evidence

    built = await _class_with_homework(client, session, student_on_roster)
    await _attempt(session, built, passed=2)
    quiz = await session.get(Assignment, uuid.UUID(built["assignment"]["id"]))
    quiz.mode = AssignmentMode.QUIZ
    quiz.status = AssignmentStatus.OPEN
    quiz.hand_in_at = utcnow() + timedelta(minutes=5)
    session.add(quiz)
    await session.flush()
    child = uuid.UUID(built["student_id"])

    running = await load_evidence(session, built["centre_id"], [child], utcnow())
    assert running[child] == []

    quiz.hand_in_at = utcnow() - timedelta(minutes=1)
    session.add(quiz)
    await session.flush()
    (handed_in,) = (await load_evidence(session, built["centre_id"], [child], utcnow()))[child]
    assert (handed_in.mode, handed_in.weight, handed_in.outcome) == ("quiz", 3.0, 1.0)
