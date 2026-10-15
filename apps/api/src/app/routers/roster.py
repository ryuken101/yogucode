"""Roster management: students at a centre, and their enrolment in a class.

Two routers live here. `students_router` is centre-level — a student belongs to a *centre*
and is enrolled in classes term by term, so creating one is not a class operation.
`roster_router` hangs the enrolment and bulk-paste routes off `/classes/{class_id}`, which
is where a teacher actually does the work. They share every DTO and every helper below,
which is why they share a module rather than sitting in `classes.py` and a sibling.

**Nothing here deletes.** Withdrawing and archiving are state changes, and the verbs are
`POST .../withdraw` and `POST .../archive` rather than `DELETE`, so no route implies
otherwise. A student leaving mid-term must not vaporise a term of history.

Every lookup goes through `app.scoping`. A bare `select(Student)` in this module would be
the exact bug that module exists to make impossible.
"""

import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field, model_validator
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlmodel import select, update
from sqlmodel.ext.asyncio.session import AsyncSession

from app.audit import audit_entry
from app.auth.pin import (
    PIN_LENGTH,
    decrypt_pin,
    encrypt_pin,
    generate_pin,
    hash_pin,
    is_weak,
    show_pin_enabled,
)
from app.auth.principal import CurrentOwner, CurrentTeacher, Principal, SettingsDep
from app.auth.student_session import revoke_live_sessions
from app.config import Settings
from app.db import get_session
from app.erase import EraseIn, erase_student, names_match
from app.models import (
    AuditLog,
    Class,
    Enrolment,
    EnrolmentStatus,
    Student,
    StudentCredential,
    StudentStatus,
)
from app.models.base import new_uuid, utcnow
from app.roster import (
    MAX_ENTRIES,
    MAX_NAME_LENGTH,
    MAX_PASTE_CHARS,
    UNRESOLVED_ACTIONS,
    Candidate,
    PasteAction,
    PreviewEntry,
    name_key,
    normalise_name,
    parse_names,
    resolve_paste,
)
from app.scoping import (
    get_enrolment,
    get_owned_class,
    get_owned_student,
    list_class_roster,
    list_owned_students,
    list_student_enrolments,
)
from app.usernames import (
    clean_username,
    suggest_username,
    taken_usernames,
    username_taken,
)

students_router = APIRouter(prefix="/students", tags=["roster"])
roster_router = APIRouter(prefix="/classes", tags=["roster"])

SessionDep = Annotated[AsyncSession, Depends(get_session)]


# --- schemas -----------------------------------------------------------------------


class StudentIn(BaseModel):
    """A new account (Ken's decision, 11 Oct 2026): a name, a username and a PIN.

    Leave `username` out and one is suggested from the name; leave `pin` out and a random
    one is drawn. Either way the PIN comes back in the response, to print or tell; after
    that, Show PIN reveals it again (16 Oct 2026).
    """

    display_name: str = Field(min_length=1, max_length=MAX_NAME_LENGTH)
    username: str | None = Field(default=None, max_length=40)
    pin: str | None = Field(default=None, max_length=8)


class StudentPatch(BaseModel):
    """Every field optional — an absent field means "leave it alone"."""

    display_name: str | None = Field(default=None, min_length=1, max_length=MAX_NAME_LENGTH)
    username: str | None = Field(default=None, min_length=1, max_length=40)


class PinIn(BaseModel):
    """A PIN the teacher chose, or none for a random one."""

    pin: str | None = Field(default=None, max_length=8)


class UsernameSuggestionOut(BaseModel):
    username: str


class StudentOut(BaseModel):
    id: uuid.UUID
    display_name: str
    username: str
    status: StudentStatus
    created_at: datetime
    updated_at: datetime

    @classmethod
    def build(cls, record: Student) -> "StudentOut":
        return cls(
            id=record.id,
            display_name=record.display_name,
            username=record.username,
            status=record.status,
            created_at=record.created_at,
            updated_at=record.updated_at,
        )


class StudentClassOut(BaseModel):
    """One class a student has been in, from the student's side."""

    class_id: uuid.UUID
    name: str
    term_label: str | None
    status: EnrolmentStatus
    joined_at: datetime
    withdrawn_at: datetime | None

    @classmethod
    def build(cls, enrolment: Enrolment, klass: Class) -> "StudentClassOut":
        return cls(
            class_id=klass.id,
            name=klass.name,
            term_label=klass.term_label,
            status=enrolment.status,
            joined_at=enrolment.joined_at,
            withdrawn_at=enrolment.withdrawn_at,
        )


class StudentDetailOut(StudentOut):
    classes: list[StudentClassOut]

    @classmethod
    def build_detail(
        cls, record: Student, enrolments: list[tuple[Enrolment, Class]]
    ) -> "StudentDetailOut":
        return cls(
            **StudentOut.build(record).model_dump(),
            classes=[StudentClassOut.build(e, c) for e, c in enrolments],
        )


class RosterEntryOut(BaseModel):
    """A student as seen from inside a class: who they are, plus how they got there."""

    student_id: uuid.UUID
    display_name: str
    username: str
    # Whether a PIN is set, and whether Show PIN can reveal it. The PIN itself is never in
    # a roster response — only `POST /students/{id}/pin/reveal` returns it, audited.
    has_pin: bool
    pin_viewable: bool
    student_status: StudentStatus
    status: EnrolmentStatus
    joined_at: datetime
    withdrawn_at: datetime | None

    @classmethod
    def build(
        cls, enrolment: Enrolment, student: Student, pin_viewable: bool | None = None
    ) -> "RosterEntryOut":
        """`pin_viewable` is None when the child has no PIN at all."""
        return cls(
            student_id=student.id,
            display_name=student.display_name,
            username=student.username,
            has_pin=pin_viewable is not None,
            pin_viewable=bool(pin_viewable),
            student_status=student.status,
            status=enrolment.status,
            joined_at=enrolment.joined_at,
            withdrawn_at=enrolment.withdrawn_at,
        )


class EnrolmentIn(BaseModel):
    student_id: uuid.UUID


class PastedNamesIn(BaseModel):
    names: str = Field(max_length=MAX_PASTE_CHARS)


class CandidateOut(BaseModel):
    student_id: uuid.UUID
    display_name: str
    status: StudentStatus

    @classmethod
    def build(cls, candidate: Candidate) -> "CandidateOut":
        return cls(
            student_id=candidate.student_id,
            display_name=candidate.display_name,
            status=candidate.status,
        )


class PreviewEntryOut(BaseModel):
    line: int
    raw: str
    display_name: str
    action: PasteAction
    student_id: uuid.UUID | None
    student_status: StudentStatus | None
    candidates: list[CandidateOut]
    reason: str | None

    @classmethod
    def build(cls, entry: PreviewEntry) -> "PreviewEntryOut":
        return cls(
            line=entry.line,
            raw=entry.raw,
            display_name=entry.name,
            action=entry.action,
            student_id=entry.student_id,
            student_status=entry.student_status,
            candidates=[CandidateOut.build(c) for c in entry.candidates],
            reason=entry.reason,
        )


class RosterPreviewOut(BaseModel):
    entries: list[PreviewEntryOut]
    truncated: bool = Field(
        description=f"True when the paste held more than {MAX_ENTRIES} names and was cut short."
    )


class BulkEntryIn(BaseModel):
    """One name to add, either as text or as an existing student the teacher picked.

    Exactly one of the two. `student_id` is how the preview's `enrol_existing` and
    `ambiguous` verdicts get committed — it is the teacher saying "this child", which no
    amount of name matching can establish on its own.
    """

    display_name: str | None = Field(default=None, max_length=MAX_NAME_LENGTH)
    student_id: uuid.UUID | None = None

    @model_validator(mode="after")
    def exactly_one_of(self) -> "BulkEntryIn":
        if (self.display_name is None) == (self.student_id is None):
            raise ValueError("give exactly one of display_name or student_id")
        return self


class BulkEnrolIn(BaseModel):
    entries: list[BulkEntryIn] = Field(min_length=1, max_length=MAX_ENTRIES)


class IssuePinsIn(BaseModel):
    reset_existing: bool = Field(
        default=False,
        description=(
            "False issues a PIN only to students who have none. True regenerates for "
            "everyone on the roster, which is the answer to 'the slips got lost'."
        ),
    )


class PinSlipOut(BaseModel):
    """A PIN in plaintext: on setting it, to print and hand over, or from Show PIN.

    Stored as an Argon2id hash plus an encrypted copy (app/auth/pin.py). Every response
    carrying one is a POST marked no-store, so it never sits in a URL or an HTTP cache.
    """

    student_id: uuid.UUID
    display_name: str
    username: str
    pin: str


class StudentCreatedOut(StudentOut):
    """A new account, with its PIN — to print or tell the child."""

    pin: str


class SessionsRevokedOut(BaseModel):
    student_id: uuid.UUID
    revoked: int


# --- helpers -----------------------------------------------------------------------


def _audit(principal: Principal, action: str, student_id: uuid.UUID, **payload: object) -> AuditLog:
    """Roster actions are keyed to the child, not to the row — see `app.audit`."""
    return audit_entry(principal, action, "student", student_id, **payload)


def _chosen_pin(raw: str | None) -> str:
    """The teacher's PIN if they typed one (4 digits, not an obvious one), else random."""
    if raw is None or not raw.strip():
        return generate_pin()
    pin = raw.strip()
    if len(pin) != PIN_LENGTH or not pin.isdigit():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="A PIN is 4 digits",
        )
    if is_weak(pin):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="That PIN is too easy to guess — try another, or press Random",
        )
    return pin


async def _username_for(
    session: AsyncSession, display_name: str, requested: str | None, *, mine: Student | None = None
) -> str:
    """The username to use: the teacher's, checked; or one suggested from the name."""
    taken = await taken_usernames(session)
    if mine is not None:
        taken.discard(mine.username.lower())
    if requested is None or not requested.strip():
        return suggest_username(display_name, taken)
    username = clean_username(requested)
    if username in taken:
        raise username_taken(suggest_username(username, taken))
    return username


async def _pins_set(session: AsyncSession, student_ids: list[uuid.UUID]) -> dict[uuid.UUID, bool]:
    """Which of these students have a PIN, mapped to whether Show PIN can reveal it.

    Never the PIN: the roster says only that one exists."""
    if not student_ids:
        return {}
    rows = await session.exec(
        select(StudentCredential.student_id, StudentCredential.pin_ciphertext).where(
            StudentCredential.student_id.in_(student_ids)  # type: ignore[attr-defined]
        )
    )
    return {student_id: token is not None for student_id, token in rows.all()}


def _store_pin(settings: Settings, credential: StudentCredential, pin: str) -> None:
    """Write both stored forms of a PIN. Every place that sets a PIN goes through here, so
    the hash sign-in checks and the copy Show PIN reveals can never disagree."""
    credential.pin_hash = hash_pin(pin)
    credential.pin_ciphertext = encrypt_pin(settings, pin)


def _conflict(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=detail)


async def _refuse_name_clash(
    session: AsyncSession, principal: Principal, class_id: uuid.UUID, student: Student
) -> None:
    """409 if a *different* child with the same name is already active in this class.

    Two identically-named children in one class break the name picker a student signs in
    through at step 7 — they would see two identical buttons and no way to tell which is
    theirs, and picking wrong attaches their work to another child's record. The person
    who knows which Aiden is which is the teacher, at the moment they are typing, so the
    refusal belongs here and not in the join flow.

    This is checked in the application and not by a unique index on purpose: two
    genuinely distinct children called "Aiden C" at one centre, in different classes, is
    legitimate and must stay possible.
    """
    key = name_key(student.display_name)
    for _, enrolled in await list_class_roster(session, principal, class_id):
        if enrolled.id != student.id and name_key(enrolled.display_name) == key:
            raise _conflict(
                f"a student named {enrolled.display_name} is already in this class — "
                "add a last initial to tell them apart"
            )


def _activate_student(principal: Principal, session: AsyncSession, student: Student) -> None:
    """Bring an archived student back, because enrolling them says they have returned.

    `==` and not `is`: these columns are `sa_type=String`, so a loaded row carries a plain
    `str` that compares equal to the `StrEnum` member but is not the same object.
    """
    if student.status != StudentStatus.ARCHIVED:
        return
    student.status = StudentStatus.ACTIVE
    session.add(student)
    session.add(_audit(principal, "student.unarchived", student.id, reason="enrolled"))


async def _enrol(
    session: AsyncSession,
    principal: Principal,
    class_id: uuid.UUID,
    student: Student,
    **payload: object,
) -> None:
    """Enrol a student, reactivating a withdrawn enrolment rather than inserting a second.

    `uq_enrolments_class_student` ignores status, so a returning student has no second row
    available: the existing one is flipped back. `joined_at` is deliberately left at the
    original value — it records when this child first joined this class, which is what
    Phase 8 reads.

    The two paths are written differently on purpose. When the row is already loaded there
    is nothing to race against, so it is updated through the ORM — a raw `UPDATE` would
    leave the loaded object stale in the identity map, and with `expire_on_commit=False`
    that staleness survives the commit and gets served in the response. The insert path has
    no such object and does have a race (two teachers committing the same paste at once),
    so it upserts and lets `uq_enrolments_class_student` arbitrate rather than checking
    first and hoping.
    """
    existing = await get_enrolment(session, principal, class_id, student.id)
    if existing is not None:
        if existing.status == EnrolmentStatus.ACTIVE:
            return  # already there; re-submitting a preview verbatim is not an error
        existing.status = EnrolmentStatus.ACTIVE
        existing.withdrawn_at = None
        session.add(existing)
        action = "enrolment.reinstated"
    else:
        await session.exec(
            pg_insert(Enrolment)
            .values(
                id=new_uuid(),
                class_id=class_id,
                student_id=student.id,
                status=EnrolmentStatus.ACTIVE,
                joined_at=utcnow(),
                withdrawn_at=None,
            )
            .on_conflict_do_update(
                index_elements=["class_id", "student_id"],
                set_={"status": EnrolmentStatus.ACTIVE, "withdrawn_at": None},
            )
        )
        action = "enrolment.added"

    session.add(_audit(principal, action, student.id, class_id=str(class_id), **payload))


async def _roster_entry(
    session: AsyncSession, principal: Principal, class_id: uuid.UUID, student_id: uuid.UUID
) -> RosterEntryOut:
    """Re-read one roster row after a write, so the response is the committed state."""
    for enrolment, student in await list_class_roster(
        session, principal, class_id, include_withdrawn=True
    ):
        if student.id == student_id:
            pins = await _pins_set(session, [student_id])
            return RosterEntryOut.build(enrolment, student, pins.get(student_id))
    raise HTTPException(  # pragma: no cover — the caller has just written this row
        status_code=status.HTTP_404_NOT_FOUND, detail="enrolment not found"
    )


# --- students ----------------------------------------------------------------------


async def _new_account(
    session: AsyncSession, principal: Principal, settings: Settings, body: StudentIn
) -> tuple[Student, str]:
    """A child's account: name, username and PIN. Never commits."""
    name = normalise_name(body.display_name)
    pin = _chosen_pin(body.pin)
    username = await _username_for(session, name, body.username)
    record = Student(centre_id=principal.centre_id, display_name=name, username=username)
    session.add(record)
    await session.flush()
    credential = StudentCredential(
        student_id=record.id, pin_hash="", pin_set_by=principal.subject_id
    )
    _store_pin(settings, credential, pin)
    session.add(credential)
    session.add(
        _audit(principal, "student.created", record.id, display_name=name, username=username)
    )
    return record, pin


@students_router.post("", response_model=StudentCreatedOut, status_code=status.HTTP_201_CREATED)
async def create_student(
    body: StudentIn,
    principal: CurrentTeacher,
    session: SessionDep,
    settings: SettingsDep,
    response: Response,
) -> StudentCreatedOut:
    """Create a child's account at the centre, without enrolling them anywhere."""
    response.headers["Cache-Control"] = "no-store"
    record, pin = await _new_account(session, principal, settings, body)
    await session.commit()
    await session.refresh(record)
    return StudentCreatedOut(**StudentOut.build(record).model_dump(), pin=pin)


@students_router.get("/username-suggestion", response_model=UsernameSuggestionOut)
async def suggest_a_username(
    name: str, principal: CurrentTeacher, session: SessionDep
) -> UsernameSuggestionOut:
    """What the Add student form fills in as the teacher types the name."""
    return UsernameSuggestionOut(username=suggest_username(name, await taken_usernames(session)))


@students_router.get("", response_model=list[StudentOut])
async def list_students(
    principal: CurrentTeacher, session: SessionDep, include_archived: bool = False
) -> list[StudentOut]:
    records = await list_owned_students(session, principal, include_archived)
    return [StudentOut.build(record) for record in records]


@students_router.get("/{student_id}", response_model=StudentDetailOut)
async def read_student(
    student_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep
) -> StudentDetailOut:
    record = await get_owned_student(session, principal, student_id)
    enrolments = await list_student_enrolments(session, principal, student_id)
    return StudentDetailOut.build_detail(record, list(enrolments))


@students_router.patch("/{student_id}", response_model=StudentOut)
async def rename_student(
    student_id: uuid.UUID, body: StudentPatch, principal: CurrentTeacher, session: SessionDep
) -> StudentOut:
    """Rename a student — most often to add a last initial after a name clash."""
    record = await get_owned_student(session, principal, student_id)

    fields = body.model_dump(exclude_unset=True)
    if "display_name" in fields and fields["display_name"] is not None:
        renamed = normalise_name(body.display_name)  # type: ignore[arg-type]
        if renamed and renamed != record.display_name:
            record.display_name = renamed
            session.add(record)
            session.add(_audit(principal, "student.renamed", record.id, display_name=renamed))
            await session.commit()
            await session.refresh(record)
    if "username" in fields and fields["username"] is not None:
        username = await _username_for(session, record.display_name, body.username, mine=record)
        if username != record.username:
            record.username = username
            session.add(record)
            session.add(_audit(principal, "student.username_changed", record.id, username=username))
            await session.commit()
            await session.refresh(record)
    return StudentOut.build(record)


@students_router.post("/{student_id}/archive", response_model=StudentOut)
async def archive_student(
    student_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep
) -> StudentOut:
    """The child has left the academy: withdraw them from their classes and sign them out.

    This is the one place the roster diverges from `archive_class`, which deliberately
    leaves enrolments alone. The asymmetry is real rather than an oversight. Archiving a
    *class* means the term ended and nobody left, so withdrawing its enrolments would
    overwrite history to tidy a status field. Archiving a *student* means the child left,
    and withdrawal is the honest record of that — the rows keep their `joined_at`, so a
    term of history survives intact.

    Live sessions are revoked in the same breath, because an archived student must not
    still be signed in on a centre laptop.
    """
    record = await get_owned_student(session, principal, student_id)
    record.status = StudentStatus.ARCHIVED
    session.add(record)

    now = utcnow()
    open_enrolments = (
        await session.exec(
            select(Enrolment).where(
                Enrolment.student_id == record.id,
                Enrolment.status == EnrolmentStatus.ACTIVE,
            )
        )
    ).all()
    if open_enrolments:
        await session.exec(
            update(Enrolment)
            .where(
                Enrolment.student_id == record.id,  # type: ignore[arg-type]
                Enrolment.status == EnrolmentStatus.ACTIVE,  # type: ignore[arg-type]
            )
            .values(status=EnrolmentStatus.WITHDRAWN, withdrawn_at=now)
        )

    # Same operation as the teacher's kick and as signing in somewhere new, so it lives
    # in one place rather than three.
    sessions_revoked = await revoke_live_sessions(session, record.id, now)

    # The class ids go in the payload rather than into separate enrolment.withdrawn rows:
    # one row per action keeps "what happened to this child" a single ordered read, and
    # the ids are the only thing a count would have lost.
    session.add(
        _audit(
            principal,
            "student.archived",
            record.id,
            enrolments_withdrawn=[str(e.class_id) for e in open_enrolments],
            sessions_revoked=sessions_revoked,
        )
    )
    await session.commit()
    await session.refresh(record)
    return StudentOut.build(record)


@students_router.post("/{student_id}/delete", status_code=status.HTTP_204_NO_CONTENT)
async def delete_student(
    student_id: uuid.UUID, body: EraseIn, principal: CurrentOwner, session: SessionDep
) -> None:
    """Delete a child entirely: their account and all their work, everywhere (Ken's
    decision, 11 Oct 2026). Owner only, and only with the name typed out. See `app.erase`.
    """
    record = await get_owned_student(session, principal, student_id)
    if not names_match(body.confirm_name, record.display_name):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Type the student’s name exactly to confirm.",
        )
    erased = await erase_student(session, record.id)
    # Ids and counts only: the point of deleting is that the child's name goes too.
    session.add(_audit(principal, "student.deleted", student_id, rows=erased.counts))
    await session.commit()


@students_router.post("/{student_id}/unarchive", response_model=StudentOut)
async def unarchive_student(
    student_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep
) -> StudentOut:
    """Undo an archive.

    Withdrawn enrolments stay withdrawn, mirroring `unarchive_class` leaving revoked join
    codes revoked. A child coming back does not necessarily rejoin the same class, and
    silently re-enrolling them into last term's is a worse surprise than enrolling them
    explicitly.
    """
    record = await get_owned_student(session, principal, student_id)
    record.status = StudentStatus.ACTIVE
    session.add(record)
    session.add(_audit(principal, "student.unarchived", record.id))
    await session.commit()
    await session.refresh(record)
    return StudentOut.build(record)


# --- enrolment -------------------------------------------------------------------


@roster_router.get("/{class_id}/roster", response_model=list[RosterEntryOut])
async def read_roster(
    class_id: uuid.UUID,
    principal: CurrentTeacher,
    session: SessionDep,
    include_withdrawn: bool = False,
) -> list[RosterEntryOut]:
    """The class roster, alphabetically — the order it is read aloud in."""
    await get_owned_class(session, principal, class_id)
    entries = await list_class_roster(session, principal, class_id, include_withdrawn)
    pins = await _pins_set(session, [student.id for _, student in entries])
    return [
        RosterEntryOut.build(enrolment, student, pins.get(student.id))
        for enrolment, student in entries
    ]


@roster_router.post(
    "/{class_id}/students", response_model=PinSlipOut, status_code=status.HTTP_201_CREATED
)
async def add_new_student(
    class_id: uuid.UUID,
    body: StudentIn,
    principal: CurrentTeacher,
    session: SessionDep,
    settings: SettingsDep,
    response: Response,
) -> PinSlipOut:
    """Create a child's account and put them in this class — the class page's Add student.

    Returns the slip (name, username, PIN) to print; Show PIN reveals it again later.
    """
    response.headers["Cache-Control"] = "no-store"
    await get_owned_class(session, principal, class_id)
    probe = Student(
        centre_id=principal.centre_id,
        display_name=normalise_name(body.display_name),
        username="probe",
    )
    await _refuse_name_clash(session, principal, class_id, probe)
    record, pin = await _new_account(session, principal, settings, body)
    await _enrol(session, principal, class_id, record)
    await session.commit()
    return PinSlipOut(
        student_id=record.id, display_name=record.display_name, username=record.username, pin=pin
    )


@roster_router.post(
    "/{class_id}/enrolments", response_model=RosterEntryOut, status_code=status.HTTP_201_CREATED
)
async def enrol_student(
    class_id: uuid.UUID, body: EnrolmentIn, principal: CurrentTeacher, session: SessionDep
) -> RosterEntryOut:
    """Enrol an existing centre student into a class.

    Both ids are resolved through `scoping`, so a class in another centre and a student in
    another centre are each a 404 — and so is the cross pairing, which is the case worth
    having a test for.
    """
    await get_owned_class(session, principal, class_id)
    student = await get_owned_student(session, principal, body.student_id)
    await _refuse_name_clash(session, principal, class_id, student)

    _activate_student(principal, session, student)
    await _enrol(session, principal, class_id, student)
    await session.commit()
    return await _roster_entry(session, principal, class_id, student.id)


@roster_router.post("/{class_id}/enrolments/{student_id}/withdraw", response_model=RosterEntryOut)
async def withdraw_student(
    class_id: uuid.UUID, student_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep
) -> RosterEntryOut:
    """Take a student out of a class. The enrolment row stays; its status changes.

    The child is signed out too. A session belongs to the student, not to a class, so
    without this a child removed mid-lesson would carry on working in the class they were
    just taken out of until the session expired. They can sign in again only to a class
    they are still in — the join flow needs an active enrolment.
    """
    await get_owned_class(session, principal, class_id)
    student = await get_owned_student(session, principal, student_id)
    enrolment = await get_enrolment(session, principal, class_id, student.id)
    if enrolment is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="enrolment not found")

    if enrolment.status == EnrolmentStatus.ACTIVE:
        now = utcnow()
        enrolment.status = EnrolmentStatus.WITHDRAWN
        enrolment.withdrawn_at = now
        session.add(enrolment)
        sessions_revoked = await revoke_live_sessions(session, student.id, now)
        session.add(
            _audit(
                principal,
                "enrolment.withdrawn",
                student.id,
                class_id=str(class_id),
                sessions_revoked=sessions_revoked,
            )
        )
        await session.commit()
    return await _roster_entry(session, principal, class_id, student.id)


@roster_router.post("/{class_id}/enrolments/{student_id}/reinstate", response_model=RosterEntryOut)
async def reinstate_student(
    class_id: uuid.UUID, student_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep
) -> RosterEntryOut:
    """Undo a withdrawal, reusing the original enrolment row."""
    await get_owned_class(session, principal, class_id)
    student = await get_owned_student(session, principal, student_id)
    if await get_enrolment(session, principal, class_id, student.id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="enrolment not found")

    await _refuse_name_clash(session, principal, class_id, student)
    _activate_student(principal, session, student)
    await _enrol(session, principal, class_id, student)
    await session.commit()
    return await _roster_entry(session, principal, class_id, student.id)


# --- bulk paste ------------------------------------------------------------------


@roster_router.post("/{class_id}/roster/preview", response_model=RosterPreviewOut)
async def preview_roster_paste(
    class_id: uuid.UUID, body: PastedNamesIn, principal: CurrentTeacher, session: SessionDep
) -> RosterPreviewOut:
    """Read a pasted list of names and say what committing it would do.

    Writes nothing — no students, no enrolments, no audit row. A teacher reads this back
    before anything happens to a child's record, which is the point of splitting the paste
    into two requests at all.
    """
    await get_owned_class(session, principal, class_id)
    parsed = parse_names(body.names)
    students = await list_owned_students(session, principal, include_archived=True)
    enrolled = {student.id for _, student in await list_class_roster(session, principal, class_id)}
    entries = resolve_paste(parsed.entries, students, enrolled)
    return RosterPreviewOut(
        entries=[PreviewEntryOut.build(entry) for entry in entries], truncated=parsed.truncated
    )


@roster_router.post(
    "/{class_id}/roster/bulk",
    response_model=list[RosterEntryOut],
    status_code=status.HTTP_201_CREATED,
)
async def bulk_enrol(
    class_id: uuid.UUID, body: BulkEnrolIn, principal: CurrentTeacher, session: SessionDep
) -> list[RosterEntryOut]:
    """Commit a reviewed paste: create the new children, enrol all of them, in one go.

    All-or-nothing. Anything unresolved — a blank or over-long name, a name the centre has
    twice, the same name twice in one submission, a name that would collide with a
    classmate — rejects the whole request with 422 and writes nothing. A teacher fixing
    one line should not have to work out which of the other eleven already went through.

    Names are re-resolved here rather than taken on trust from the preview: a client that
    posts `{"display_name": "Bella N"}` for a Bella N the centre already knows gets her
    enrolled, not duplicated. The preview is an affordance for the teacher; this is the
    authority. An entry that names a `student_id` is the teacher having chosen a specific
    child, and skips matching entirely.

    Entries that are already enrolled are accepted and skipped, so re-submitting a paste
    verbatim is safe rather than an error.
    """
    await get_owned_class(session, principal, class_id)
    students = await list_owned_students(session, principal, include_archived=True)
    by_id = {student.id: student for student in students}
    roster = await list_class_roster(session, principal, class_id)
    enrolled_ids = {student.id for _, student in roster}
    roster_keys = {name_key(student.display_name): student for _, student in roster}

    by_key: dict[str, list[Student]] = {}
    for student in students:
        by_key.setdefault(name_key(student.display_name), []).append(student)

    problems: list[dict[str, object]] = []
    # (existing student or None, the name to create) in submission order.
    planned: list[tuple[Student | None, str]] = []
    seen_keys: set[str] = set()
    seen_ids: set[uuid.UUID] = set()

    for index, entry in enumerate(body.entries):
        target: Student | None
        if entry.student_id is not None:
            # A 404 rather than a 422: an id from another centre must not be
            # distinguishable from one that does not exist.
            target = by_id.get(entry.student_id)
            if target is None:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND, detail="student not found"
                )
            name = target.display_name
        else:
            name = normalise_name(entry.display_name or "")
            verdicts = resolve_paste(parse_names(name).entries, students, enrolled_ids)
            if not verdicts:
                problems.append({"index": index, "action": "invalid", "reason": "blank"})
                continue
            verdict = verdicts[0]
            if verdict.action in UNRESOLVED_ACTIONS:
                problems.append(
                    {
                        "index": index,
                        "action": str(verdict.action),
                        "reason": verdict.reason,
                        "candidates": [str(c.student_id) for c in verdict.candidates],
                    }
                )
                continue
            target = by_id.get(verdict.student_id) if verdict.student_id else None

        key = name_key(name)
        if key in seen_keys or (target is not None and target.id in seen_ids):
            problems.append(
                {"index": index, "action": "duplicate_in_paste", "reason": f"{name} appears twice"}
            )
            continue
        seen_keys.add(key)
        if target is not None:
            seen_ids.add(target.id)

        clash = roster_keys.get(key)
        if clash is not None and (target is None or clash.id != target.id):
            problems.append(
                {
                    "index": index,
                    "action": "name_clash",
                    "reason": (
                        f"a student named {clash.display_name} is already in this class — "
                        "add a last initial to tell them apart"
                    ),
                }
            )
            continue

        planned.append((target, name))

    if problems:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={
                "message": "nothing was added — fix these entries and submit again",
                "entries": problems,
            },
        )

    touched: list[uuid.UUID] = []
    taken = await taken_usernames(session)
    for target, name in planned:
        if target is None:
            # A suggested username; the teacher can edit it, and sets PINs next
            # ("Issue missing PINs").
            username = suggest_username(name, taken)
            taken.add(username)
            student = Student(centre_id=principal.centre_id, display_name=name, username=username)
            session.add(student)
            await session.flush()
            session.add(
                _audit(principal, "student.created", student.id, display_name=name, via="bulk")
            )
        else:
            student = target
            _activate_student(principal, session, student)
        await _enrol(session, principal, class_id, student, via="bulk")
        touched.append(student.id)

    await session.commit()

    wanted = set(touched)
    pins = await _pins_set(session, touched)
    return [
        RosterEntryOut.build(enrolment, student, pins.get(student.id))
        for enrolment, student in await list_class_roster(session, principal, class_id)
        if student.id in wanted
    ]


# --- PINs and sessions -------------------------------------------------------------


def _set_pin(
    session: AsyncSession,
    principal: Principal,
    settings: Settings,
    student: Student,
    credential: StudentCredential | None,
    action: str,
    pin: str | None = None,
) -> PinSlipOut:
    """Set a PIN for one student — the teacher's or a random one — and return the slip.
    Never commits."""
    pin = pin or generate_pin()
    if credential is None:
        credential = StudentCredential(student_id=student.id, pin_hash="")
    else:
        credential.pin_set_at = utcnow()
    _store_pin(settings, credential, pin)
    credential.pin_set_by = principal.subject_id
    # `must_change_pin` is deliberately never set. Forcing a child to choose a new PIN
    # after a reset protects a secret from an admin who should not know it — but here the
    # teacher is meant to know it, since they generate it and hand out the slip. It would
    # add a step for a nine-year-old at the moment they are already stuck, and leave the
    # teacher unable to tell them their PIN next time — which Show PIN now exists to do.
    credential.must_change_pin = False
    credential.failed_attempts = 0
    credential.locked_until = None
    session.add(credential)
    # The PIN itself never reaches the audit row, a log, or an error message.
    session.add(_audit(principal, action, student.id))
    return PinSlipOut(
        student_id=student.id, display_name=student.display_name, username=student.username, pin=pin
    )


@roster_router.post(
    "/{class_id}/pins", response_model=list[PinSlipOut], status_code=status.HTTP_201_CREATED
)
async def issue_class_pins(
    class_id: uuid.UUID,
    body: IssuePinsIn,
    principal: CurrentTeacher,
    session: SessionDep,
    settings: SettingsDep,
    response: Response,
) -> list[PinSlipOut]:
    """Issue PINs across a class and return the slips.

    The bulk counterpart to bulk roster entry: having pasted twelve names, a teacher is
    not going to set twelve PINs one form at a time. By default this only touches
    children who have no PIN yet, so it is safe to run again after adding one student.
    """
    response.headers["Cache-Control"] = "no-store"
    await get_owned_class(session, principal, class_id)
    roster = await list_class_roster(session, principal, class_id)

    slips: list[PinSlipOut] = []
    for _enrolment, student in roster:
        credential = await session.get(StudentCredential, student.id)
        if credential is not None and not body.reset_existing:
            continue
        action = "pin.reset" if credential is not None else "pin.issued"
        slips.append(_set_pin(session, principal, settings, student, credential, action))

    if slips:
        await session.commit()
    return slips


@students_router.post(
    "/{student_id}/pin", response_model=PinSlipOut, status_code=status.HTTP_201_CREATED
)
async def set_student_pin(
    student_id: uuid.UUID,
    body: PinIn,
    principal: CurrentTeacher,
    session: SessionDep,
    settings: SettingsDep,
    response: Response,
) -> PinSlipOut:
    """Change a child's PIN — to one the teacher chose, or a random one.

    The remedy for a PIN that was set before Show PIN existed, or that a classmate has
    seen. The slip comes back to print.
    """
    response.headers["Cache-Control"] = "no-store"
    student = await get_owned_student(session, principal, student_id)
    pin = _chosen_pin(body.pin)
    credential = await session.get(StudentCredential, student.id)
    action = "pin.reset" if credential is not None else "pin.issued"
    slip = _set_pin(session, principal, settings, student, credential, action, pin)
    await session.commit()
    return slip


@students_router.post("/{student_id}/pin/reveal", response_model=PinSlipOut)
async def reveal_student_pin(
    student_id: uuid.UUID,
    principal: CurrentTeacher,
    session: SessionDep,
    settings: SettingsDep,
    response: Response,
) -> PinSlipOut:
    """Show PIN: a child's current PIN, for a teacher without the slip (16 Oct 2026).

    Any teacher at the centre may look — every teacher can open every class — and each look
    is a `pin.viewed` row, so "who has seen this child's PIN" is answerable. A POST, not a
    GET, so the PIN never lands in a URL, browser history or an HTTP cache.
    """
    response.headers["Cache-Control"] = "no-store"
    student = await get_owned_student(session, principal, student_id)
    if not show_pin_enabled(settings):
        raise _conflict("PIN viewing isn't set up")
    credential = await session.get(StudentCredential, student.id)
    pin = decrypt_pin(settings, credential.pin_ciphertext if credential else None)
    if pin is None:
        raise _conflict("This PIN can't be shown — change it to make it viewable")
    session.add(_audit(principal, "pin.viewed", student.id))
    await session.commit()
    return PinSlipOut(
        student_id=student.id, display_name=student.display_name, username=student.username, pin=pin
    )


@students_router.post("/{student_id}/sessions/revoke", response_model=SessionsRevokedOut)
async def revoke_student_sessions(
    student_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep
) -> SessionsRevokedOut:
    """Kick a student's session — wrong child signed in, or a laptop left open.

    Takes effect on the next request rather than at expiry, which is the whole reason the
    session token is opaque and revocable rather than a JWT.
    """
    student = await get_owned_student(session, principal, student_id)
    revoked = await revoke_live_sessions(session, student.id)
    if revoked:
        session.add(_audit(principal, "student.sessions_revoked", student.id, count=revoked))
        await session.commit()
    return SessionsRevokedOut(student_id=student.id, revoked=revoked)
