"""PIN generation, hashing, and session mechanics — the units, without HTTP.

The weak-PIN exclusion and the two expiry clocks are far easier to pin down here than
through a route, and getting them wrong is the kind of thing that only shows up in a
classroom. The HTTP behaviour built on top of these lives in test_student_auth.py.
"""

from datetime import timedelta
from uuid import UUID, uuid4

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.auth.pin import (
    NAMED_WEAK_PINS,
    PIN_LENGTH,
    generate_pin,
    hash_pin,
    is_weak,
    verify_pin,
)
from app.auth.student_session import (
    TOUCH_AFTER_SECONDS,
    mint_session,
    new_token,
    resolve_session,
    revoke_live_sessions,
    token_hash,
)
from app.config import Settings
from app.models import Centre, Student, StudentCredential, StudentSession, StudentStatus
from app.models.base import utcnow


async def a_student(session: AsyncSession, name: str = "Aria K") -> Student:
    centre = (await session.exec(select(Centre))).first()
    if centre is None:
        centre = Centre(name="Magikid Castle Hill", slug="castle-hill")
        session.add(centre)
        await session.flush()
    student = Student(
        centre_id=centre.id, display_name=name, username=name.lower().replace(" ", ".")
    )
    session.add(student)
    await session.flush()
    return student


# --- weak PINs ----------------------------------------------------------------------


def test_the_four_the_plan_names_are_refused() -> None:
    for pin in NAMED_WEAK_PINS:
        assert is_weak(pin), pin


def test_every_digit_the_same_is_refused() -> None:
    assert all(is_weak(f"{d}{d}{d}{d}") for d in range(10))


def test_runs_in_both_directions_are_refused() -> None:
    for pin in ("0123", "1234", "6789", "7890", "9012", "3210", "9876", "0987"):
        assert is_weak(pin), pin


def test_repeated_pairs_are_refused() -> None:
    for pin in ("1212", "4545", "9090", "2323"):
        assert is_weak(pin), pin


def test_an_ordinary_pin_is_fine() -> None:
    for pin in ("4827", "9130", "2571", "8362"):
        assert not is_weak(pin), pin


def test_a_malformed_pin_is_weak() -> None:
    """Anything that is not four digits cannot be a PIN, so it must never pass."""
    for pin in ("", "123", "12345", "abcd", "12a4", "  12"):
        assert is_weak(pin), pin


def test_the_generator_never_draws_a_weak_pin() -> None:
    pins = [generate_pin() for _ in range(3000)]
    assert not [p for p in pins if is_weak(p)]
    assert all(len(p) == PIN_LENGTH and p.isdigit() for p in pins)


def test_the_generator_spreads_across_the_space() -> None:
    """A generator that keeps returning the same PIN would pass every test above."""
    assert len({generate_pin() for _ in range(500)}) > 400


# --- hashing ------------------------------------------------------------------------


def test_a_hash_verifies_its_own_pin() -> None:
    stored = hash_pin("4827")
    assert verify_pin(stored, "4827")
    assert not verify_pin(stored, "4828")


def test_the_pin_is_not_recoverable_from_the_hash() -> None:
    """The reason reset is the only recovery path: nobody can look a PIN up."""
    stored = hash_pin("4827")
    assert "4827" not in stored


def test_the_same_pin_hashes_differently_each_time() -> None:
    assert hash_pin("4827") != hash_pin("4827")


def test_an_unparseable_stored_hash_is_a_refusal_not_a_crash() -> None:
    assert not verify_pin("not-a-hash", "4827")
    assert not verify_pin("", "4827")


# --- session tokens -----------------------------------------------------------------


def test_tokens_are_long_and_unique() -> None:
    tokens = [new_token() for _ in range(200)]
    assert len(set(tokens)) == 200
    assert all(len(t) >= 40 for t in tokens)


def test_only_the_hash_is_storable() -> None:
    token = new_token()
    digest = token_hash(token)
    assert digest != token
    assert len(digest) == 64
    assert token_hash(token) == digest, "hashing is deterministic, or lookup cannot work"


async def test_minting_stores_the_hash_and_never_the_token(
    session: AsyncSession, test_settings: Settings
) -> None:
    student = await a_student(session)
    record, token = await mint_session(session, student, test_settings)

    assert record.token_hash == token_hash(token)
    stored = (await session.exec(select(StudentSession))).one()
    assert stored.token_hash != token


async def test_a_minted_session_carries_both_clocks(
    session: AsyncSession, test_settings: Settings
) -> None:
    student = await a_student(session)
    record, _ = await mint_session(session, student, test_settings)

    assert record.expires_at - record.issued_at == timedelta(
        hours=test_settings.student_session_hours
    )
    assert record.revoked_at is None
    assert record.last_seen_at == record.issued_at


async def test_signing_in_again_revokes_the_previous_session(
    session: AsyncSession, test_settings: Settings
) -> None:
    """One live session per student — an abandoned laptop stops working by itself."""
    student = await a_student(session)
    first, first_token = await mint_session(session, student, test_settings)
    await mint_session(session, student, test_settings)

    assert first.revoked_at is not None
    assert await resolve_session(session, first_token, test_settings) is None
    live = (await session.exec(select(StudentSession))).all()
    assert len([s for s in live if s.revoked_at is None]) == 1


async def test_another_students_session_is_untouched(
    session: AsyncSession, test_settings: Settings
) -> None:
    aria = await a_student(session, "Aria K")
    bella = await a_student(session, "Bella N")
    _, aria_token = await mint_session(session, aria, test_settings)
    await mint_session(session, bella, test_settings)

    assert await resolve_session(session, aria_token, test_settings) is not None


# --- resolving ----------------------------------------------------------------------


async def test_a_live_token_resolves_to_its_student(
    session: AsyncSession, test_settings: Settings
) -> None:
    student = await a_student(session)
    _, token = await mint_session(session, student, test_settings)

    resolved = await resolve_session(session, token, test_settings)
    assert resolved is not None
    _, found = resolved
    # The student comes back because student_sessions has no centre_id and Principal
    # needs one.
    assert found.id == student.id
    assert found.centre_id == student.centre_id


async def test_an_unknown_or_empty_token_resolves_to_nothing(
    session: AsyncSession, test_settings: Settings
) -> None:
    assert await resolve_session(session, "", test_settings) is None
    assert await resolve_session(session, new_token(), test_settings) is None


async def test_a_revoked_session_is_refused(session: AsyncSession, test_settings: Settings) -> None:
    student = await a_student(session)
    _, token = await mint_session(session, student, test_settings)

    assert await revoke_live_sessions(session, student.id) == 1
    assert await resolve_session(session, token, test_settings) is None


async def test_a_session_past_its_absolute_expiry_is_refused(
    session: AsyncSession, test_settings: Settings
) -> None:
    student = await a_student(session)
    record, token = await mint_session(session, student, test_settings)

    record.expires_at = utcnow() - timedelta(seconds=1)
    session.add(record)
    await session.flush()
    assert await resolve_session(session, token, test_settings) is None


async def test_an_idle_session_is_refused_even_while_it_has_not_expired(
    session: AsyncSession, test_settings: Settings
) -> None:
    """The two clocks are independent — an abandoned laptop logs itself out."""
    student = await a_student(session)
    record, token = await mint_session(session, student, test_settings)

    record.last_seen_at = utcnow() - timedelta(
        minutes=test_settings.student_session_idle_minutes + 1
    )
    session.add(record)
    await session.flush()

    assert record.expires_at > utcnow(), "still inside the absolute clock"
    assert await resolve_session(session, token, test_settings) is None


async def test_an_archived_students_session_stops_working(
    session: AsyncSession, test_settings: Settings
) -> None:
    """From the phase plan's verification list: an archived student cannot log in."""
    student = await a_student(session)
    _, token = await mint_session(session, student, test_settings)

    student.status = StudentStatus.ARCHIVED
    session.add(student)
    await session.flush()

    assert await resolve_session(session, token, test_settings) is None


async def test_resolving_moves_the_idle_clock(
    session: AsyncSession, test_settings: Settings
) -> None:
    student = await a_student(session)
    record, token = await mint_session(session, student, test_settings)

    stale = utcnow() - timedelta(seconds=TOUCH_AFTER_SECONDS + 5)
    record.last_seen_at = stale
    session.add(record)
    await session.flush()

    await resolve_session(session, token, test_settings)
    assert record.last_seen_at > stale


async def test_resolving_twice_quickly_does_not_write(
    session: AsyncSession, test_settings: Settings
) -> None:
    """Every read would otherwise become a write, for a minute of extra precision."""
    student = await a_student(session)
    record, token = await mint_session(session, student, test_settings)

    await resolve_session(session, token, test_settings)
    untouched = record.last_seen_at
    await resolve_session(session, token, test_settings)
    assert record.last_seen_at == untouched


async def test_revoking_reports_zero_when_there_is_nothing_live(
    session: AsyncSession,
) -> None:
    student = await a_student(session)
    assert await revoke_live_sessions(session, student.id) == 0


# --- issuing PINs, from the teacher's side ------------------------------------------


async def make_class_with_students(client, headers, *names: str) -> tuple[str, list[str]]:
    """A class whose children were pasted in as a list — so they have usernames but no
    PINs yet, which "Issue missing PINs" then sets for the whole class at once."""
    created = (
        await client.post("/classes", json={"name": "Year 4-6 Python"}, headers=headers)
    ).json()
    added = await client.post(
        f"/classes/{created['id']}/roster/bulk",
        json={"entries": [{"display_name": name} for name in names]},
        headers=headers,
    )
    assert added.status_code == 201, added.text
    by_name = {entry["display_name"]: entry["student_id"] for entry in added.json()}
    return created["id"], [by_name[name] for name in names]


async def test_issuing_pins_covers_the_whole_class_in_one_request(client, signed_in) -> None:
    """The counterpart to bulk roster entry: twelve names, twelve slips, one request."""
    headers = await signed_in()
    class_id, _ = await make_class_with_students(
        client, headers, *[f"Student {i:02d}" for i in range(12)]
    )

    response = await client.post(
        f"/classes/{class_id}/pins", json={"reset_existing": False}, headers=headers
    )
    assert response.status_code == 201
    slips = response.json()
    assert len(slips) == 12
    assert all(len(s["pin"]) == PIN_LENGTH and s["pin"].isdigit() for s in slips)
    assert not [s for s in slips if is_weak(s["pin"])]


async def test_only_the_hash_is_stored(client, signed_in, session: AsyncSession) -> None:
    headers = await signed_in()
    class_id, [student_id] = await make_class_with_students(client, headers, "Aria K")

    slips = (
        await client.post(
            f"/classes/{class_id}/pins", json={"reset_existing": False}, headers=headers
        )
    ).json()

    credential = await session.get(StudentCredential, UUID(student_id))
    assert credential.pin_hash != slips[0]["pin"]
    assert verify_pin(credential.pin_hash, slips[0]["pin"])


async def test_issuing_again_skips_students_who_already_have_one(client, signed_in) -> None:
    """Safe to re-run after adding one child, which is when a teacher will re-run it."""
    headers = await signed_in()
    class_id, _ = await make_class_with_students(client, headers, "Aria K")
    await client.post(f"/classes/{class_id}/pins", json={"reset_existing": False}, headers=headers)

    await client.post(
        f"/classes/{class_id}/roster/bulk",
        json={"entries": [{"display_name": "Bella N"}]},
        headers=headers,
    )

    slips = (
        await client.post(
            f"/classes/{class_id}/pins", json={"reset_existing": False}, headers=headers
        )
    ).json()
    assert [s["display_name"] for s in slips] == ["Bella N"]


async def test_reset_existing_regenerates_for_everyone(client, signed_in) -> None:
    """The answer to 'the slips got lost' — the hash cannot be read back."""
    headers = await signed_in()
    class_id, _ = await make_class_with_students(client, headers, "Aria K", "Bella N")
    first = (
        await client.post(
            f"/classes/{class_id}/pins", json={"reset_existing": False}, headers=headers
        )
    ).json()

    second = (
        await client.post(
            f"/classes/{class_id}/pins", json={"reset_existing": True}, headers=headers
        )
    ).json()

    assert len(second) == 2
    assert {s["pin"] for s in first} != {s["pin"] for s in second}


async def test_a_pin_is_never_written_to_the_audit_log(
    client, signed_in, session: AsyncSession
) -> None:
    from app.models import AuditLog

    headers = await signed_in()
    class_id, _ = await make_class_with_students(client, headers, "Aria K")
    slips = (
        await client.post(
            f"/classes/{class_id}/pins", json={"reset_existing": False}, headers=headers
        )
    ).json()

    entries = (await session.exec(select(AuditLog))).all()
    assert [e for e in entries if e.action == "pin.issued"]
    assert not [e for e in entries if slips[0]["pin"] in str(e.payload)]


async def test_must_change_pin_is_never_set(client, signed_in, session: AsyncSession) -> None:
    """Deliberately dead: the teacher is meant to know the PIN they handed over."""
    headers = await signed_in()
    class_id, [student_id] = await make_class_with_students(client, headers, "Aria K")
    await client.post(f"/classes/{class_id}/pins", json={"reset_existing": False}, headers=headers)
    await client.post(f"/students/{student_id}/pin", json={}, headers=headers)

    credential = await session.get(StudentCredential, UUID(student_id))
    assert credential.must_change_pin is False


# --- resetting one child's PIN ------------------------------------------------------


async def test_reset_returns_a_new_pin(client, signed_in) -> None:
    headers = await signed_in()
    class_id, [student_id] = await make_class_with_students(client, headers, "Aria K")
    issued = (
        await client.post(
            f"/classes/{class_id}/pins", json={"reset_existing": False}, headers=headers
        )
    ).json()[0]["pin"]

    response = await client.post(f"/students/{student_id}/pin", json={}, headers=headers)
    assert response.status_code == 201
    assert response.json()["pin"] != issued
    assert not is_weak(response.json()["pin"])


async def test_reset_works_for_a_student_who_never_had_one(client, signed_in) -> None:
    headers = await signed_in()
    _, [student_id] = await make_class_with_students(client, headers, "Aria K")
    response = await client.post(f"/students/{student_id}/pin", json={}, headers=headers)
    assert response.status_code == 201


async def test_reset_clears_a_lockout(client, signed_in, session: AsyncSession) -> None:
    """A locked-out child plus a teacher reset must be a way back in, immediately."""
    headers = await signed_in()
    class_id, [student_id] = await make_class_with_students(client, headers, "Aria K")
    await client.post(f"/classes/{class_id}/pins", json={"reset_existing": False}, headers=headers)

    credential = await session.get(StudentCredential, UUID(student_id))
    credential.failed_attempts = 5
    credential.locked_until = utcnow() + timedelta(minutes=15)
    session.add(credential)
    await session.flush()

    await client.post(f"/students/{student_id}/pin", json={}, headers=headers)
    assert credential.locked_until is None
    assert credential.failed_attempts == 0


async def test_reset_records_who_did_it(client, signed_in, session: AsyncSession) -> None:
    from app.models import User

    headers = await signed_in()
    _, [student_id] = await make_class_with_students(client, headers, "Aria K")
    await client.post(f"/students/{student_id}/pin", json={}, headers=headers)

    teacher = (await session.exec(select(User))).one()
    credential = await session.get(StudentCredential, UUID(student_id))
    assert credential.pin_set_by == teacher.id


async def test_the_teacher_can_choose_the_pin(client, signed_in, session: AsyncSession) -> None:
    """Ken's decision, 11 Oct 2026: the teacher types a PIN, or leaves it for a random one."""
    headers = await signed_in()
    _, [student_id] = await make_class_with_students(client, headers, "Aria K")
    chosen = await client.post(f"/students/{student_id}/pin", json={"pin": "4827"}, headers=headers)
    assert chosen.status_code == 201
    assert chosen.json()["pin"] == "4827"
    assert chosen.json()["username"] == "aria.k"
    credential = await session.get(StudentCredential, UUID(student_id))
    assert verify_pin(credential.pin_hash, "4827")
    assert credential.pin_hash != "4827", "still stored hashed"


async def test_an_easy_or_malformed_pin_is_refused(client, signed_in) -> None:
    headers = await signed_in()
    _, [student_id] = await make_class_with_students(client, headers, "Aria K")
    for pin in ["1234", "0000", "12a4", "123", "12345"]:
        response = await client.post(
            f"/students/{student_id}/pin", json={"pin": pin}, headers=headers
        )
        assert response.status_code == 422, pin


# --- the tenancy boundary -----------------------------------------------------------


async def test_another_centres_student_cannot_be_given_a_pin(
    client, signed_in, foreign_centre
) -> None:
    headers = await signed_in()
    foreign = foreign_centre["student"]
    assert (
        await client.post(f"/students/{foreign.id}/pin", json={}, headers=headers)
    ).status_code == 404


async def test_another_centres_student_cannot_be_kicked(client, signed_in, foreign_centre) -> None:
    headers = await signed_in()
    foreign = foreign_centre["student"]
    assert (
        await client.post(f"/students/{foreign.id}/sessions/revoke", headers=headers)
    ).status_code == 404


async def test_another_centres_class_cannot_have_pins_issued(
    client, signed_in, foreign_centre
) -> None:
    headers = await signed_in()
    foreign = foreign_centre["class"]
    response = await client.post(
        f"/classes/{foreign.id}/pins", json={"reset_existing": True}, headers=headers
    )
    assert response.status_code == 404


async def test_the_pin_routes_require_a_teacher(client) -> None:
    calls = [
        ("post", f"/classes/{uuid4()}/pins", {"reset_existing": False}),
        ("post", f"/students/{uuid4()}/pin", {}),
        ("post", f"/students/{uuid4()}/sessions/revoke", None),
    ]
    for method, path, payload in calls:
        assert (await client.request(method, path, json=payload)).status_code == 401, path
