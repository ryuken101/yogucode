"""Show PIN (Ken's decision, 16 Oct 2026): a teacher reveals a child's PIN without the slip.

The PIN sits beside its hash as a Fernet token under a key the database never holds. What
matters here, in order: another centre's child stays unreachable, a student cannot reveal
anyone's PIN, every reveal is audited, and the roster never carries the PIN itself.
"""

from cryptography.fernet import Fernet
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.auth.pin import decrypt_pin, encrypt_pin
from app.config import Settings
from app.models import AuditLog, StudentCredential


async def reveal(client, student_id, headers):
    return await client.post(f"/students/{student_id}/pin/reveal", headers=headers)


# --- revealing ----------------------------------------------------------------------


async def test_add_student_then_reveal_returns_the_slip_pin(client, student_on_roster) -> None:
    roster = await student_on_roster()
    response = await reveal(client, roster["student_id"], roster["headers"])
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["pin"] == roster["pin"]
    assert body["username"] == roster["username"]


async def test_reveal_follows_a_change_of_pin(client, student_on_roster) -> None:
    roster = await student_on_roster()
    changed = await client.post(
        f"/students/{roster['student_id']}/pin", json={"pin": "4827"}, headers=roster["headers"]
    )
    assert changed.status_code == 201, changed.text
    assert (await reveal(client, roster["student_id"], roster["headers"])).json()["pin"] == "4827"


async def test_reveal_follows_a_bulk_reissue(client, student_on_roster) -> None:
    roster = await student_on_roster()
    slips = await client.post(
        f"/classes/{roster['class_id']}/pins",
        json={"reset_existing": True},
        headers=roster["headers"],
    )
    assert slips.status_code == 201, slips.text
    (slip,) = slips.json()
    assert (await reveal(client, roster["student_id"], roster["headers"])).json()["pin"] == slip[
        "pin"
    ]


async def test_create_at_the_centre_is_viewable_too(client, signed_in) -> None:
    headers = await signed_in()
    created = await client.post("/students", json={"display_name": "Ben T"}, headers=headers)
    assert created.status_code == 201, created.text
    response = await reveal(client, created.json()["id"], headers)
    assert response.json()["pin"] == created.json()["pin"]


async def test_another_teacher_at_the_centre_may_reveal(client, student_on_roster, signed_in):
    """Every teacher can open every class, so every teacher can help a child sign in."""
    roster = await student_on_roster()
    other = await signed_in("mia@example.com")
    assert (await reveal(client, roster["student_id"], other)).json()["pin"] == roster["pin"]


async def test_the_reveal_is_not_cached(client, student_on_roster) -> None:
    roster = await student_on_roster()
    response = await reveal(client, roster["student_id"], roster["headers"])
    assert response.headers["cache-control"] == "no-store"


async def test_a_reveal_is_audited_without_the_pin(
    client, student_on_roster, session: AsyncSession
) -> None:
    roster = await student_on_roster()
    await reveal(client, roster["student_id"], roster["headers"])
    await reveal(client, roster["student_id"], roster["headers"])
    rows = (await session.exec(select(AuditLog).where(AuditLog.action == "pin.viewed"))).all()
    assert len(rows) == 2
    assert all(str(row.target_id) == roster["student_id"] for row in rows)
    assert all(roster["pin"] not in str(row.payload) for row in rows)


# --- who may not --------------------------------------------------------------------


async def test_another_centres_child_is_404(client, signed_in, foreign_centre) -> None:
    headers = await signed_in()
    response = await reveal(client, foreign_centre["student"].id, headers)
    assert response.status_code == 404


async def test_a_signed_in_student_cannot_reveal(client, signed_in_student) -> None:
    roster = await signed_in_student()
    # The student cookie is on the client; no teacher header.
    response = await reveal(client, roster["student_id"], {})
    assert response.status_code in (401, 403)
    assert "pin" not in response.json()


async def test_without_any_credentials_it_is_401(client, student_on_roster) -> None:
    roster = await student_on_roster()
    response = await reveal(client, roster["student_id"], {})
    assert response.status_code == 401


# --- storage and the roster ---------------------------------------------------------


async def test_the_stored_copy_is_not_the_pin(
    client, student_on_roster, session: AsyncSession
) -> None:
    roster = await student_on_roster()
    credential = await session.get(StudentCredential, roster["student_id"])
    assert credential is not None and credential.pin_ciphertext
    assert roster["pin"] not in credential.pin_ciphertext


async def test_the_roster_says_viewable_and_never_carries_the_pin(
    client, student_on_roster
) -> None:
    roster = await student_on_roster()
    rows = (
        await client.get(f"/classes/{roster['class_id']}/roster", headers=roster["headers"])
    ).json()
    assert [(r["has_pin"], r["pin_viewable"]) for r in rows] == [(True, True)]
    assert all("pin" not in r for r in rows)


async def test_a_pin_set_before_show_pin_is_409_until_changed(
    client, student_on_roster, session: AsyncSession
) -> None:
    roster = await student_on_roster()
    credential = await session.get(StudentCredential, roster["student_id"])
    credential.pin_ciphertext = None
    session.add(credential)
    await session.flush()

    assert (await reveal(client, roster["student_id"], roster["headers"])).status_code == 409
    rows = (
        await client.get(f"/classes/{roster['class_id']}/roster", headers=roster["headers"])
    ).json()
    assert [(r["has_pin"], r["pin_viewable"]) for r in rows] == [(True, False)]

    await client.post(f"/students/{roster['student_id']}/pin", json={}, headers=roster["headers"])
    assert (await reveal(client, roster["student_id"], roster["headers"])).status_code == 200


async def test_with_no_key_pins_still_work_and_reveal_is_409(
    client, student_on_roster, test_settings: Settings, session: AsyncSession
) -> None:
    test_settings.pin_encryption_keys = ""
    roster = await student_on_roster()
    credential = await session.get(StudentCredential, roster["student_id"])
    assert credential is not None and credential.pin_ciphertext is None

    response = await reveal(client, roster["student_id"], roster["headers"])
    assert response.status_code == 409
    signed = await client.post(
        "/auth/student/session", json={"username": roster["username"], "pin": roster["pin"]}
    )
    assert signed.status_code == 200, signed.text


# --- the cipher ---------------------------------------------------------------------


def test_a_rotated_key_still_reads_the_old_copy() -> None:
    old, new = Fernet.generate_key().decode(), Fernet.generate_key().decode()
    token = encrypt_pin(Settings(pin_encryption_keys=old), "4827")
    assert decrypt_pin(Settings(pin_encryption_keys=f"{new},{old}"), token) == "4827"


def test_a_copy_under_an_unknown_key_is_none_not_a_crash() -> None:
    token = encrypt_pin(Settings(pin_encryption_keys=Fernet.generate_key().decode()), "4827")
    other = Settings(pin_encryption_keys=Fernet.generate_key().decode())
    assert decrypt_pin(other, token) is None
    assert decrypt_pin(other, "not a token") is None
    assert decrypt_pin(other, None) is None
