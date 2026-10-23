"""Delete entirely (Ken's decisions, 11 Oct 2026) — `app/erase.py`.

What is defended:
- deleting a child removes their account and every row of their work, and nothing of
  anyone else's;
- deleting a class removes it and its work, but keeps the children's accounts and files;
- only the owner can do either, only with the name typed out; another centre is a 404;
- the audit trail keeps the record of the deletion, without the child's name.
"""

import uuid

from sqlmodel import func, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.models import (
    Assignment,
    AssignmentNote,
    Attempt,
    AuditLog,
    Class,
    ClassTeacher,
    Enrolment,
    Event,
    Mark,
    Student,
    StudentCredential,
    StudentDocument,
    StudentSession,
    Submission,
)
from app.models.base import new_uuid
from work_builders import homework


async def count(session: AsyncSession, model, *where) -> int:
    return (await session.exec(select(func.count()).select_from(model).where(*where))).one()


async def child_with_work(client, session: AsyncSession, signed_in_student, name="Aria K"):
    """A signed-in child with a handed-in, marked homework, a note, an event and a file."""
    kid = await signed_in_student(name)
    hw = await homework(client, session, kid)
    assignment_id = hw["assignment"]["id"]
    opened = await client.post(f"/me/assignments/{assignment_id}/items/{hw['items'][0]['id']}/open")
    attempt_id = opened.json()["leaves"][0]["attempt"]["id"]
    file_id = (await client.post("/me/documents", json={})).json()["id"]
    await client.post(
        "/me/events",
        json={
            "events": [
                {
                    "id": str(new_uuid()),
                    "attempt_id": attempt_id,
                    "document_id": None,
                    "editor_session_id": "018f0000-0000-7000-8000-00000000e5e5",
                    "seq": 0,
                    "type": "edit",
                    "payload": {"changes": [{"offset": 0, "length": 0, "text": "x"}]},
                    "client_ts": "2026-10-11T00:00:00+00:00",
                }
            ]
        },
    )
    await client.post(f"/me/homework/{assignment_id}/hand-in", json={})
    await client.put(
        f"/attempts/{attempt_id}/mark",
        json={"runs": True, "correct": 2, "comment_md": "Lovely"},
        headers=kid["headers"],
    )
    await client.put(
        f"/assignments/{assignment_id}/notes/{kid['student_id']}",
        json={"note": "Great week"},
        headers=kid["headers"],
    )
    return kid | {"assignment_id": assignment_id, "attempt_id": attempt_id, "file_id": file_id}


# --- deleting a child --------------------------------------------------------------------


async def test_deleting_a_child_removes_their_account_and_all_their_work(
    client, session: AsyncSession, signed_in_student
):
    aria = await child_with_work(client, session, signed_in_student)
    sid = uuid.UUID(aria["student_id"])
    assert await count(session, Mark) == 1, "the fixture really built a mark"
    assert await count(session, Event, Event.student_id == sid) >= 1

    response = await client.post(
        f"/students/{sid}/delete", json={"confirm_name": "  aria k "}, headers=aria["headers"]
    )
    assert response.status_code == 204, response.text

    for model, where in [
        (Student, Student.id == sid),
        (StudentCredential, StudentCredential.student_id == sid),
        (StudentSession, StudentSession.student_id == sid),
        (StudentDocument, StudentDocument.student_id == sid),
        (Enrolment, Enrolment.student_id == sid),
        (Attempt, Attempt.student_id == sid),
        (Event, Event.student_id == sid),
        (AssignmentNote, AssignmentNote.student_id == sid),
    ]:
        assert await count(session, model, where) == 0, model.__name__
    assert await count(session, Mark) == 0
    assert await count(session, Submission) == 0
    # The class and its homework are not the child's: they stay.
    assert await count(session, Assignment, Assignment.id == uuid.UUID(aria["assignment_id"])) == 1
    # The child's session is gone, so their next request is not signed in.
    assert (await client.get("/auth/student/me")).status_code == 401


async def test_deleting_one_child_leaves_another_childs_work_alone(
    client, session: AsyncSession, signed_in_student
):
    aria = await child_with_work(client, session, signed_in_student)
    bella = await child_with_work(client, session, signed_in_student, name="Bella N")
    deleted = await client.post(
        f"/students/{aria['student_id']}/delete",
        json={"confirm_name": "Aria K"},
        headers=aria["headers"],
    )
    assert deleted.status_code == 204, deleted.text
    bid = uuid.UUID(bella["student_id"])
    assert await count(session, Student, Student.id == bid) == 1
    assert await count(session, Attempt, Attempt.student_id == bid) == 1
    assert await count(session, StudentDocument, StudentDocument.student_id == bid) == 1
    assert await count(session, Mark) == 1, "Bella's mark is still there"


async def test_the_audit_keeps_the_deletion_but_not_the_name(
    client, session: AsyncSession, signed_in_student
):
    aria = await child_with_work(client, session, signed_in_student)
    sid = uuid.UUID(aria["student_id"])
    await client.post(
        f"/students/{sid}/delete", json={"confirm_name": "Aria K"}, headers=aria["headers"]
    )
    rows = (await session.exec(select(AuditLog).where(AuditLog.target_id == sid))).all()
    assert "student.deleted" in [r.action for r in rows]
    assert "Aria" not in str([r.payload for r in rows])


# --- deleting a class ----------------------------------------------------------------------


async def test_deleting_a_class_removes_its_work_but_keeps_the_children(
    client, session: AsyncSession, signed_in_student
):
    aria = await child_with_work(client, session, signed_in_student)
    cid = uuid.UUID(aria["class_id"])
    response = await client.post(
        f"/classes/{cid}/delete",
        json={"confirm_name": "Year 4-6 Python"},
        headers=aria["headers"],
    )
    assert response.status_code == 204, response.text

    for model, where in [
        (Class, Class.id == cid),
        (Assignment, Assignment.class_id == cid),
        (Enrolment, Enrolment.class_id == cid),
        (ClassTeacher, ClassTeacher.class_id == cid),
    ]:
        assert await count(session, model, where) == 0, model.__name__
    assert await count(session, Attempt) == 0
    assert await count(session, Mark) == 0
    assert await count(session, AssignmentNote) == 0
    # The child, and their own files, stay.
    sid = uuid.UUID(aria["student_id"])
    assert await count(session, Student, Student.id == sid) == 1
    assert await count(session, StudentDocument, StudentDocument.student_id == sid) == 1


# --- who may, and the typed name -----------------------------------------------------------


async def test_the_name_must_be_typed_to_confirm(client, session, signed_in_student):
    aria = await child_with_work(client, session, signed_in_student)
    wrong = await client.post(
        f"/students/{aria['student_id']}/delete",
        json={"confirm_name": "Bella"},
        headers=aria["headers"],
    )
    assert wrong.status_code == 422
    wrong_class = await client.post(
        f"/classes/{aria['class_id']}/delete",
        json={"confirm_name": "Year 4"},
        headers=aria["headers"],
    )
    assert wrong_class.status_code == 422
    assert await count(session, Student) == 1


async def test_only_the_owner_can_delete_entirely(client, session, signed_in, signed_in_student):
    aria = await child_with_work(client, session, signed_in_student)
    sam = await signed_in("sam@example.com")  # a teacher, not the owner
    for path, name in [
        (f"/students/{aria['student_id']}/delete", "Aria K"),
        (f"/classes/{aria['class_id']}/delete", "Year 4-6 Python"),
    ]:
        assert (
            await client.post(path, json={"confirm_name": name}, headers=sam)
        ).status_code == 403, path
    # And not a child either: no Authorization header means the student cookie is used.
    assert (
        await client.post(f"/students/{aria['student_id']}/delete", json={"confirm_name": "Aria K"})
    ).status_code == 403
    assert await count(session, Student) == 1


async def test_another_centres_class_or_child_is_not_found(client, signed_in, foreign_centre):
    ken = await signed_in("ken@example.com")
    theirs = foreign_centre
    assert (
        await client.post(
            f"/students/{theirs['student'].id}/delete",
            json={"confirm_name": theirs["student"].display_name},
            headers=ken,
        )
    ).status_code == 404
    assert (
        await client.post(
            f"/classes/{theirs['class'].id}/delete",
            json={"confirm_name": theirs["class"].name},
            headers=ken,
        )
    ).status_code == 404
