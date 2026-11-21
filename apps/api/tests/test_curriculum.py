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


async def test_another_centres_tags_cannot_be_changed(
    client, signed_in, session: AsyncSession, foreign_centre
) -> None:
    headers = await signed_in()
    (theirs,) = await make_concepts(session, "vex", centre_id=foreign_centre["centre"].id)

    rename = await client.patch(f"/concepts/{theirs.id}", json={"label": "Mine"}, headers=headers)
    assert rename.status_code == 404
    assert (await client.delete(f"/concepts/{theirs.id}", headers=headers)).status_code == 404
    assert (await client.get(f"/concepts/{theirs.id}/impact", headers=headers)).status_code == 404
    under = await client.post(
        "/concepts", json={"label": "Sub", "parent_id": str(theirs.id)}, headers=headers
    )
    assert under.status_code == 404
    assert (theirs.label, theirs.status, theirs.deleted_at) == ("Vex", "provisional", None)


async def test_a_student_cannot_change_tags(client, signed_in_student) -> None:
    await signed_in_student()
    some = uuid.uuid4()
    assert (await client.post("/concepts", json={"label": "x"})).status_code == 403
    assert (await client.patch(f"/concepts/{some}", json={"label": "x"})).status_code == 403
    assert (await client.delete(f"/concepts/{some}")).status_code == 403
    assert (await client.get(f"/concepts/{some}/impact")).status_code == 403


# --- the centre's tree (Ken, 21 Nov 2026) ---------------------------------------------


async def test_editing_a_built_in_tag_copies_the_taxonomy_into_the_centre(
    client, signed_in, session: AsyncSession
) -> None:
    from work_builders import problem_doc

    headers = await signed_in()
    lists, dicts = await make_concepts(session, "lists", "dicts")
    item = (await client.post("/items", json=problem_doc(str(lists.id)), headers=headers)).json()
    tree = await build_course(client, headers)
    lesson_id = tree["lessons"][0]["id"]
    await client.put(
        f"/lessons/{lesson_id}/concepts", json={"concept_ids": [str(dicts.id)]}, headers=headers
    )

    renamed = await client.patch(
        f"/concepts/{lists.id}", json={"label": "Lists and loops"}, headers=headers
    )
    assert renamed.status_code == 200, renamed.text
    ours = renamed.json()
    assert ours["id"] != str(lists.id) and ours["key"] == "lists" and ours["own"] is True

    # The global rows are never changed; the centre now sees only its own copies.
    assert (lists.label, lists.centre_id) == ("Lists", None)
    concepts = (await client.get("/concepts", headers=headers)).json()
    assert [(c["key"], c["own"]) for c in concepts] == [("lists", True), ("dicts", True)]
    our_dicts = concepts[1]["id"]

    # The problem's and the lesson's tags moved with it.
    doc = (await client.get(f"/items/{item['id']}", headers=headers)).json()["document"]
    assert (doc["concept_ids"], doc["primary_concept_id"]) == ([ours["id"]], ours["id"])
    course = (await client.get(f"/courses/{tree['course']['id']}", headers=headers)).json()
    assert course["units"][0]["lessons"][0]["concept_ids"] == [our_dicts]

    # An editor opened before the copy still saves with the global id it was holding.
    saved = await client.put(
        f"/items/{item['id']}", json=problem_doc(str(lists.id)), headers=headers
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["document"]["concept_ids"] == [ours["id"]]


async def test_sub_skills_nest_as_deep_as_a_teacher_likes(
    client, signed_in, session: AsyncSession
) -> None:
    headers = await signed_in()
    (dicts,) = await make_concepts(session, "dicts")

    values = await client.post(
        "/concepts", json={"label": ".values()", "parent_id": str(dicts.id)}, headers=headers
    )
    assert values.status_code == 201, values.text
    values = values.json()
    our_dicts = values["parent_id"]
    assert our_dicts != str(dicts.id), "made under the centre's copy"
    deeper = (
        await client.post(
            "/concepts", json={"label": "in a loop", "parent_id": values["id"]}, headers=headers
        )
    ).json()
    assert deeper["parent_id"] == values["id"]

    # The same name may sit in two places, never twice side by side.
    elsewhere = await client.post("/concepts", json={"label": "in a loop"}, headers=headers)
    assert elsewhere.status_code == 201
    twice = await client.post(
        "/concepts", json={"label": "In a loop", "parent_id": values["id"]}, headers=headers
    )
    assert twice.status_code == 409


async def test_a_tag_moves_but_never_inside_itself(
    client, signed_in, session: AsyncSession
) -> None:
    headers = await signed_in()
    top = (await client.post("/concepts", json={"label": "Loops"}, headers=headers)).json()
    child = (
        await client.post(
            "/concepts", json={"label": "for", "parent_id": top["id"]}, headers=headers
        )
    ).json()
    other = (await client.post("/concepts", json={"label": "Lists"}, headers=headers)).json()

    inside = await client.patch(
        f"/concepts/{top['id']}", json={"parent_id": child["id"]}, headers=headers
    )
    assert inside.status_code == 409
    itself = await client.patch(
        f"/concepts/{top['id']}", json={"parent_id": top["id"]}, headers=headers
    )
    assert itself.status_code == 409

    moved = await client.patch(
        f"/concepts/{child['id']}", json={"parent_id": other["id"]}, headers=headers
    )
    assert moved.json()["parent_id"] == other["id"]
    # Sending null moves it to the top; leaving parent_id out leaves it where it is.
    renamed = await client.patch(f"/concepts/{child['id']}", json={"label": "For"}, headers=headers)
    assert renamed.json()["parent_id"] == other["id"]
    to_top = await client.patch(
        f"/concepts/{child['id']}", json={"parent_id": None}, headers=headers
    )
    assert to_top.json()["parent_id"] is None
    actions = (await session.exec(select(AuditLog.action))).all()
    assert "concept.moved" in actions and "concept.renamed" in actions


async def test_deleting_a_tag_takes_its_branch_to_the_trash_and_restore_brings_it_back(
    client, signed_in, session: AsyncSession
) -> None:
    from work_builders import problem_doc

    headers = await signed_in()
    (dicts,) = await make_concepts(session, "dicts")
    values = (
        await client.post(
            "/concepts", json={"label": ".values()", "parent_id": str(dicts.id)}, headers=headers
        )
    ).json()
    our_dicts = values["parent_id"]
    loop = (
        await client.post(
            "/concepts", json={"label": "in a loop", "parent_id": values["id"]}, headers=headers
        )
    ).json()
    item = (await client.post("/items", json=problem_doc(values["id"]), headers=headers)).json()
    tree = await build_course(client, headers)
    lesson_id = tree["lessons"][0]["id"]
    await client.put(
        f"/lessons/{lesson_id}/concepts", json={"concept_ids": [loop["id"]]}, headers=headers
    )

    impact = (await client.get(f"/concepts/{values['id']}/impact", headers=headers)).json()
    assert impact == {"subskills": 1, "problems": 1, "lessons": 1}

    assert (await client.delete(f"/concepts/{values['id']}", headers=headers)).status_code == 204
    ids = {c["id"] for c in (await client.get("/concepts", headers=headers)).json()}
    assert ids == {our_dicts}
    doc = (await client.get(f"/items/{item['id']}", headers=headers)).json()["document"]
    assert (doc["concept_ids"], doc["primary_concept_id"]) == ([], None)
    course = (await client.get(f"/courses/{tree['course']['id']}", headers=headers)).json()
    assert course["units"][0]["lessons"][0]["concept_ids"] == []

    # One entry in the Trash for the branch; a sub-skill can't come back on its own.
    listed = [
        e for e in (await client.get("/trash", headers=headers)).json() if e["kind"] == "concept"
    ]
    assert [(e["id"], e["name"]) for e in listed] == [(values["id"], ".values()")]
    alone = await client.post(f"/trash/concept/{loop['id']}/restore", headers=headers)
    assert alone.status_code == 409

    restored = await client.post(f"/trash/concept/{values['id']}/restore", headers=headers)
    assert restored.status_code == 204
    ids = {c["id"] for c in (await client.get("/concepts", headers=headers)).json()}
    assert ids == {our_dicts, values["id"], loop["id"]}
    doc = (await client.get(f"/items/{item['id']}", headers=headers)).json()["document"]
    assert doc["primary_concept_id"] == values["id"]
    course = (await client.get(f"/courses/{tree['course']['id']}", headers=headers)).json()
    assert course["units"][0]["lessons"][0]["concept_ids"] == [loop["id"]]


async def test_a_deleted_built_in_tag_stays_deleted(
    client, signed_in, session: AsyncSession
) -> None:
    headers = await signed_in()
    lists, _ = await make_concepts(session, "lists", "range")

    assert (await client.delete(f"/concepts/{lists.id}", headers=headers)).status_code == 204
    keys = [c["key"] for c in (await client.get("/concepts", headers=headers)).json()]
    assert keys == ["range"], "the global row must not show through"
    assert lists.status == "provisional" and lists.deleted_at is None


async def test_purging_a_tag_erases_its_branch_but_no_problem(
    client, signed_in, session: AsyncSession
) -> None:
    from work_builders import problem_doc

    headers = await signed_in()
    top = (await client.post("/concepts", json={"label": "Turtle"}, headers=headers)).json()
    child = (
        await client.post(
            "/concepts", json={"label": "pen", "parent_id": top["id"]}, headers=headers
        )
    ).json()
    item = (await client.post("/items", json=problem_doc(child["id"]), headers=headers)).json()

    await client.delete(f"/concepts/{top['id']}", headers=headers)
    purged = await client.post(f"/trash/concept/{top['id']}/purge", json={}, headers=headers)
    assert purged.status_code == 204, purged.text
    remaining = (
        await session.exec(
            select(Concept).where(Concept.id.in_([uuid.UUID(top["id"]), uuid.UUID(child["id"])]))  # type: ignore[attr-defined]
        )
    ).all()
    assert remaining == []
    assert (await client.get(f"/items/{item['id']}", headers=headers)).status_code == 200
