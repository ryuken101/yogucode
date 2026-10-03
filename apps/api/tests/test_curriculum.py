"""The curriculum tree, and the class's pointer into it.

Nothing here is a child's record, but the tenancy tests still come first: a course is the
container problems and assignments will hang off from step 2 onward, and a cross-centre
reference made now becomes a cross-centre read later.
"""

import uuid

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.models import AuditLog, Concept, ConceptStatus, Course, Lesson, Unit


async def make_concepts(session: AsyncSession, *keys: str, centre_id=None) -> list[Concept]:
    concepts = [
        Concept(key=key, label=key.title(), sort_order=i * 10, centre_id=centre_id)
        for i, key in enumerate(keys)
    ]
    session.add_all(concepts)
    await session.flush()
    return concepts


async def build_course(client, headers) -> dict:
    """A course with one unit holding two lessons, built through the API."""
    course = (await client.post("/courses", json={"title": "Python 1"}, headers=headers)).json()
    unit = (
        await client.post(
            f"/courses/{course['id']}/units", json={"title": "Lists"}, headers=headers
        )
    ).json()
    first = (
        await client.post(f"/units/{unit['id']}/lessons", json={"title": "Append"}, headers=headers)
    ).json()
    second = (
        await client.post(f"/units/{unit['id']}/lessons", json={"title": "Index"}, headers=headers)
    ).json()
    return {"course": course, "unit": unit, "lessons": [first, second]}


async def foreign_course(session: AsyncSession, centre_id) -> dict:
    course = Course(centre_id=centre_id, title="Someone else's course")
    session.add(course)
    await session.flush()
    unit = Unit(centre_id=centre_id, course_id=course.id, title="Theirs")
    session.add(unit)
    await session.flush()
    lesson = Lesson(centre_id=centre_id, unit_id=unit.id, title="Theirs")
    session.add(lesson)
    await session.flush()
    return {"course": course, "unit": unit, "lesson": lesson}


# --- tenancy --------------------------------------------------------------------------


async def test_another_centres_course_is_invisible(
    client, signed_in, session: AsyncSession, foreign_centre
) -> None:
    headers = await signed_in()
    theirs = await foreign_course(session, foreign_centre["centre"].id)

    assert (await client.get("/courses", headers=headers)).json() == []
    for method, path, body in [
        ("get", f"/courses/{theirs['course'].id}", None),
        ("patch", f"/courses/{theirs['course'].id}", {"title": "Mine now"}),
        ("post", f"/courses/{theirs['course'].id}/archive", None),
        ("post", f"/courses/{theirs['course'].id}/units", {"title": "Sneaky"}),
        ("patch", f"/units/{theirs['unit'].id}", {"title": "Mine now"}),
        ("post", f"/units/{theirs['unit'].id}/lessons", {"title": "Sneaky"}),
        ("patch", f"/lessons/{theirs['lesson'].id}", {"title": "Mine now"}),
        ("put", f"/lessons/{theirs['lesson'].id}/concepts", {"concept_ids": []}),
    ]:
        response = await client.request(method, path, json=body, headers=headers)
        assert response.status_code == 404, (method, path, response.text)


async def test_a_class_cannot_point_at_another_centres_course(
    client, signed_in, session: AsyncSession, foreign_centre
) -> None:
    headers = await signed_in()
    klass = (await client.post("/classes", json={"name": "Mine"}, headers=headers)).json()
    theirs = await foreign_course(session, foreign_centre["centre"].id)

    response = await client.put(
        f"/classes/{klass['id']}/curriculum",
        json={"course_id": str(theirs["course"].id), "current_lesson_id": None},
        headers=headers,
    )
    assert response.status_code == 404


async def test_a_class_cannot_point_at_another_centres_lesson(
    client, signed_in, session: AsyncSession, foreign_centre
) -> None:
    """Even with a course of its own: the lesson is looked up through scoping too."""
    headers = await signed_in()
    klass = (await client.post("/classes", json={"name": "Mine"}, headers=headers)).json()
    mine = await build_course(client, headers)
    theirs = await foreign_course(session, foreign_centre["centre"].id)

    response = await client.put(
        f"/classes/{klass['id']}/curriculum",
        json={"course_id": mine["course"]["id"], "current_lesson_id": str(theirs["lesson"].id)},
        headers=headers,
    )
    assert response.status_code == 404


async def test_another_centres_private_concept_cannot_be_tagged(
    client, signed_in, session: AsyncSession, foreign_centre
) -> None:
    headers = await signed_in()
    tree = await build_course(client, headers)
    (private,) = await make_concepts(session, "vex_motors", centre_id=foreign_centre["centre"].id)

    response = await client.put(
        f"/lessons/{tree['lessons'][0]['id']}/concepts",
        json={"concept_ids": [str(private.id)]},
        headers=headers,
    )
    assert response.status_code == 422
    assert all(
        c["key"] != "vex_motors" for c in (await client.get("/concepts", headers=headers)).json()
    )


async def test_a_student_cannot_reach_the_curriculum(client, signed_in_student) -> None:
    await signed_in_student()
    assert (await client.get("/courses")).status_code == 403
    assert (await client.get("/concepts")).status_code == 403
    assert (await client.post("/courses", json={"title": "Mine"})).status_code == 403


# --- the tree -------------------------------------------------------------------------


async def test_the_outline_comes_back_in_order(client, signed_in) -> None:
    headers = await signed_in()
    tree = await build_course(client, headers)

    body = (await client.get(f"/courses/{tree['course']['id']}", headers=headers)).json()
    assert [u["title"] for u in body["units"]] == ["Lists"]
    assert [lesson["title"] for lesson in body["units"][0]["lessons"]] == ["Append", "Index"]
    assert [lesson["sort_order"] for lesson in body["units"][0]["lessons"]] == [10, 20]


async def test_a_lesson_can_be_slotted_between_two_others(client, signed_in) -> None:
    headers = await signed_in()
    tree = await build_course(client, headers)
    third = (
        await client.post(
            f"/units/{tree['unit']['id']}/lessons", json={"title": "Pop"}, headers=headers
        )
    ).json()
    await client.patch(f"/lessons/{third['id']}", json={"sort_order": 15}, headers=headers)

    body = (await client.get(f"/courses/{tree['course']['id']}", headers=headers)).json()
    assert [lesson["title"] for lesson in body["units"][0]["lessons"]] == ["Append", "Pop", "Index"]


async def test_archived_nodes_leave_the_outline_but_not_the_database(
    client, signed_in, session: AsyncSession
) -> None:
    headers = await signed_in()
    tree = await build_course(client, headers)
    archived_id = tree["lessons"][0]["id"]
    await client.post(f"/lessons/{archived_id}/archive", headers=headers)

    course_id = tree["course"]["id"]
    body = (await client.get(f"/courses/{course_id}", headers=headers)).json()
    assert [lesson["title"] for lesson in body["units"][0]["lessons"]] == ["Index"]
    full = (await client.get(f"/courses/{course_id}?include_archived=true", headers=headers)).json()
    assert len(full["units"][0]["lessons"]) == 2
    assert await session.get(Lesson, uuid.UUID(archived_id)) is not None


async def test_archiving_a_course_hides_it_from_the_list(client, signed_in) -> None:
    headers = await signed_in()
    tree = await build_course(client, headers)
    await client.post(f"/courses/{tree['course']['id']}/archive", headers=headers)

    assert (await client.get("/courses", headers=headers)).json() == []
    restored = await client.post(f"/courses/{tree['course']['id']}/unarchive", headers=headers)
    assert restored.json()["status"] == "active"


async def test_curriculum_edits_are_audited(client, signed_in, session: AsyncSession) -> None:
    headers = await signed_in()
    await build_course(client, headers)

    actions = [row.action for row in (await session.exec(select(AuditLog))).all()]
    assert actions.count("lesson.created") == 2
    assert "course.created" in actions and "unit.created" in actions


# --- concepts -------------------------------------------------------------------------


async def test_lesson_concepts_are_replaced_as_a_set(
    client, signed_in, session: AsyncSession
) -> None:
    headers = await signed_in()
    tree = await build_course(client, headers)
    lists, methods, loops = await make_concepts(session, "lists", "list_methods", "for_loops")
    lesson_id = tree["lessons"][0]["id"]

    await client.put(
        f"/lessons/{lesson_id}/concepts",
        json={"concept_ids": [str(lists.id), str(methods.id)]},
        headers=headers,
    )
    response = await client.put(
        f"/lessons/{lesson_id}/concepts",
        json={"concept_ids": [str(methods.id), str(loops.id)]},
        headers=headers,
    )

    assert response.status_code == 200
    assert set(response.json()["concept_ids"]) == {str(methods.id), str(loops.id)}
    body = (await client.get(f"/courses/{tree['course']['id']}", headers=headers)).json()
    assert set(body["units"][0]["lessons"][0]["concept_ids"]) == {str(methods.id), str(loops.id)}


async def test_a_centre_concept_overrides_the_global_one_with_its_key(
    client, signed_in, session: AsyncSession
) -> None:
    headers = await signed_in()
    await make_concepts(session, "lists", "range")
    centre_id = (await client.get("/centre", headers=headers)).json()["id"]
    (ours,) = await make_concepts(session, "lists", centre_id=uuid.UUID(centre_id))
    ours.label = "Lists (our way)"
    archived = Concept(key="turtle_basics", label="Turtle", status=ConceptStatus.ARCHIVED)
    session.add_all([ours, archived])
    await session.flush()

    concepts = (await client.get("/concepts", headers=headers)).json()
    assert [c["key"] for c in concepts] == ["lists", "range"]
    assert concepts[0]["label"] == "Lists (our way)"


# --- a class's place in the curriculum ------------------------------------------------


async def test_a_class_follows_a_course_and_is_on_a_lesson(client, signed_in) -> None:
    headers = await signed_in()
    klass = (await client.post("/classes", json={"name": "Year 4-6"}, headers=headers)).json()
    tree = await build_course(client, headers)

    response = await client.put(
        f"/classes/{klass['id']}/curriculum",
        json={"course_id": tree["course"]["id"], "current_lesson_id": tree["lessons"][1]["id"]},
        headers=headers,
    )
    assert response.status_code == 200
    body = (await client.get(f"/classes/{klass['id']}", headers=headers)).json()
    assert body["course_id"] == tree["course"]["id"]
    assert body["current_lesson_id"] == tree["lessons"][1]["id"]


async def test_a_lesson_from_a_different_course_is_refused(client, signed_in) -> None:
    headers = await signed_in()
    klass = (await client.post("/classes", json={"name": "Year 4-6"}, headers=headers)).json()
    first = await build_course(client, headers)
    second = await build_course(client, headers)

    response = await client.put(
        f"/classes/{klass['id']}/curriculum",
        json={"course_id": first["course"]["id"], "current_lesson_id": second["lessons"][0]["id"]},
        headers=headers,
    )
    assert response.status_code == 422


async def test_a_lesson_without_a_course_is_refused(client, signed_in) -> None:
    headers = await signed_in()
    klass = (await client.post("/classes", json={"name": "Year 4-6"}, headers=headers)).json()
    tree = await build_course(client, headers)

    response = await client.put(
        f"/classes/{klass['id']}/curriculum",
        json={"course_id": None, "current_lesson_id": tree["lessons"][0]["id"]},
        headers=headers,
    )
    assert response.status_code == 422


async def test_an_archived_lesson_cannot_be_today(client, signed_in) -> None:
    headers = await signed_in()
    klass = (await client.post("/classes", json={"name": "Year 4-6"}, headers=headers)).json()
    tree = await build_course(client, headers)
    await client.post(f"/units/{tree['unit']['id']}/archive", headers=headers)

    response = await client.put(
        f"/classes/{klass['id']}/curriculum",
        json={"course_id": tree["course"]["id"], "current_lesson_id": tree["lessons"][0]["id"]},
        headers=headers,
    )
    assert response.status_code == 422
