"""A student's own files.

The tenancy tests in this repo have always asked "can a teacher reach another centre's
data". This file asks a new question: **can a child reach another child's work.** That is a
worse leak than the cross-centre one, because it needs no second account and no second
centre — just a signed-in nine-year-old and a guessed uuid. So the subject-boundary tests
here carry the weight that the centre-boundary tests carry elsewhere.
"""

import uuid

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.models import AuditLog, StudentDocument
from app.routers.documents import MAX_CONTENT_BYTES, MAX_TITLE_LENGTH, STARTER_CONTENT


async def new_file(client, title: str | None = None, content: str | None = None) -> dict:
    body: dict[str, str] = {}
    if title is not None:
        body["title"] = title
    if content is not None:
        body["content"] = content
    response = await client.post("/me/documents", json=body)
    assert response.status_code == 201, response.text
    return response.json()


# --- creating and listing -----------------------------------------------------------


async def test_a_new_file_arrives_with_something_to_run(client, signed_in_student) -> None:
    """A blank editor is a worse first experience than one line that already works."""
    await signed_in_student()
    created = await new_file(client)

    assert created["title"] == "Untitled"
    assert created["content"] == STARTER_CONTENT
    assert created["status"] == "active"
    assert uuid.UUID(created["id"]).version == 7


async def test_pressing_new_twice_never_collides(client, signed_in_student) -> None:
    """The partial unique index would refuse a second "Untitled"; a 409 in response to a
    plus button is not something a ten-year-old can act on, so the titles are numbered."""
    await signed_in_student()

    titles = [(await new_file(client))["title"] for _ in range(3)]
    assert titles == ["Untitled", "Untitled 2", "Untitled 3"]


async def test_a_named_file_keeps_its_name(client, signed_in_student) -> None:
    await signed_in_student()
    created = await new_file(client, title="  spiral  ", content="print(1)")
    assert created["title"] == "spiral"
    assert created["content"] == "print(1)"


async def test_the_list_is_most_recently_worked_on_first(client, signed_in_student) -> None:
    """A child coming back wants what they were last editing, not what they made last."""
    await signed_in_student()
    first = await new_file(client, title="one")
    await new_file(client, title="two")

    await client.patch(f"/me/documents/{first['id']}", json={"content": "print('edited')"})

    listed = (await client.get("/me/documents")).json()
    assert [item["title"] for item in listed] == ["one", "two"]


async def test_the_list_leaves_content_out(client, signed_in_student) -> None:
    """A term of work in six files should not be downloaded to render a sidebar."""
    await signed_in_student()
    await new_file(client, title="one", content="x = 1")

    listed = (await client.get("/me/documents")).json()
    assert "content" not in listed[0]
    assert listed[0]["title"] == "one"


async def test_a_duplicate_title_is_refused_with_something_readable(
    client, signed_in_student
) -> None:
    await signed_in_student()
    await new_file(client, title="spiral")

    response = await client.post("/me/documents", json={"title": "Spiral"})
    assert response.status_code == 409
    assert "already have a file" in response.json()["detail"]


async def test_an_over_long_title_or_body_is_rejected(client, signed_in_student) -> None:
    await signed_in_student()

    assert (
        await client.post("/me/documents", json={"title": "x" * (MAX_TITLE_LENGTH + 1)})
    ).status_code == 422
    assert (
        await client.post("/me/documents", json={"content": "x" * (MAX_CONTENT_BYTES + 1)})
    ).status_code == 422


async def test_a_file_at_the_cap_is_accepted(client, signed_in_student) -> None:
    await signed_in_student()
    created = await new_file(client, content="#" * MAX_CONTENT_BYTES)
    assert len(created["content"]) == MAX_CONTENT_BYTES


# --- saving -------------------------------------------------------------------------


async def test_saving_persists_the_content(client, signed_in_student) -> None:
    await signed_in_student()
    created = await new_file(client)

    saved = await client.patch(f"/me/documents/{created['id']}", json={"content": "print('hello')"})
    assert saved.status_code == 200
    assert saved.json()["content"] == "print('hello')"

    reread = (await client.get(f"/me/documents/{created['id']}")).json()
    assert reread["content"] == "print('hello')"


async def test_a_file_can_be_renamed(client, signed_in_student) -> None:
    await signed_in_student()
    created = await new_file(client)

    renamed = await client.patch(f"/me/documents/{created['id']}", json={"title": "spiral"})
    assert renamed.json()["title"] == "spiral"


async def test_renaming_onto_another_live_file_is_refused(client, signed_in_student) -> None:
    await signed_in_student()
    await new_file(client, title="spiral")
    other = await new_file(client, title="squares")

    response = await client.patch(f"/me/documents/{other['id']}", json={"title": "spiral"})
    assert response.status_code == 409


async def test_a_save_that_changes_nothing_does_not_touch_the_row(
    client, signed_in_student, session: AsyncSession
) -> None:
    """onupdate would move updated_at and reshuffle the file list under a child who is
    only reading."""
    await signed_in_student()
    created = await new_file(client, content="x = 1")
    before = (await session.exec(select(StudentDocument))).one().updated_at

    await client.patch(f"/me/documents/{created['id']}", json={"content": "x = 1"})
    await client.patch(f"/me/documents/{created['id']}", json={})

    after = (await session.exec(select(StudentDocument))).one().updated_at
    assert after == before


async def test_an_empty_patch_is_not_an_error(client, signed_in_student) -> None:
    """The autosave may fire with nothing to say; that is not worth a 422."""
    await signed_in_student()
    created = await new_file(client)
    assert (await client.patch(f"/me/documents/{created['id']}", json={})).status_code == 200


# --- archiving ----------------------------------------------------------------------


async def test_archiving_hides_a_file_without_destroying_it(
    client, signed_in_student, session: AsyncSession
) -> None:
    await signed_in_student()
    created = await new_file(client, title="spiral")

    archived = await client.post(f"/me/documents/{created['id']}/archive")
    assert archived.json()["status"] == "archived"

    assert (await client.get("/me/documents")).json() == []
    included = (await client.get("/me/documents?include_archived=true")).json()
    assert [item["title"] for item in included] == ["spiral"]
    # Archive, never delete — the row is still there.
    assert len((await session.exec(select(StudentDocument))).all()) == 1


async def test_an_archived_file_can_still_be_opened(client, signed_in_student) -> None:
    """A child reopening something they put away should get it."""
    await signed_in_student()
    created = await new_file(client, content="print(1)")
    await client.post(f"/me/documents/{created['id']}/archive")

    reread = await client.get(f"/me/documents/{created['id']}")
    assert reread.status_code == 200
    assert reread.json()["content"] == "print(1)"


async def test_archiving_frees_the_title_for_reuse(client, signed_in_student) -> None:
    """The unique index is partial: two archived "spiral" files are just history."""
    await signed_in_student()
    first = await new_file(client, title="spiral")
    await client.post(f"/me/documents/{first['id']}/archive")

    second = await client.post("/me/documents", json={"title": "spiral"})
    assert second.status_code == 201


async def test_restoring_onto_a_taken_title_is_refused_not_a_500(client, signed_in_student) -> None:
    """The index only covers live files, so a restore can collide with a newer file."""
    await signed_in_student()
    first = await new_file(client, title="spiral")
    await client.post(f"/me/documents/{first['id']}/archive")
    await new_file(client, title="spiral")

    response = await client.post(f"/me/documents/{first['id']}/restore")
    assert response.status_code == 409


async def test_restoring_brings_a_file_back(client, signed_in_student) -> None:
    await signed_in_student()
    created = await new_file(client, title="spiral")
    await client.post(f"/me/documents/{created['id']}/archive")

    restored = await client.post(f"/me/documents/{created['id']}/restore")
    assert restored.json()["status"] == "active"
    assert [item["title"] for item in (await client.get("/me/documents")).json()] == ["spiral"]


async def test_archiving_twice_is_not_an_error(client, signed_in_student) -> None:
    await signed_in_student()
    created = await new_file(client)
    await client.post(f"/me/documents/{created['id']}/archive")
    assert (await client.post(f"/me/documents/{created['id']}/archive")).status_code == 200


# --- the subject boundary: one child cannot reach another's work ---------------------


async def test_another_childs_file_is_a_404(client, signed_in_student) -> None:
    """The leak this table's scoping exists to prevent. No second centre needed — one
    signed-in child and a guessed uuid would be enough without the student_id filter."""
    aria = await signed_in_student("Aria K")
    hers = await new_file(client, title="spiral")

    # Sign in as a different child at the same centre, on the same client.
    bella = await signed_in_student("Bella N")
    assert bella["student_id"] != aria["student_id"]

    assert (await client.get(f"/me/documents/{hers['id']}")).status_code == 404
    assert (await client.get("/me/documents")).json() == []


async def test_another_childs_file_cannot_be_written(client, signed_in_student) -> None:
    await signed_in_student("Aria K")
    hers = await new_file(client, title="spiral", content="print('mine')")

    await signed_in_student("Bella N")
    for method, path in (
        ("patch", f"/me/documents/{hers['id']}"),
        ("post", f"/me/documents/{hers['id']}/archive"),
        ("post", f"/me/documents/{hers['id']}/restore"),
    ):
        response = await client.request(method, path, json={"content": "print('yours')"})
        assert response.status_code == 404, f"{method} {path}"


async def test_the_original_owner_still_has_their_file_intact(
    client, signed_in_student, session: AsyncSession
) -> None:
    await signed_in_student("Aria K")
    hers = await new_file(client, title="spiral", content="print('mine')")

    await signed_in_student("Bella N")
    await client.patch(f"/me/documents/{hers['id']}", json={"content": "print('yours')"})

    stored = (await session.exec(select(StudentDocument))).one()
    assert stored.content == "print('mine')"


async def test_an_unknown_id_is_also_404(client, signed_in_student) -> None:
    await signed_in_student()
    assert (await client.get(f"/me/documents/{uuid.uuid4()}")).status_code == 404


# --- authentication -----------------------------------------------------------------


async def test_every_route_requires_a_signed_in_student(client) -> None:
    document_id = uuid.uuid4()
    calls = [
        ("get", "/me/documents", None),
        ("post", "/me/documents", {}),
        ("get", f"/me/documents/{document_id}", None),
        ("patch", f"/me/documents/{document_id}", {"content": "x"}),
        ("post", f"/me/documents/{document_id}/archive", None),
        ("post", f"/me/documents/{document_id}/restore", None),
    ]
    for method, path, payload in calls:
        response = await client.request(method, path, json=payload)
        assert response.status_code == 401, f"{method} {path}"


async def test_a_teacher_cannot_reach_a_students_files(client, signed_in) -> None:
    """The rare case where a teacher has less access than a student.

    §2.2 is "co-piloting, not surveillance": a teacher helps with work a child has handed
    in. Browsing drafts arrives in Phase 5 as submissions, not here.
    """
    headers = await signed_in()
    calls = [
        ("get", "/me/documents", None),
        ("post", "/me/documents", {}),
        ("get", f"/me/documents/{uuid.uuid4()}", None),
    ]
    for method, path, payload in calls:
        response = await client.request(method, path, json=payload, headers=headers)
        assert response.status_code == 403, f"{method} {path}"


# --- audit --------------------------------------------------------------------------


async def test_a_childs_own_edits_are_not_audited(
    client, signed_in_student, session: AsyncSession
) -> None:
    """audit_log records what a *teacher* did to a *child's* record. An autosave every two
    seconds would bury exactly the rows the table exists to surface."""
    await signed_in_student()
    created = await new_file(client, title="spiral")
    await client.patch(f"/me/documents/{created['id']}", json={"content": "print(1)"})
    await client.post(f"/me/documents/{created['id']}/archive")

    document_audits = (
        await session.exec(select(AuditLog).where(AuditLog.target_type == "document"))
    ).all()
    assert document_audits == []
