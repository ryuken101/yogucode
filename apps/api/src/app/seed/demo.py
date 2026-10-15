"""Rebuild a working dev world in one command.

Everything from step 7 onwards needs a *signed-in student* to exercise, and reaching that
state through the UI costs four screens and one of the two magic-link emails the Supabase
free tier allows per hour. So this builds it directly: a centre, a class with a fixed join
code, three enrolled students, and their PINs printed to the terminal.

    uv run seed-demo

Idempotent, like the concept seed — run it as often as you like. It prints PINs only for
credentials it creates, because the stored form is an Argon2id hash and an existing PIN
cannot be read back.

**Two guards, both from mistakes made while building Phase 1.**

*It never takes the owner slot.* An earlier throwaway version of this script created a
`users` row with a random `supabase_user_id`, which made the real teacher the *second*
person at the centre — and `provision_teacher` only grants `owner` to the first. The
resulting phantom owner had to be deleted by hand. So this reuses whatever teacher already
exists and, when there is none, marks the one it creates `DEMO_EMAIL` so it is obviously
not a person.

*It refuses to run against anything but localhost.* A seeder that can be pointed at
staging is a seeder that eventually will be, and this one writes children's-record-shaped
rows and prints credentials to stdout.
"""

import asyncio
import sys
import uuid
from dataclasses import dataclass, field

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.auth.pin import encrypt_pin, generate_pin, hash_pin
from app.config import get_settings
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
from app.usernames import suggest_username, taken_usernames

DEMO_CLASS_NAME = "Demo Year 4-6 Python"
DEMO_TERM = "2026 T4"
DEMO_JOIN_CODE = "DEMOXY"
DEMO_EMAIL = "demo-teacher@example.invalid"
DEMO_STUDENTS = ("Aria K", "Bella N", "Chen W")


class UnsafeTarget(Exception):
    """The database URL is not local, so this refuses to write anything."""


@dataclass(slots=True)
class DemoResult:
    join_code: str = DEMO_JOIN_CODE
    created: list[tuple[str, str]] = field(default_factory=list)
    """(display_name, pin) for students whose PIN this run issued."""
    existing: list[str] = field(default_factory=list)
    """Students who already had a PIN, which cannot be read back to print."""
    usernames: dict[str, str] = field(default_factory=dict)
    """display_name → username, for printing the logins."""


def assert_local(database_url: str) -> None:
    """Refuse anything that is not obviously a local database."""
    host = database_url.partition("://")[2].partition("/")[0]
    # Strip credentials if present, keep the host[:port].
    host = host.rpartition("@")[2]
    if host.partition(":")[0] not in {"", "localhost", "127.0.0.1", "::1"}:
        raise UnsafeTarget(
            f"refusing to seed demo data into {host!r} — this command is for local "
            "development only, and it prints PINs to stdout"
        )


async def seed_demo(session: AsyncSession) -> DemoResult:
    """Create the demo class and its students, or leave them as they are.

    Takes a session rather than making one, so the tests can run it inside the fixture's
    rolled-back transaction instead of leaving rows behind.
    """
    settings = get_settings()
    result = DemoResult()

    centre = (
        await session.exec(select(Centre).where(Centre.slug == settings.centre_slug))
    ).one_or_none()
    if centre is None:
        centre = Centre(name=settings.centre_name, slug=settings.centre_slug)
        session.add(centre)
        await session.flush()

    # Reuse a real teacher if one has signed in. Creating one here would consume the owner
    # slot and leave the actual owner as a plain teacher — see the module docstring.
    teacher = (await session.exec(select(User).where(User.centre_id == centre.id))).first()
    if teacher is None:
        teacher = User(
            supabase_user_id=uuid.uuid4(),
            centre_id=centre.id,
            email=DEMO_EMAIL,
            display_name="Demo teacher",
            # Explicitly a teacher, never an owner: the first *real* sign-in should still
            # become the owner of this centre.
            role=UserRole.TEACHER,
        )
        session.add(teacher)
        await session.flush()

    klass = (
        await session.exec(
            select(Class).where(Class.centre_id == centre.id, Class.name == DEMO_CLASS_NAME)
        )
    ).one_or_none()
    if klass is None:
        klass = Class(centre_id=centre.id, name=DEMO_CLASS_NAME, term_label=DEMO_TERM)
        session.add(klass)
        await session.flush()

    code = (
        await session.exec(select(ClassJoinCode).where(ClassJoinCode.code == DEMO_JOIN_CODE))
    ).one_or_none()
    if code is None:
        session.add(ClassJoinCode(class_id=klass.id, code=DEMO_JOIN_CODE, created_by=teacher.id))

    for name in DEMO_STUDENTS:
        student = (
            await session.exec(
                select(Student).where(Student.centre_id == centre.id, Student.display_name == name)
            )
        ).one_or_none()
        if student is None:
            username = suggest_username(name, await taken_usernames(session))
            student = Student(centre_id=centre.id, display_name=name, username=username)
            session.add(student)
            await session.flush()

        result.usernames[name] = student.username
        enrolment = (
            await session.exec(
                select(Enrolment).where(
                    Enrolment.class_id == klass.id, Enrolment.student_id == student.id
                )
            )
        ).one_or_none()
        if enrolment is None:
            session.add(Enrolment(class_id=klass.id, student_id=student.id))

        credential = await session.get(StudentCredential, student.id)
        if credential is None:
            pin = generate_pin()
            session.add(
                StudentCredential(
                    student_id=student.id,
                    pin_hash=hash_pin(pin),
                    pin_ciphertext=encrypt_pin(settings, pin),
                    pin_set_by=teacher.id,
                )
            )
            result.created.append((name, pin))
        else:
            # An existing PIN is not reprinted here; Show PIN in the teacher UI reveals it
            # if it was set with a key configured, and Change PIN replaces it otherwise.
            result.existing.append(name)

    await session.flush()
    return result


async def _run() -> DemoResult:
    from app.db import async_session_factory

    settings = get_settings()
    assert_local(settings.database_url)
    async with async_session_factory() as session:
        result = await seed_demo(session)
        await session.commit()
    return result


def main() -> None:
    try:
        result = asyncio.run(_run())
    except UnsafeTarget as exc:
        print(f"seed-demo: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc

    print(f"class    {DEMO_CLASS_NAME}")
    print(f"code     {result.join_code}")
    for name, pin in result.created:
        print(f"  {name:<10} {result.usernames.get(name, ''):<12} {pin}")
    for name in result.existing:
        print(
            f"  {name:<10} {result.usernames.get(name, ''):<12} "
            "(PIN already set — change it in the app to see one)"
        )
    if not result.created and not result.existing:  # pragma: no cover — always populated
        print("  no students")
