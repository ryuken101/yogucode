"""Roster routes: students, enrolment, and the bulk paste.

The tenancy tests carry the most weight in this file. Step 4's equivalents proved a
teacher cannot reach another centre's *class*; these are the first that prove it about
another centre's *child*, which is the leak that actually matters.

`tests/test_schema.py` already covers the constraint layer — that a duplicate enrolment is
rejected, that archiving a student preserves their enrolment. This file tests routes.
"""

import uuid

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.models import (
    AuditLog,
    Enrolment,
    EnrolmentStatus,
    Student,
    StudentSession,
    StudentStatus,
)
from app.models.base import utcnow
from app.roster import MAX_ENTRIES, MAX_NAME_LENGTH, name_key, normalise_name, parse_names


async def make_class(client, headers, name: str = "Year 4-6 Python") -> uuid.UUID:
    response = await client.post("/classes", json={"name": name}, headers=headers)
    assert response.status_code == 201, response.text
    return uuid.UUID(response.json()["id"])


async def make_student(client, headers, display_name: str) -> uuid.UUID:
    response = await client.post("/students", json={"display_name": display_name}, headers=headers)
    assert response.status_code == 201, response.text
    return uuid.UUID(response.json()["id"])


# --- creating and listing students -------------------------------------------------


async def test_create_returns_the_student(client, signed_in) -> None:
    headers = await signed_in()
    response = await client.post("/students", json={"display_name": "Aria K"}, headers=headers)

    assert response.status_code == 201
    body = response.json()
    assert body["display_name"] == "Aria K"
    assert body["status"] == "active"
    assert uuid.UUID(body["id"]).version == 7


async def test_a_new_student_is_enrolled_nowhere(client, signed_in) -> None:
    """A child can exist at the centre between terms."""
    headers = await signed_in()
    student_id = await make_student(client, headers, "Aria K")

    detail = (await client.get(f"/students/{student_id}", headers=headers)).json()
    assert detail["classes"] == []


async def test_creating_a_student_makes_a_complete_account(
    client, signed_in, session: AsyncSession
) -> None:
    """A permanent account (Ken's decision, 11 Oct 2026): a suggested username and a PIN,
    returned once. The PIN is stored hashed, never as typed."""
    from app.models import StudentCredential

    headers = await signed_in()
    created = await client.post("/students", json={"display_name": "Aria Kim"}, headers=headers)
    body = created.json()
    assert body["username"] == "aria.k"
    assert len(body["pin"]) == 4 and body["pin"].isdigit()
    credential = (await session.exec(select(StudentCredential))).one()
    assert credential.pin_hash != body["pin"] and credential.pin_hash.startswith("$argon2id$")


async def test_whitespace_in_a_name_is_normalised(client, signed_in) -> None:
    headers = await signed_in()
    response = await client.post(
        "/students", json={"display_name": "  Aria   K  "}, headers=headers
    )
    assert response.json()["display_name"] == "Aria K"


async def test_an_empty_name_is_rejected(client, signed_in) -> None:
    headers = await signed_in()
    assert (
        await client.post("/students", json={"display_name": ""}, headers=headers)
    ).status_code == 422


async def test_an_over_long_name_is_rejected(client, signed_in) -> None:
    headers = await signed_in()
    response = await client.post(
        "/students", json={"display_name": "A" * (MAX_NAME_LENGTH + 1)}, headers=headers
    )
    assert response.status_code == 422


async def test_the_student_list_is_alphabetical_not_newest_first(client, signed_in) -> None:
    """A roster is read down the page at roll call, unlike the class list."""
    headers = await signed_in()
    for name in ("Chen W", "aria k", "Bella N"):
        await make_student(client, headers, name)

    listed = (await client.get("/students", headers=headers)).json()
    assert [item["display_name"] for item in listed] == ["aria k", "Bella N", "Chen W"]


async def test_archived_students_are_hidden_by_default(client, signed_in) -> None:
    headers = await signed_in()
    student_id = await make_student(client, headers, "Aria K")
    await client.post(f"/students/{student_id}/archive", headers=headers)

    assert (await client.get("/students", headers=headers)).json() == []
    included = (await client.get("/students?include_archived=true", headers=headers)).json()
    assert [item["display_name"] for item in included] == ["Aria K"]


async def test_two_students_may_share_a_name_at_the_centre(client, signed_in) -> None:
    """Legitimate: two distinct children called Aiden C, in different classes."""
    headers = await signed_in()
    await make_student(client, headers, "Aiden C")
    second = await client.post("/students", json={"display_name": "Aiden C"}, headers=headers)
    assert second.status_code == 201


# --- renaming ----------------------------------------------------------------------


async def test_rename_persists(client, signed_in) -> None:
    headers = await signed_in()
    student_id = await make_student(client, headers, "Aiden")

    response = await client.patch(
        f"/students/{student_id}", json={"display_name": "Aiden C"}, headers=headers
    )
    assert response.status_code == 200
    assert response.json()["display_name"] == "Aiden C"
    assert (await client.get(f"/students/{student_id}", headers=headers)).json()[
        "display_name"
    ] == "Aiden C"


async def test_an_empty_rename_is_rejected(client, signed_in) -> None:
    headers = await signed_in()
    student_id = await make_student(client, headers, "Aria K")
    response = await client.patch(
        f"/students/{student_id}", json={"display_name": ""}, headers=headers
    )
    assert response.status_code == 422


# --- archiving -------------------------------------------------------------------


async def test_archiving_withdraws_active_enrolments(
    client, signed_in, session: AsyncSession
) -> None:
    """Unlike archiving a class: the child has left, so withdrawal is the honest record."""
    headers = await signed_in()
    class_id = await make_class(client, headers)
    student_id = await make_student(client, headers, "Aria K")
    await client.post(
        f"/classes/{class_id}/enrolments", json={"student_id": str(student_id)}, headers=headers
    )

    await client.post(f"/students/{student_id}/archive", headers=headers)

    enrolment = (await session.exec(select(Enrolment))).one()
    assert enrolment.status == EnrolmentStatus.WITHDRAWN
    assert enrolment.withdrawn_at is not None
    # The row survives with its joined_at — a state change, not a deletion.
    assert enrolment.joined_at is not None


async def test_archiving_revokes_live_sessions(client, signed_in, session: AsyncSession) -> None:
    """An archived student must not still be signed in on a centre laptop."""
    headers = await signed_in()
    student_id = await make_student(client, headers, "Aria K")

    already_revoked_at = utcnow()
    expires = utcnow()
    session.add_all(
        [
            StudentSession(student_id=student_id, token_hash="live-one", expires_at=expires),
            StudentSession(student_id=student_id, token_hash="live-two", expires_at=expires),
            StudentSession(
                student_id=student_id,
                token_hash="already-gone",
                expires_at=expires,
                revoked_at=already_revoked_at,
            ),
        ]
    )
    await session.flush()

    await client.post(f"/students/{student_id}/archive", headers=headers)

    sessions = (await session.exec(select(StudentSession))).all()
    assert all(s.revoked_at is not None for s in sessions)
    old = next(s for s in sessions if s.token_hash == "already-gone")
    assert old.revoked_at == already_revoked_at


async def test_the_archive_audit_records_which_classes_were_withdrawn(
    client, signed_in, session: AsyncSession
) -> None:
    headers = await signed_in()
    first = await make_class(client, headers, "Year 4-6 Python")
    second = await make_class(client, headers, "Holiday workshop")
    student_id = await make_student(client, headers, "Aria K")
    for class_id in (first, second):
        await client.post(
            f"/classes/{class_id}/enrolments",
            json={"student_id": str(student_id)},
            headers=headers,
        )

    await client.post(f"/students/{student_id}/archive", headers=headers)

    entry = (
        await session.exec(select(AuditLog).where(AuditLog.action == "student.archived"))
    ).one()
    assert sorted(entry.payload["enrolments_withdrawn"]) == sorted([str(first), str(second)])
    assert entry.payload["sessions_revoked"] == 0


async def test_unarchive_restores_the_student_but_not_the_enrolment(
    client, signed_in, session: AsyncSession
) -> None:
    """Mirrors unarchive_class leaving revoked join codes revoked."""
    headers = await signed_in()
    class_id = await make_class(client, headers)
    student_id = await make_student(client, headers, "Aria K")
    await client.post(
        f"/classes/{class_id}/enrolments", json={"student_id": str(student_id)}, headers=headers
    )
    await client.post(f"/students/{student_id}/archive", headers=headers)

    response = await client.post(f"/students/{student_id}/unarchive", headers=headers)
    assert response.status_code == 200
    assert response.json()["status"] == "active"

    enrolment = (await session.exec(select(Enrolment))).one()
    assert enrolment.status == EnrolmentStatus.WITHDRAWN


# --- enrolment -------------------------------------------------------------------


async def test_enrolling_puts_the_student_on_the_roster(client, signed_in) -> None:
    headers = await signed_in()
    class_id = await make_class(client, headers)
    student_id = await make_student(client, headers, "Aria K")

    response = await client.post(
        f"/classes/{class_id}/enrolments", json={"student_id": str(student_id)}, headers=headers
    )
    assert response.status_code == 201
    assert response.json()["display_name"] == "Aria K"
    assert response.json()["status"] == "active"

    roster = (await client.get(f"/classes/{class_id}/roster", headers=headers)).json()
    assert [entry["display_name"] for entry in roster] == ["Aria K"]


async def test_the_roster_is_alphabetical(client, signed_in) -> None:
    headers = await signed_in()
    class_id = await make_class(client, headers)
    for name in ("Chen W", "Aria K", "Bella N"):
        student_id = await make_student(client, headers, name)
        await client.post(
            f"/classes/{class_id}/enrolments",
            json={"student_id": str(student_id)},
            headers=headers,
        )

    roster = (await client.get(f"/classes/{class_id}/roster", headers=headers)).json()
    assert [entry["display_name"] for entry in roster] == ["Aria K", "Bella N", "Chen W"]


async def test_enrolling_twice_is_idempotent(client, signed_in, session: AsyncSession) -> None:
    headers = await signed_in()
    class_id = await make_class(client, headers)
    student_id = await make_student(client, headers, "Aria K")

    for _ in range(2):
        response = await client.post(
            f"/classes/{class_id}/enrolments",
            json={"student_id": str(student_id)},
            headers=headers,
        )
        assert response.status_code == 201

    assert len((await session.exec(select(Enrolment))).all()) == 1


async def test_a_second_student_with_the_same_name_in_one_class_is_refused(
    client, signed_in
) -> None:
    """Step 7's name picker would show two identical buttons to a nine-year-old."""
    headers = await signed_in()
    class_id = await make_class(client, headers)
    first = await make_student(client, headers, "Aiden C")
    second = await make_student(client, headers, "aiden  c")
    await client.post(
        f"/classes/{class_id}/enrolments", json={"student_id": str(first)}, headers=headers
    )

    response = await client.post(
        f"/classes/{class_id}/enrolments", json={"student_id": str(second)}, headers=headers
    )
    assert response.status_code == 409
    assert "Aiden C" in response.json()["detail"]


async def test_the_same_name_in_two_different_classes_is_fine(client, signed_in) -> None:
    headers = await signed_in()
    first_class = await make_class(client, headers, "Year 4-6 Python")
    second_class = await make_class(client, headers, "Holiday workshop")
    first = await make_student(client, headers, "Aiden C")
    second = await make_student(client, headers, "Aiden C")

    assert (
        await client.post(
            f"/classes/{first_class}/enrolments",
            json={"student_id": str(first)},
            headers=headers,
        )
    ).status_code == 201
    assert (
        await client.post(
            f"/classes/{second_class}/enrolments",
            json={"student_id": str(second)},
            headers=headers,
        )
    ).status_code == 201


async def test_withdrawing_keeps_the_row_and_hides_it_from_the_roster(
    client, signed_in, session: AsyncSession
) -> None:
    headers = await signed_in()
    class_id = await make_class(client, headers)
    student_id = await make_student(client, headers, "Aria K")
    await client.post(
        f"/classes/{class_id}/enrolments", json={"student_id": str(student_id)}, headers=headers
    )

    response = await client.post(
        f"/classes/{class_id}/enrolments/{student_id}/withdraw", headers=headers
    )
    assert response.status_code == 200
    assert response.json()["status"] == "withdrawn"

    assert (await client.get(f"/classes/{class_id}/roster", headers=headers)).json() == []
    included = (
        await client.get(f"/classes/{class_id}/roster?include_withdrawn=true", headers=headers)
    ).json()
    assert [entry["display_name"] for entry in included] == ["Aria K"]
    assert len((await session.exec(select(Enrolment))).all()) == 1


async def test_reinstating_reuses_the_original_enrolment_row(
    client, signed_in, session: AsyncSession
) -> None:
    """uq_enrolments_class_student forbids a second row, so the first must come back."""
    headers = await signed_in()
    class_id = await make_class(client, headers)
    student_id = await make_student(client, headers, "Aria K")
    await client.post(
        f"/classes/{class_id}/enrolments", json={"student_id": str(student_id)}, headers=headers
    )
    original = (await session.exec(select(Enrolment))).one()
    original_id, original_joined = original.id, original.joined_at

    await client.post(f"/classes/{class_id}/enrolments/{student_id}/withdraw", headers=headers)
    response = await client.post(
        f"/classes/{class_id}/enrolments/{student_id}/reinstate", headers=headers
    )
    assert response.status_code == 200
    assert response.json()["status"] == "active"

    revived = (await session.exec(select(Enrolment))).one()
    assert revived.id == original_id
    assert revived.withdrawn_at is None
    # joined_at records when they first joined this class, which Phase 8 reads.
    assert revived.joined_at == original_joined


async def test_enrolling_an_archived_student_brings_them_back(client, signed_in) -> None:
    headers = await signed_in()
    class_id = await make_class(client, headers)
    student_id = await make_student(client, headers, "Aria K")
    await client.post(f"/students/{student_id}/archive", headers=headers)

    response = await client.post(
        f"/classes/{class_id}/enrolments", json={"student_id": str(student_id)}, headers=headers
    )
    assert response.status_code == 201
    assert response.json()["student_status"] == "active"


async def test_withdrawing_someone_who_was_never_enrolled_is_404(client, signed_in) -> None:
    headers = await signed_in()
    class_id = await make_class(client, headers)
    student_id = await make_student(client, headers, "Aria K")
    response = await client.post(
        f"/classes/{class_id}/enrolments/{student_id}/withdraw", headers=headers
    )
    assert response.status_code == 404


async def test_the_student_detail_lists_their_classes(client, signed_in) -> None:
    headers = await signed_in()
    class_id = await make_class(client, headers, "Year 4-6 Python")
    student_id = await make_student(client, headers, "Aria K")
    await client.post(
        f"/classes/{class_id}/enrolments", json={"student_id": str(student_id)}, headers=headers
    )
    await client.post(f"/classes/{class_id}/enrolments/{student_id}/withdraw", headers=headers)

    detail = (await client.get(f"/students/{student_id}", headers=headers)).json()
    assert len(detail["classes"]) == 1
    assert detail["classes"][0]["name"] == "Year 4-6 Python"
    # Withdrawn enrolments are history, and the question is about history.
    assert detail["classes"][0]["status"] == "withdrawn"


# --- parsing a paste ---------------------------------------------------------------


def test_blank_lines_are_dropped_not_reported() -> None:
    parsed = parse_names("Aria K\n\n\nBella N\n")
    assert [entry.name for entry in parsed.entries] == ["Aria K", "Bella N"]


def test_tabs_separate_names_so_a_pasted_spreadsheet_row_works() -> None:
    parsed = parse_names("Aria K\tBella N\tChen W")
    assert [entry.name for entry in parsed.entries] == ["Aria K", "Bella N", "Chen W"]


def test_commas_do_not_separate_names() -> None:
    """Deliberate: guessing wrong here silently splits one child into two."""
    parsed = parse_names("Aria K, Bella N")
    assert [entry.name for entry in parsed.entries] == ["Aria K, Bella N"]


def test_line_numbers_survive_dropped_blanks() -> None:
    parsed = parse_names("Aria K\n\nBella N")
    assert [(entry.line, entry.name) for entry in parsed.entries] == [(1, "Aria K"), (3, "Bella N")]


def test_internal_whitespace_is_collapsed() -> None:
    assert normalise_name("  Aria    K ") == "Aria K"
    assert name_key("Aria    K") == name_key("aria k")


def test_an_over_long_pasted_name_is_flagged_not_dropped() -> None:
    parsed = parse_names("A" * (MAX_NAME_LENGTH + 1))
    assert parsed.entries[0].problem is not None


def test_a_paste_beyond_the_cap_is_truncated_and_says_so() -> None:
    parsed = parse_names("\n".join(f"Student {i}" for i in range(MAX_ENTRIES + 10)))
    assert parsed.truncated is True
    assert len(parsed.entries) == MAX_ENTRIES


# --- the bulk preview -------------------------------------------------------------


async def test_preview_proposes_creating_unknown_names(client, signed_in) -> None:
    headers = await signed_in()
    class_id = await make_class(client, headers)

    response = await client.post(
        f"/classes/{class_id}/roster/preview",
        json={"names": "Aria K\nBella N"},
        headers=headers,
    )
    assert response.status_code == 200
    entries = response.json()["entries"]
    assert [entry["action"] for entry in entries] == ["create", "create"]
    assert [entry["display_name"] for entry in entries] == ["Aria K", "Bella N"]


async def test_preview_proposes_enrolling_a_student_the_centre_already_has(
    client, signed_in
) -> None:
    """The whole reason students hang off a centre: mastery follows a child across terms."""
    headers = await signed_in()
    last_term = await make_class(client, headers, "2026 T2")
    this_term = await make_class(client, headers, "2026 T4")
    student_id = await make_student(client, headers, "Bella N")
    await client.post(
        f"/classes/{last_term}/enrolments", json={"student_id": str(student_id)}, headers=headers
    )

    entries = (
        await client.post(
            f"/classes/{this_term}/roster/preview", json={"names": "bella  n"}, headers=headers
        )
    ).json()["entries"]
    assert entries[0]["action"] == "enrol_existing"
    assert entries[0]["student_id"] == str(student_id)


async def test_preview_marks_a_student_already_in_this_class(client, signed_in) -> None:
    headers = await signed_in()
    class_id = await make_class(client, headers)
    student_id = await make_student(client, headers, "Aria K")
    await client.post(
        f"/classes/{class_id}/enrolments", json={"student_id": str(student_id)}, headers=headers
    )

    entries = (
        await client.post(
            f"/classes/{class_id}/roster/preview", json={"names": "Aria K"}, headers=headers
        )
    ).json()["entries"]
    assert entries[0]["action"] == "already_enrolled"
    assert entries[0]["student_id"] == str(student_id)


async def test_preview_marks_a_repeated_line_as_a_duplicate(client, signed_in) -> None:
    headers = await signed_in()
    class_id = await make_class(client, headers)

    entries = (
        await client.post(
            f"/classes/{class_id}/roster/preview",
            json={"names": "Aria K\nBella N\naria k"},
            headers=headers,
        )
    ).json()["entries"]
    assert [entry["action"] for entry in entries] == ["create", "create", "duplicate_in_paste"]


async def test_preview_marks_a_name_the_centre_has_twice_as_ambiguous(client, signed_in) -> None:
    headers = await signed_in()
    class_id = await make_class(client, headers)
    first = await make_student(client, headers, "Aiden C")
    second = await make_student(client, headers, "Aiden C")

    entries = (
        await client.post(
            f"/classes/{class_id}/roster/preview", json={"names": "Aiden C"}, headers=headers
        )
    ).json()["entries"]
    assert entries[0]["action"] == "ambiguous"
    assert sorted(c["student_id"] for c in entries[0]["candidates"]) == sorted(
        [str(first), str(second)]
    )


async def test_preview_marks_an_unusable_name_as_invalid(client, signed_in) -> None:
    headers = await signed_in()
    class_id = await make_class(client, headers)

    entries = (
        await client.post(
            f"/classes/{class_id}/roster/preview",
            json={"names": "A" * (MAX_NAME_LENGTH + 1)},
            headers=headers,
        )
    ).json()["entries"]
    assert entries[0]["action"] == "invalid"
    assert entries[0]["reason"] is not None


async def test_preview_writes_nothing(client, signed_in, session: AsyncSession) -> None:
    """A teacher reads this back before anything happens to a child's record."""
    headers = await signed_in()
    class_id = await make_class(client, headers)

    await client.post(
        f"/classes/{class_id}/roster/preview",
        json={"names": "Aria K\nBella N\nChen W"},
        headers=headers,
    )

    assert (await session.exec(select(Student))).all() == []
    assert (await session.exec(select(Enrolment))).all() == []
    roster_audit = (
        await session.exec(select(AuditLog).where(AuditLog.target_type == "student"))
    ).all()
    assert roster_audit == []


# --- the bulk commit --------------------------------------------------------------


async def test_bulk_adds_twelve_names_in_one_request(client, signed_in) -> None:
    """The manual acceptance test from the phase plan: bulk-add twelve names."""
    headers = await signed_in()
    class_id = await make_class(client, headers)
    names = [f"Student {i:02d}" for i in range(12)]

    preview = (
        await client.post(
            f"/classes/{class_id}/roster/preview",
            json={"names": "\n".join(names)},
            headers=headers,
        )
    ).json()
    assert all(entry["action"] == "create" for entry in preview["entries"])

    response = await client.post(
        f"/classes/{class_id}/roster/bulk",
        json={"entries": [{"display_name": entry["display_name"]} for entry in preview["entries"]]},
        headers=headers,
    )
    assert response.status_code == 201
    assert len(response.json()) == 12

    roster = (await client.get(f"/classes/{class_id}/roster", headers=headers)).json()
    assert [entry["display_name"] for entry in roster] == names


async def test_bulk_reuses_an_existing_student_rather_than_duplicating(
    client, signed_in, session: AsyncSession
) -> None:
    """Posting a name the centre already knows enrols that child, not a second one."""
    headers = await signed_in()
    this_term = await make_class(client, headers, "2026 T4")
    existing = await make_student(client, headers, "Bella N")

    response = await client.post(
        f"/classes/{this_term}/roster/bulk",
        json={"entries": [{"display_name": "bella n"}, {"display_name": "Chen W"}]},
        headers=headers,
    )
    assert response.status_code == 201

    students = (await session.exec(select(Student))).all()
    assert len(students) == 2
    assert existing in [student.id for student in students]


async def test_bulk_accepts_an_explicit_student_id(client, signed_in) -> None:
    """How the preview's ambiguous verdict gets resolved: the teacher picks a child."""
    headers = await signed_in()
    class_id = await make_class(client, headers)
    first = await make_student(client, headers, "Aiden C")
    await make_student(client, headers, "Aiden C")

    response = await client.post(
        f"/classes/{class_id}/roster/bulk",
        json={"entries": [{"student_id": str(first)}]},
        headers=headers,
    )
    assert response.status_code == 201
    assert response.json()[0]["student_id"] == str(first)


async def test_bulk_rejects_an_entry_naming_both_or_neither(client, signed_in) -> None:
    headers = await signed_in()
    class_id = await make_class(client, headers)

    for entry in ({}, {"display_name": "Aria K", "student_id": str(uuid.uuid4())}):
        response = await client.post(
            f"/classes/{class_id}/roster/bulk", json={"entries": [entry]}, headers=headers
        )
        assert response.status_code == 422, entry


async def test_bulk_is_all_or_nothing(client, signed_in, session: AsyncSession) -> None:
    """One bad line should not leave a teacher working out which eleven went through."""
    headers = await signed_in()
    class_id = await make_class(client, headers)

    response = await client.post(
        f"/classes/{class_id}/roster/bulk",
        json={
            "entries": [
                {"display_name": "Aria K"},
                {"display_name": "Bella N"},
                {"display_name": "A" * (MAX_NAME_LENGTH + 1)},
            ]
        },
        headers=headers,
    )
    assert response.status_code == 422
    assert (await session.exec(select(Student))).all() == []
    assert (await session.exec(select(Enrolment))).all() == []


async def test_bulk_rejects_a_duplicate_within_the_submission(client, signed_in) -> None:
    headers = await signed_in()
    class_id = await make_class(client, headers)

    response = await client.post(
        f"/classes/{class_id}/roster/bulk",
        json={"entries": [{"display_name": "Aria K"}, {"display_name": "aria  k"}]},
        headers=headers,
    )
    assert response.status_code == 422
    assert response.json()["detail"]["entries"][0]["action"] == "duplicate_in_paste"


async def test_bulk_rejects_an_ambiguous_name(client, signed_in) -> None:
    headers = await signed_in()
    class_id = await make_class(client, headers)
    await make_student(client, headers, "Aiden C")
    await make_student(client, headers, "Aiden C")

    response = await client.post(
        f"/classes/{class_id}/roster/bulk",
        json={"entries": [{"display_name": "Aiden C"}]},
        headers=headers,
    )
    assert response.status_code == 422
    assert response.json()["detail"]["entries"][0]["action"] == "ambiguous"


async def test_bulk_rejects_a_name_that_would_collide_with_a_classmate(client, signed_in) -> None:
    headers = await signed_in()
    class_id = await make_class(client, headers)
    enrolled = await make_student(client, headers, "Aiden C")
    other = await make_student(client, headers, "Aiden C")
    await client.post(
        f"/classes/{class_id}/enrolments", json={"student_id": str(enrolled)}, headers=headers
    )

    response = await client.post(
        f"/classes/{class_id}/roster/bulk",
        json={"entries": [{"student_id": str(other)}]},
        headers=headers,
    )
    assert response.status_code == 422
    assert response.json()["detail"]["entries"][0]["action"] == "name_clash"


async def test_resubmitting_a_paste_verbatim_is_safe(
    client, signed_in, session: AsyncSession
) -> None:
    headers = await signed_in()
    class_id = await make_class(client, headers)
    payload = {"entries": [{"display_name": "Aria K"}, {"display_name": "Bella N"}]}

    first = await client.post(f"/classes/{class_id}/roster/bulk", json=payload, headers=headers)
    second = await client.post(f"/classes/{class_id}/roster/bulk", json=payload, headers=headers)

    assert first.status_code == 201
    assert second.status_code == 201
    assert len(second.json()) == 2
    assert len((await session.exec(select(Student))).all()) == 2
    assert len((await session.exec(select(Enrolment))).all()) == 2


async def test_bulk_reinstates_a_withdrawn_student(
    client, signed_in, session: AsyncSession
) -> None:
    headers = await signed_in()
    class_id = await make_class(client, headers)
    student_id = await make_student(client, headers, "Aria K")
    await client.post(
        f"/classes/{class_id}/enrolments", json={"student_id": str(student_id)}, headers=headers
    )
    await client.post(f"/classes/{class_id}/enrolments/{student_id}/withdraw", headers=headers)

    response = await client.post(
        f"/classes/{class_id}/roster/bulk",
        json={"entries": [{"display_name": "Aria K"}]},
        headers=headers,
    )
    assert response.status_code == 201
    assert response.json()[0]["status"] == "active"
    assert len((await session.exec(select(Enrolment))).all()) == 1


# --- the tenancy boundary --------------------------------------------------------


async def test_another_centres_student_is_not_listed(client, signed_in, foreign_centre) -> None:
    headers = await signed_in()
    listed = (await client.get("/students?include_archived=true", headers=headers)).json()
    assert listed == []


async def test_another_centres_student_cannot_be_read(client, signed_in, foreign_centre) -> None:
    headers = await signed_in()
    foreign = foreign_centre["student"]
    response = await client.get(f"/students/{foreign.id}", headers=headers)
    assert response.status_code == 404


async def test_another_centres_student_cannot_be_modified(
    client, signed_in, foreign_centre, session: AsyncSession
) -> None:
    headers = await signed_in()
    foreign = foreign_centre["student"]

    for method, path in (
        ("patch", f"/students/{foreign.id}"),
        ("post", f"/students/{foreign.id}/archive"),
        ("post", f"/students/{foreign.id}/unarchive"),
    ):
        response = await client.request(
            method, path, json={"display_name": "Hijacked"}, headers=headers
        )
        assert response.status_code == 404, f"{method} {path}"

    await session.refresh(foreign)
    assert foreign.display_name == "Someone else's child"
    assert foreign.status == StudentStatus.ACTIVE


async def test_another_centres_student_cannot_be_enrolled_in_your_class(
    client, signed_in, foreign_centre, session: AsyncSession
) -> None:
    headers = await signed_in()
    class_id = await make_class(client, headers)
    foreign = foreign_centre["student"]

    response = await client.post(
        f"/classes/{class_id}/enrolments", json={"student_id": str(foreign.id)}, headers=headers
    )
    assert response.status_code == 404
    assert len((await session.exec(select(Enrolment))).all()) == 1  # only the foreign one


async def test_your_student_cannot_be_enrolled_in_another_centres_class(
    client, signed_in, foreign_centre, session: AsyncSession
) -> None:
    headers = await signed_in()
    student_id = await make_student(client, headers, "Aria K")
    foreign_class = foreign_centre["class"]

    response = await client.post(
        f"/classes/{foreign_class.id}/enrolments",
        json={"student_id": str(student_id)},
        headers=headers,
    )
    assert response.status_code == 404
    assert len((await session.exec(select(Enrolment))).all()) == 1


async def test_bulk_refuses_a_student_id_from_another_centre(
    client, signed_in, foreign_centre, session: AsyncSession
) -> None:
    headers = await signed_in()
    class_id = await make_class(client, headers)
    foreign = foreign_centre["student"]

    response = await client.post(
        f"/classes/{class_id}/roster/bulk",
        json={"entries": [{"display_name": "Aria K"}, {"student_id": str(foreign.id)}]},
        headers=headers,
    )
    assert response.status_code == 404
    assert (await session.exec(select(Student).where(Student.display_name == "Aria K"))).all() == []


async def test_a_hand_written_cross_centre_enrolment_stays_off_the_roster(
    client, signed_in, foreign_centre, session: AsyncSession
) -> None:
    """The belt-and-braces half of `list_class_roster`'s filter, given something to catch.

    No route can write this row — both ids go through `scoping` first. It is inserted
    directly here because the filter on `Student.centre_id` is otherwise untestable, and an
    untested filter is one a later refactor deletes as redundant.
    """
    headers = await signed_in()
    class_id = await make_class(client, headers)
    mine = await make_student(client, headers, "Aria K")
    await client.post(
        f"/classes/{class_id}/enrolments", json={"student_id": str(mine)}, headers=headers
    )

    session.add(Enrolment(class_id=class_id, student_id=foreign_centre["student"].id))
    await session.flush()

    roster = (
        await client.get(f"/classes/{class_id}/roster?include_withdrawn=true", headers=headers)
    ).json()
    assert [entry["display_name"] for entry in roster] == ["Aria K"]


async def test_another_centres_roster_cannot_be_read(client, signed_in, foreign_centre) -> None:
    headers = await signed_in()
    foreign_class = foreign_centre["class"]
    response = await client.get(f"/classes/{foreign_class.id}/roster", headers=headers)
    assert response.status_code == 404


async def test_another_centres_roster_cannot_be_pasted_into(
    client, signed_in, foreign_centre
) -> None:
    headers = await signed_in()
    foreign_class = foreign_centre["class"]

    for path in (
        f"/classes/{foreign_class.id}/roster/preview",
        f"/classes/{foreign_class.id}/roster/bulk",
    ):
        response = await client.post(
            path, json={"names": "Aria K", "entries": [{"display_name": "Aria K"}]}, headers=headers
        )
        assert response.status_code == 404, path


async def test_a_paste_cannot_name_a_child_at_another_centre(
    client, signed_in, foreign_centre
) -> None:
    """The preview must not confirm that another centre's child exists."""
    headers = await signed_in()
    class_id = await make_class(client, headers)

    entries = (
        await client.post(
            f"/classes/{class_id}/roster/preview",
            json={"names": "Someone else's child"},
            headers=headers,
        )
    ).json()["entries"]
    assert entries[0]["action"] == "create"
    assert entries[0]["student_id"] is None


async def test_an_unknown_student_id_is_also_404(client, signed_in) -> None:
    headers = await signed_in()
    assert (await client.get(f"/students/{uuid.uuid4()}", headers=headers)).status_code == 404


# --- authentication ---------------------------------------------------------------


async def test_every_roster_route_requires_a_signed_in_teacher(client) -> None:
    class_id = uuid.uuid4()
    student_id = uuid.uuid4()
    calls = [
        ("get", "/students", None),
        ("post", "/students", {"display_name": "x"}),
        ("get", f"/students/{student_id}", None),
        ("patch", f"/students/{student_id}", {"display_name": "x"}),
        ("post", f"/students/{student_id}/archive", None),
        ("post", f"/students/{student_id}/unarchive", None),
        ("get", f"/classes/{class_id}/roster", None),
        ("post", f"/classes/{class_id}/enrolments", {"student_id": str(student_id)}),
        ("post", f"/classes/{class_id}/enrolments/{student_id}/withdraw", None),
        ("post", f"/classes/{class_id}/enrolments/{student_id}/reinstate", None),
        ("post", f"/classes/{class_id}/roster/preview", {"names": "x"}),
        ("post", f"/classes/{class_id}/roster/bulk", {"entries": [{"display_name": "x"}]}),
    ]
    for method, path, payload in calls:
        response = await client.request(method, path, json=payload)
        assert response.status_code == 401, f"{method} {path}"


async def test_a_student_cannot_list_the_roster(client) -> None:
    """From the phase plan's verification list: a student cannot list the roster."""
    client.cookies.set("student_session", "whatever")
    response = await client.get(f"/classes/{uuid.uuid4()}/roster")
    assert response.status_code == 401


async def test_a_second_teacher_at_the_centre_sees_the_same_roster(client, signed_in) -> None:
    """Teachers cover each other's lessons."""
    ken = await signed_in("ken@example.com")
    class_id = await make_class(client, ken)
    student_id = await make_student(client, ken, "Aria K")
    await client.post(
        f"/classes/{class_id}/enrolments", json={"student_id": str(student_id)}, headers=ken
    )

    sam = await signed_in("sam@example.com")
    roster = (await client.get(f"/classes/{class_id}/roster", headers=sam)).json()
    assert [entry["display_name"] for entry in roster] == ["Aria K"]


# --- audit ------------------------------------------------------------------------


async def test_roster_mutations_are_audited(client, signed_in, session: AsyncSession) -> None:
    headers = await signed_in()
    class_id = await make_class(client, headers)
    student_id = await make_student(client, headers, "Aria")

    await client.patch(f"/students/{student_id}", json={"display_name": "Aria K"}, headers=headers)
    await client.post(
        f"/classes/{class_id}/enrolments", json={"student_id": str(student_id)}, headers=headers
    )
    await client.post(f"/classes/{class_id}/enrolments/{student_id}/withdraw", headers=headers)
    await client.post(f"/classes/{class_id}/enrolments/{student_id}/reinstate", headers=headers)
    await client.post(f"/students/{student_id}/archive", headers=headers)
    await client.post(f"/students/{student_id}/unarchive", headers=headers)

    entries = (await session.exec(select(AuditLog).where(AuditLog.target_type == "student"))).all()
    assert sorted(entry.action for entry in entries) == [
        "enrolment.added",
        "enrolment.reinstated",
        "enrolment.withdrawn",
        "student.archived",
        "student.created",
        "student.renamed",
        "student.unarchived",
    ]
    # Every roster action is keyed to the child, so one read answers "what happened to
    # this student" — including the enrolment verbs, which carry the class in the payload.
    assert {entry.target_id for entry in entries} == {student_id}


async def test_a_no_op_rename_writes_no_audit_row(client, signed_in, session: AsyncSession) -> None:
    headers = await signed_in()
    student_id = await make_student(client, headers, "Aria K")

    await client.patch(f"/students/{student_id}", json={}, headers=headers)
    await client.patch(f"/students/{student_id}", json={"display_name": "Aria K"}, headers=headers)

    actions = [
        entry.action
        for entry in (
            await session.exec(select(AuditLog).where(AuditLog.target_type == "student"))
        ).all()
    ]
    assert actions == ["student.created"]


async def test_a_bulk_add_is_audited_per_child(client, signed_in, session: AsyncSession) -> None:
    """One summary row would be unqueryable by child, which is the only question asked."""
    headers = await signed_in()
    class_id = await make_class(client, headers)

    await client.post(
        f"/classes/{class_id}/roster/bulk",
        json={"entries": [{"display_name": "Aria K"}, {"display_name": "Bella N"}]},
        headers=headers,
    )

    entries = (await session.exec(select(AuditLog).where(AuditLog.target_type == "student"))).all()
    assert sorted(entry.action for entry in entries) == [
        "enrolment.added",
        "enrolment.added",
        "student.created",
        "student.created",
    ]
    assert all(entry.payload.get("via") == "bulk" for entry in entries)
    assert len({entry.target_id for entry in entries}) == 2


async def test_the_class_audit_trail_still_works(client, signed_in, session: AsyncSession) -> None:
    """`_audit` in classes.py now delegates to app.audit — its rows must be unchanged."""
    headers = await signed_in()
    await make_class(client, headers)

    entry = (await session.exec(select(AuditLog).where(AuditLog.action == "class.created"))).one()
    assert entry.target_type == "class"
    assert entry.payload["name"] == "Year 4-6 Python"
