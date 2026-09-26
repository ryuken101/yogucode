"""Join codes: minted with the class, rotated as the remedy, never separately revoked.

The lifecycle decision these tests encode is that a code is an *attribute of the class*,
not a thing a teacher goes and generates. So `create_class` mints one, it lives as long as
the class does, and the only way to change it is a rotate that replaces it atomically.
"""

import uuid

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.join_codes import (
    JOIN_CODE_ALPHABET,
    JOIN_CODE_LENGTH,
    mint_code,
    new_code,
    resolve_code,
)
from app.models import AuditLog, ClassJoinCode

# Reading a code aloud to a room is the whole job, so these must never appear in one.
AMBIGUOUS = set("0O1IL")
VOWELS = set("AEIOU")


async def make_class(client, headers, name: str = "Year 4-6 Python") -> dict:
    response = await client.post("/classes", json={"name": name}, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()


# --- the alphabet -------------------------------------------------------------------


def test_a_code_is_six_characters_from_the_alphabet() -> None:
    code = new_code()
    assert len(code) == JOIN_CODE_LENGTH == 6
    assert set(code) <= set(JOIN_CODE_ALPHABET)


def test_codes_are_never_ambiguous_to_read_aloud() -> None:
    """0/O and 1/I/L are the characters that generate support questions mid-lesson."""
    assert not AMBIGUOUS & set(JOIN_CODE_ALPHABET)
    drawn = "".join(new_code() for _ in range(500))
    assert not AMBIGUOUS & set(drawn)


def test_codes_can_never_spell_a_word() -> None:
    """No vowels, so a generated code cannot be an unfortunate surprise in a kids' app."""
    assert not VOWELS & set(JOIN_CODE_ALPHABET)
    drawn = "".join(new_code() for _ in range(500))
    assert not VOWELS & set(drawn)


def test_codes_are_not_all_the_same() -> None:
    assert len({new_code() for _ in range(200)}) > 190


# --- minted with the class ----------------------------------------------------------


async def test_a_new_class_arrives_with_a_join_code(client, signed_in) -> None:
    headers = await signed_in()
    created = await make_class(client, headers)

    code = created["join_code"]
    assert len(code) == JOIN_CODE_LENGTH
    assert set(code) <= set(JOIN_CODE_ALPHABET)


async def test_the_code_is_on_the_detail_read(client, signed_in) -> None:
    headers = await signed_in()
    created = await make_class(client, headers)

    read = (await client.get(f"/classes/{created['id']}", headers=headers)).json()
    assert read["join_code"] == created["join_code"]


async def test_the_code_is_not_on_the_list(client, signed_in) -> None:
    """A teacher reads the code off the class, so the list does not pay for a join."""
    headers = await signed_in()
    await make_class(client, headers)

    listed = (await client.get("/classes", headers=headers)).json()
    assert "join_code" not in listed[0]


async def test_creating_a_class_writes_exactly_one_code(
    client, signed_in, session: AsyncSession
) -> None:
    headers = await signed_in()
    created = await make_class(client, headers)

    codes = (await session.exec(select(ClassJoinCode))).all()
    assert len(codes) == 1
    assert str(codes[0].class_id) == created["id"]
    assert codes[0].revoked_at is None
    # No expiry: the code lives as long as the class. Rotating is the remedy, not a clock.
    assert codes[0].expires_at is None


async def test_the_creating_teacher_is_recorded(client, signed_in, session: AsyncSession) -> None:
    from app.models import User

    headers = await signed_in()
    await make_class(client, headers)

    teacher = (await session.exec(select(User))).one()
    code = (await session.exec(select(ClassJoinCode))).one()
    assert code.created_by == teacher.id


async def test_two_classes_get_different_codes(client, signed_in) -> None:
    headers = await signed_in()
    first = await make_class(client, headers, "Year 4-6 Python")
    second = await make_class(client, headers, "Holiday workshop")
    assert first["join_code"] != second["join_code"]


# --- rotating -----------------------------------------------------------------------


async def test_rotate_returns_a_different_code(client, signed_in) -> None:
    headers = await signed_in()
    created = await make_class(client, headers)

    rotated = await client.post(f"/classes/{created['id']}/join-code/rotate", headers=headers)
    assert rotated.status_code == 200
    assert rotated.json()["join_code"] != created["join_code"]


async def test_rotate_revokes_the_old_code_immediately(
    client, signed_in, session: AsyncSession
) -> None:
    """A leaked code has to stop working now, not at some expiry."""
    headers = await signed_in()
    created = await make_class(client, headers)
    old = created["join_code"]

    await client.post(f"/classes/{created['id']}/join-code/rotate", headers=headers)

    assert await resolve_code(session, old) is None
    stale = (await session.exec(select(ClassJoinCode).where(ClassJoinCode.code == old))).one()
    assert stale.revoked_at is not None


async def test_the_new_code_resolves_to_the_class(client, signed_in, session: AsyncSession) -> None:
    headers = await signed_in()
    created = await make_class(client, headers)

    rotated = (
        await client.post(f"/classes/{created['id']}/join-code/rotate", headers=headers)
    ).json()

    found = await resolve_code(session, rotated["join_code"])
    assert found is not None
    assert str(found.id) == created["id"]


async def test_the_detail_read_follows_the_rotation(client, signed_in) -> None:
    headers = await signed_in()
    created = await make_class(client, headers)
    rotated = (
        await client.post(f"/classes/{created['id']}/join-code/rotate", headers=headers)
    ).json()

    read = (await client.get(f"/classes/{created['id']}", headers=headers)).json()
    assert read["join_code"] == rotated["join_code"]


async def test_rotating_twice_leaves_one_live_code(
    client, signed_in, session: AsyncSession
) -> None:
    headers = await signed_in()
    created = await make_class(client, headers)
    for _ in range(2):
        await client.post(f"/classes/{created['id']}/join-code/rotate", headers=headers)

    codes = (await session.exec(select(ClassJoinCode))).all()
    assert len(codes) == 3
    assert len([c for c in codes if c.revoked_at is None]) == 1


async def test_rotation_is_audited(client, signed_in, session: AsyncSession) -> None:
    headers = await signed_in()
    created = await make_class(client, headers)
    rotated = (
        await client.post(f"/classes/{created['id']}/join-code/rotate", headers=headers)
    ).json()

    entry = (
        await session.exec(select(AuditLog).where(AuditLog.action == "class.join_code_rotated"))
    ).one()
    assert entry.target_type == "class"
    assert entry.payload["code"] == rotated["join_code"]
    assert entry.payload["replaced"] == created["join_code"]


# --- resolving ----------------------------------------------------------------------


async def test_a_code_resolves_case_insensitively(client, signed_in, session: AsyncSession) -> None:
    """A child types what they see on the board, in whatever case they manage."""
    headers = await signed_in()
    created = await make_class(client, headers)

    found = await resolve_code(session, f"  {created['join_code'].lower()}  ")
    assert found is not None
    assert str(found.id) == created["id"]


async def test_an_unknown_code_resolves_to_nothing(session: AsyncSession) -> None:
    assert await resolve_code(session, "ZZZZZZ") is None


async def test_an_empty_code_resolves_to_nothing(session: AsyncSession) -> None:
    assert await resolve_code(session, "   ") is None


async def test_an_archived_classs_code_stops_resolving(
    client, signed_in, session: AsyncSession
) -> None:
    headers = await signed_in()
    created = await make_class(client, headers)
    await client.post(f"/classes/{created['id']}/archive", headers=headers)

    assert await resolve_code(session, created["join_code"]) is None


async def test_unarchiving_does_not_revive_the_code(
    client, signed_in, session: AsyncSession
) -> None:
    """Step 4's rule: revoked codes stay revoked. The teacher rotates a fresh one."""
    headers = await signed_in()
    created = await make_class(client, headers)
    await client.post(f"/classes/{created['id']}/archive", headers=headers)
    await client.post(f"/classes/{created['id']}/unarchive", headers=headers)

    assert await resolve_code(session, created["join_code"]) is None
    read = (await client.get(f"/classes/{created['id']}", headers=headers)).json()
    assert read["join_code"] is None


async def test_a_class_without_a_code_can_be_given_one(
    client, signed_in, session: AsyncSession
) -> None:
    """Classes created before step 6 have no code; a rotate mints the first."""
    headers = await signed_in()
    created = await make_class(client, headers)
    await client.post(f"/classes/{created['id']}/archive", headers=headers)
    await client.post(f"/classes/{created['id']}/unarchive", headers=headers)

    rotated = (
        await client.post(f"/classes/{created['id']}/join-code/rotate", headers=headers)
    ).json()
    assert rotated["join_code"] is not None
    found = await resolve_code(session, rotated["join_code"])
    assert found is not None


async def test_a_collision_draws_again(
    client, signed_in, session: AsyncSession, monkeypatch
) -> None:
    """`code` is globally unique; a collision must retry, not 500 in front of a class."""
    from app import join_codes

    headers = await signed_in()
    created = await make_class(client, headers)
    taken = created["join_code"]

    drawn = iter([taken, "WNPXYZ"])
    monkeypatch.setattr(join_codes, "new_code", lambda: next(drawn))

    from app.auth.principal import Principal
    from app.models import User

    teacher = (await session.exec(select(User))).one()
    principal = Principal(kind="teacher", subject_id=teacher.id, centre_id=teacher.centre_id)
    minted = await join_codes.mint_code(session, principal, uuid.UUID(created["id"]))
    assert minted.code == "WNPXYZ"


# --- the tenancy boundary -----------------------------------------------------------


async def test_another_centres_class_cannot_be_rotated(client, signed_in, foreign_centre) -> None:
    headers = await signed_in()
    foreign = foreign_centre["class"]
    response = await client.post(f"/classes/{foreign.id}/join-code/rotate", headers=headers)
    assert response.status_code == 404


async def test_another_centres_code_is_not_readable(client, signed_in, foreign_centre) -> None:
    headers = await signed_in()
    foreign = foreign_centre["class"]
    assert (await client.get(f"/classes/{foreign.id}", headers=headers)).status_code == 404


async def test_rotate_requires_a_signed_in_teacher(client) -> None:
    response = await client.post(f"/classes/{uuid.uuid4()}/join-code/rotate")
    assert response.status_code == 401


async def test_a_student_cookie_cannot_rotate(client) -> None:
    client.cookies.set("student_session", "whatever")
    response = await client.post(f"/classes/{uuid.uuid4()}/join-code/rotate")
    assert response.status_code == 401


def test_mint_code_is_exported() -> None:
    assert callable(mint_code)


async def test_the_scoping_helper_refuses_another_centres_class(
    client, signed_in, foreign_centre, session: AsyncSession
) -> None:
    """`get_live_join_code`'s own centre filter, given something to catch.

    Every route reaches it through `get_owned_class`, which 404s first, so the filter
    inside the helper is redundant defence — and redundant defence with no test on it is
    what a later refactor deletes as dead weight. This calls the helper directly with a
    principal from the wrong centre, which is the contract it actually promises.
    """
    from app.auth.principal import Principal
    from app.join_codes import mint_code
    from app.models import User
    from app.scoping import get_live_join_code

    await signed_in()
    teacher = (await session.exec(select(User))).one()
    mine = Principal(kind="teacher", subject_id=teacher.id, centre_id=teacher.centre_id)

    foreign_class = foreign_centre["class"]
    foreign_teacher_principal = Principal(
        kind="teacher", subject_id=teacher.id, centre_id=foreign_centre["centre"].id
    )
    await mint_code(session, foreign_teacher_principal, foreign_class.id)
    await session.flush()

    # It exists and is live, but not for this principal.
    assert await get_live_join_code(session, foreign_teacher_principal, foreign_class.id)
    assert await get_live_join_code(session, mine, foreign_class.id) is None
