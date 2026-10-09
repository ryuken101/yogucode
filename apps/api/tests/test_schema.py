"""Schema-level tests.

There are no routes yet, so these check the guarantees the migration is supposed to
give: that the shape round-trips, that the constraints protecting roster integrity
actually fire, and that ids carry creation order (which Phase 6's event stream depends
on).
"""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.models import (
    Centre,
    Class,
    ClassJoinCode,
    Concept,
    Enrolment,
    Student,
    StudentCredential,
    StudentSession,
    StudentStatus,
    User,
    UserRole,
    new_uuid,
)


async def _centre(session: AsyncSession, slug: str = "castle-hill") -> Centre:
    centre = Centre(name="Magikid Castle Hill", slug=slug)
    session.add(centre)
    await session.flush()
    return centre


async def _teacher(session: AsyncSession, centre: Centre) -> User:
    user = User(
        supabase_user_id=new_uuid(),
        centre_id=centre.id,
        email="teacher@example.com",
        display_name="Ken",
        role=UserRole.OWNER,
    )
    session.add(user)
    await session.flush()
    return user


async def test_roster_round_trip(session: AsyncSession) -> None:
    """A centre, a teacher, a class, a student with a PIN, and an enrolment."""
    centre = await _centre(session)
    teacher = await _teacher(session, centre)

    klass = Class(centre_id=centre.id, name="Year 4-6 Python", term_label="2026 T4")
    student = Student(centre_id=centre.id, display_name="Aria K")
    session.add_all([klass, student])
    await session.flush()

    session.add_all(
        [
            Enrolment(class_id=klass.id, student_id=student.id),
            # The teacher sets the PIN when building the roster, so a credential row
            # exists before the student has ever signed in.
            StudentCredential(
                student_id=student.id, pin_hash="argon2-placeholder", pin_set_by=teacher.id
            ),
            ClassJoinCode(class_id=klass.id, code="HMTKQR", created_by=teacher.id),
        ]
    )
    await session.flush()

    enrolment = (
        await session.exec(select(Enrolment).where(Enrolment.student_id == student.id))
    ).one()
    assert enrolment.class_id == klass.id
    assert enrolment.status == "active"

    credential = await session.get(StudentCredential, student.id)
    assert credential is not None
    assert credential.must_change_pin is False
    assert credential.failed_attempts == 0
    assert credential.locked_until is None


async def test_uuid_primary_keys_are_uuid7_and_sort_by_creation(session: AsyncSession) -> None:
    """UUIDv7: version 7, and lexically ordered by creation time.

    Phase 6's offline event buffer needs client-minted ids that still sort correctly.
    """
    centre = await _centre(session)
    assert centre.id.version == 7

    students = [Student(centre_id=centre.id, display_name=f"Student {i}") for i in range(5)]
    for student in students:
        session.add(student)
        await session.flush()

    ids = [s.id for s in students]
    assert ids == sorted(ids, key=lambda value: value.bytes)


async def test_duplicate_enrolment_is_rejected(session: AsyncSession) -> None:
    centre = await _centre(session)
    klass = Class(centre_id=centre.id, name="Year 4-6 Python")
    student = Student(centre_id=centre.id, display_name="Aria K")
    session.add_all([klass, student])
    await session.flush()

    session.add(Enrolment(class_id=klass.id, student_id=student.id))
    await session.flush()

    session.add(Enrolment(class_id=klass.id, student_id=student.id))
    with pytest.raises(IntegrityError):
        await session.flush()


@pytest.mark.parametrize(
    ("factory", "field"),
    [
        (lambda centre_id: Centre(name="Duplicate", slug="castle-hill"), "slug"),
        (
            lambda centre_id: User(
                supabase_user_id=uuid.UUID(int=1),
                centre_id=centre_id,
                email="other@example.com",
                display_name="Other",
            ),
            "supabase_user_id",
        ),
    ],
)
async def test_unique_columns_are_enforced(session: AsyncSession, factory, field: str) -> None:
    centre = await _centre(session)
    if field == "supabase_user_id":
        session.add(
            User(
                supabase_user_id=uuid.UUID(int=1),
                centre_id=centre.id,
                email="first@example.com",
                display_name="First",
            )
        )
        await session.flush()

    session.add(factory(centre.id))
    with pytest.raises(IntegrityError):
        await session.flush()


async def test_join_code_is_unique(session: AsyncSession) -> None:
    centre = await _centre(session)
    teacher = await _teacher(session, centre)
    klass = Class(centre_id=centre.id, name="Year 4-6 Python")
    session.add(klass)
    await session.flush()

    session.add(ClassJoinCode(class_id=klass.id, code="HMTKQR", created_by=teacher.id))
    await session.flush()
    session.add(ClassJoinCode(class_id=klass.id, code="HMTKQR", created_by=teacher.id))
    with pytest.raises(IntegrityError):
        await session.flush()


async def test_global_concept_keys_are_unique(session: AsyncSession) -> None:
    """Postgres treats NULLs as distinct, so global concepts need a partial index."""
    session.add(Concept(key="for_loops", label="For loops"))
    await session.flush()
    session.add(Concept(key="for_loops", label="For loops again"))
    with pytest.raises(IntegrityError):
        await session.flush()


async def test_a_centre_may_override_a_global_concept_key(session: AsyncSession) -> None:
    centre = await _centre(session)
    session.add(Concept(key="for_loops", label="For loops"))
    await session.flush()
    session.add(Concept(centre_id=centre.id, key="for_loops", label="For loops, Castle Hill"))
    await session.flush()  # must not raise


async def test_check_constraint_rejects_an_invalid_status(session: AsyncSession) -> None:
    centre = await _centre(session)
    student = Student(centre_id=centre.id, display_name="Aria K")
    student.status = "expelled"  # type: ignore[assignment]
    session.add(student)
    with pytest.raises((IntegrityError, DBAPIError)):
        await session.flush()


async def test_updated_at_moves_and_created_at_does_not(session: AsyncSession) -> None:
    centre = await _centre(session)
    created_at, updated_at = centre.created_at, centre.updated_at

    centre.name = "Magikid Castle Hill (renamed)"
    session.add(centre)
    await session.flush()
    await session.refresh(centre)

    assert centre.created_at == created_at
    assert centre.updated_at > updated_at


async def test_archiving_a_student_preserves_their_enrolment(session: AsyncSession) -> None:
    """Archive, never delete — a student leaving mid-term keeps a term of history."""
    centre = await _centre(session)
    klass = Class(centre_id=centre.id, name="Year 4-6 Python")
    student = Student(centre_id=centre.id, display_name="Aria K")
    session.add_all([klass, student])
    await session.flush()
    session.add(Enrolment(class_id=klass.id, student_id=student.id))
    await session.flush()

    student.status = StudentStatus.ARCHIVED
    session.add(student)
    await session.flush()

    enrolments = (
        await session.exec(select(Enrolment).where(Enrolment.student_id == student.id))
    ).all()
    assert len(enrolments) == 1


async def test_student_session_carries_both_expiry_clocks(session: AsyncSession) -> None:
    """Absolute expiry (12h) and idle expiry (90min from last_seen_at)."""
    centre = await _centre(session)
    student = Student(centre_id=centre.id, display_name="Aria K")
    session.add(student)
    await session.flush()

    issued = datetime.now(UTC)
    session.add(
        StudentSession(
            student_id=student.id,
            token_hash="sha256-placeholder",
            issued_at=issued,
            expires_at=issued + timedelta(hours=12),
            last_seen_at=issued,
        )
    )
    await session.flush()

    stored = (
        await session.exec(select(StudentSession).where(StudentSession.student_id == student.id))
    ).one()
    assert stored.expires_at - stored.issued_at == timedelta(hours=12)
    assert stored.revoked_at is None


def test_models_match_the_migrations(run_alembic) -> None:
    """Catches a model changed without a matching migration.

    The migrated_database fixture has already brought the test database to head, so a
    diff here means the models moved and nobody generated a revision.
    """
    result = run_alembic("check")
    assert result.returncode == 0, result.stdout + result.stderr


async def test_every_table_has_row_level_security(session: AsyncSession) -> None:
    """Supabase publishes the public schema to its `anon` role through PostgREST. RLS with
    no policies means that role reads nothing, whatever the dashboard's Data API switch
    says. A new table without it would be readable with the key that ships in the website —
    so add `ALTER TABLE … ENABLE ROW LEVEL SECURITY` to its migration."""
    rows = (
        await session.execute(
            text(
                "SELECT tablename FROM pg_tables WHERE schemaname = 'public' "
                "AND tablename <> 'alembic_version' AND NOT rowsecurity"
            )
        )
    ).all()
    assert rows == [], f"tables without row-level security: {[r[0] for r in rows]}"
