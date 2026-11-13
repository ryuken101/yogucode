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


# --- the centre's own concept tags (Ken, 14 Nov 2026) ---------------------------------


async def test_a_teacher_adds_a_tag_the_whole_centre_can_use(
    client, signed_in, session: AsyncSession
) -> None:
    headers = await signed_in()
    (lists,) = await make_concepts(session, "lists")

    response = await client.post(
        "/concepts", json={"label": "  Turtle   drawing "}, headers=headers
    )
    assert response.status_code == 201, response.text
    tag = response.json()
    assert (tag["label"], tag["key"], tag["own"], tag["status"]) == (
        "Turtle drawing",
        "turtle_drawing",
        True,
        "active",
    )
    concepts = (await client.get("/concepts", headers=headers)).json()
    assert [c["key"] for c in concepts] == ["lists", "turtle_drawing"], "after the built-ins"
    assert concepts[0]["own"] is False

    # It tags a problem like any other.
    from work_builders import problem_doc

    made = await client.post("/items", json=problem_doc(tag["id"]), headers=headers)
    assert made.status_code == 201, made.text
    audit = (await session.exec(select(AuditLog).where(AuditLog.action == "concept.created"))).one()
    assert audit.target_id == uuid.UUID(tag["id"])
    assert lists.label == "Lists"


async def test_a_tag_name_is_never_used_twice(client, signed_in, session: AsyncSession) -> None:
    headers = await signed_in()
    await make_concepts(session, "variables")

    for label in ["VARIABLES", "variables "]:
        response = await client.post("/concepts", json={"label": label}, headers=headers)
        assert response.status_code == 409, label
    assert (
        await client.post("/concepts", json={"label": "   "}, headers=headers)
    ).status_code == 422

    # A different name whose key a built-in already has gets its own key, rather than
    # replacing the built-in (a centre row with a global key overrides it).
    shouted = await client.post("/concepts", json={"label": "Variables!"}, headers=headers)
    assert shouted.status_code == 201
    assert shouted.json()["key"] == "variables_2"
    labels = [c["label"] for c in (await client.get("/concepts", headers=headers)).json()]
    assert labels == ["Variables", "Variables!"]


async def test_a_tag_is_renamed_but_keeps_its_key(client, signed_in, session: AsyncSession) -> None:
    headers = await signed_in()
    await make_concepts(session, "loops")
    tag = (await client.post("/concepts", json={"label": "Turtel"}, headers=headers)).json()

    renamed = await client.patch(
        f"/concepts/{tag['id']}", json={"label": "Turtle"}, headers=headers
    )
    assert renamed.status_code == 200
    assert (renamed.json()["label"], renamed.json()["key"]) == ("Turtle", "turtel")
    clash = await client.patch(f"/concepts/{tag['id']}", json={"label": "loops"}, headers=headers)
    assert clash.status_code == 409


async def test_only_the_centres_own_tags_can_be_changed(
    client, signed_in, session: AsyncSession, foreign_centre
) -> None:
    headers = await signed_in()
    (built_in,) = await make_concepts(session, "lists")
    (theirs,) = await make_concepts(session, "vex", centre_id=foreign_centre["centre"].id)

    for concept in (built_in, theirs):
        rename = await client.patch(
            f"/concepts/{concept.id}", json={"label": "Mine now"}, headers=headers
        )
        assert rename.status_code == 404
        assert (
            await client.post(f"/concepts/{concept.id}/archive", headers=headers)
        ).status_code == 404
    assert (built_in.label, built_in.status, theirs.status) == (
        "Lists",
        "provisional",
        "provisional",
    )


async def test_a_student_cannot_change_tags(client, signed_in_student) -> None:
    await signed_in_student()
    some = uuid.uuid4()
    assert (await client.post("/concepts", json={"label": "x"})).status_code == 403
    assert (await client.patch(f"/concepts/{some}", json={"label": "x"})).status_code == 403
    assert (await client.post(f"/concepts/{some}/archive")).status_code == 403


async def test_a_tag_in_use_cannot_be_removed(client, signed_in, session: AsyncSession) -> None:
    from work_builders import problem_doc

    headers = await signed_in()
    tag = (await client.post("/concepts", json={"label": "Turtle"}, headers=headers)).json()
    item = (await client.post("/items", json=problem_doc(tag["id"]), headers=headers)).json()
    tree = await build_course(client, headers)
    await client.put(
        f"/lessons/{tree['lessons'][0]['id']}/concepts",
        json={"concept_ids": [tag["id"]]},
        headers=headers,
    )

    refused = await client.post(f"/concepts/{tag['id']}/archive", headers=headers)
    assert refused.status_code == 409
    assert (
        refused.json()["detail"] == "Used by 1 problem and 1 lesson. Take the tag off them first."
    )

    await client.post(f"/items/{item['id']}/archive", headers=headers)
    await client.put(
        f"/lessons/{tree['lessons'][0]['id']}/concepts", json={"concept_ids": []}, headers=headers
    )
    removed = await client.post(f"/concepts/{tag['id']}/archive", headers=headers)
    assert removed.status_code == 200
    assert all(
        c["id"] != tag["id"] for c in (await client.get("/concepts", headers=headers)).json()
    )
    # Its row stays, archived; the same name can be used again, with a fresh key.
    again = (await client.post("/concepts", json={"label": "Turtle"}, headers=headers)).json()
    assert again["key"] == "turtle_2"
