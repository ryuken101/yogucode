"""The dev-data seeder.

Two of these tests exist because of mistakes made earlier in this project rather than
because of anything the feature needs: the owner-slot guard and the localhost guard. A
throwaway version of this script took the owner slot and left a phantom row that had to be
deleted by hand, and a seeder that prints credentials to stdout must not be pointable at
staging.
"""

import uuid

import pytest
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.auth.pin import is_weak, verify_pin
from app.models import (
    Centre,
    Class,
    ClassJoinCode,
    Enrolment,
    Student,
    StudentCredential,
    User,
    UserRole,
)
from app.seed.demo import (
    DEMO_JOIN_CODE,
    DEMO_STUDENTS,
    UnsafeTarget,
    assert_local,
    seed_demo,
)

# --- the localhost guard ------------------------------------------------------------


@pytest.mark.parametrize(
    "url",
    [
        "postgresql+asyncpg://localhost/coding_tool_dev",
        "postgresql+asyncpg://127.0.0.1:5432/coding_tool_dev",
        "postgresql+asyncpg://postgres:postgres@localhost:5432/coding_tool_test",
        "postgresql+asyncpg:///coding_tool_dev",
    ],
)
def test_local_databases_are_allowed(url: str) -> None:
    assert_local(url)  # must not raise


@pytest.mark.parametrize(
    "url",
    [
        "postgresql+asyncpg://db.abcdefghijklmnopqrst.supabase.co/postgres",
        "postgresql+asyncpg://postgres.abc:secret@aws-0-ap-southeast-2.pooler.supabase.com:6543/postgres",
        "postgresql+asyncpg://10.0.0.5/prod",
    ],
)
def test_remote_databases_are_refused(url: str) -> None:
    """This command prints PINs to stdout. It must never reach a real centre's data."""
    with pytest.raises(UnsafeTarget):
        assert_local(url)


# --- what it builds -----------------------------------------------------------------


async def test_it_builds_a_joinable_class(session: AsyncSession) -> None:
    result = await seed_demo(session)

    assert result.join_code == DEMO_JOIN_CODE
    code = (await session.exec(select(ClassJoinCode))).one()
    assert code.code == DEMO_JOIN_CODE
    assert code.revoked_at is None

    klass = (await session.exec(select(Class))).one()
    assert code.class_id == klass.id


async def test_it_enrols_every_student_with_a_usable_pin(session: AsyncSession) -> None:
    result = await seed_demo(session)

    assert [name for name, _ in result.created] == list(DEMO_STUDENTS)
    assert len((await session.exec(select(Enrolment))).all()) == len(DEMO_STUDENTS)

    # The printed PINs must actually work, or the whole point of the command is lost.
    for name, pin in result.created:
        student = (await session.exec(select(Student).where(Student.display_name == name))).one()
        credential = await session.get(StudentCredential, student.id)
        assert credential is not None
        assert verify_pin(credential.pin_hash, pin)
        assert not is_weak(pin)


async def test_the_pin_is_stored_hashed_not_in_the_clear(session: AsyncSession) -> None:
    result = await seed_demo(session)
    pins = {pin for _, pin in result.created}

    for credential in (await session.exec(select(StudentCredential))).all():
        assert credential.pin_hash not in pins
        assert credential.pin_hash.startswith("$argon2")


# --- the owner-slot guard -----------------------------------------------------------


async def test_it_never_creates_an_owner(session: AsyncSession) -> None:
    """The mistake this guard exists for: a seeded teacher taking the owner slot leaves
    the first real sign-in as a plain teacher, and the phantom has to be deleted by hand."""
    await seed_demo(session)

    teacher = (await session.exec(select(User))).one()
    assert teacher.role == UserRole.TEACHER
    assert "invalid" in teacher.email, "a demo teacher should be obviously not a person"


async def test_it_reuses_a_real_teacher_rather_than_adding_one(
    session: AsyncSession,
) -> None:
    centre = Centre(name="Magikid Castle Hill", slug="castle-hill")
    session.add(centre)
    await session.flush()
    real = User(
        supabase_user_id=uuid.uuid4(),
        centre_id=centre.id,
        email="ken@example.com",
        display_name="Ken",
        role=UserRole.OWNER,
    )
    session.add(real)
    await session.flush()

    await seed_demo(session)

    users = (await session.exec(select(User))).all()
    assert len(users) == 1, "the seeder must not add a second teacher"
    assert users[0].role == UserRole.OWNER, "and must not demote the real one"


# --- idempotency --------------------------------------------------------------------


async def test_running_it_twice_adds_nothing(session: AsyncSession) -> None:
    await seed_demo(session)
    again = await seed_demo(session)

    assert again.created == []
    assert again.existing == list(DEMO_STUDENTS)

    assert len((await session.exec(select(Centre))).all()) == 1
    assert len((await session.exec(select(Class))).all()) == 1
    assert len((await session.exec(select(ClassJoinCode))).all()) == 1
    assert len((await session.exec(select(Student))).all()) == len(DEMO_STUDENTS)
    assert len((await session.exec(select(Enrolment))).all()) == len(DEMO_STUDENTS)


async def test_a_second_run_does_not_reissue_pins(session: AsyncSession) -> None:
    """Argon2id is one-way, so a PIN cannot be reprinted — and silently replacing a working
    PIN because someone re-ran a seeder would invalidate a slip already handed out."""
    first = await seed_demo(session)
    hashes = {
        credential.student_id: credential.pin_hash
        for credential in (await session.exec(select(StudentCredential))).all()
    }

    await seed_demo(session)

    after = {
        credential.student_id: credential.pin_hash
        for credential in (await session.exec(select(StudentCredential))).all()
    }
    assert after == hashes
    # The first run's PINs are still the live ones.
    for name, pin in first.created:
        student = (await session.exec(select(Student).where(Student.display_name == name))).one()
        assert verify_pin(after[student.id], pin)
