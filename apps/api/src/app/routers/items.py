"""The problem bank — teacher-only, centre-scoped.

A problem is read and written as one document (`app.problem_bank`). The lifecycle is:

    draft ──publish──▶ published ──new-version──▶ (a new draft, superseding it)
      │                    │
      └──archive──▶ archived ◀──archive──┘          unarchive ▶ draft

Only drafts are editable. A published problem changes by new version, so attempts and
marks always point at the problem a child actually saw (see `models/problems.py`).

Every teacher at a centre shares the bank, as they share classes: problems are the thing
spec §7 says every teacher should contribute to rather than one person writing alone.
"""

import uuid
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.audit import audit_entry
from app.auth.principal import CurrentTeacher, Principal
from app.db import get_session
from app.models import Item, ItemConcept, ItemKind, ItemStatus, TestCase
from app.problem_bank import (
    ProblemDoc,
    UnavailableConcept,
    check_concepts,
    publish_problems,
    publish_warnings,
    read_document,
    set_status,
    write_document,
)
from app.problem_import import ProblemFileError, apply_import, plan_import
from app.scoping import get_owned_item, list_owned_items

router = APIRouter(prefix="/items", tags=["items"])

SessionDep = Annotated[AsyncSession, Depends(get_session)]


# --- shapes -------------------------------------------------------------------------


class PartRef(BaseModel):
    id: uuid.UUID
    label: str


class ProblemOut(BaseModel):
    id: uuid.UUID
    status: ItemStatus
    version: int
    supersedes_id: uuid.UUID | None
    source_key: str | None
    updated_at: datetime
    document: ProblemDoc
    parts: list[PartRef]
    # Why it cannot be published yet; empty when it can. Sent on every read so the editor
    # can show the gaps without a failed publish to discover them.
    publish_problems: list[str]
    # Worth fixing, but not blocking — a wrong option with no misconception named.
    publish_warnings: list[str]


class ProblemSummaryOut(BaseModel):
    """A row in the bank list — no code, no tests, no hints."""

    id: uuid.UUID
    kind: ItemKind
    title: str
    difficulty: int
    status: ItemStatus
    version: int
    concept_ids: list[uuid.UUID]
    primary_concept_id: uuid.UUID | None
    part_labels: list[str]
    test_count: int
    updated_at: datetime


class PublishIn(BaseModel):
    """Proof the teacher's browser ran the solution against the tests of *this* version.

    `verified_updated_at` is the `updated_at` the editor had when its run passed. A save
    in another tab since then moves `updated_at`, and the publish is refused — the run
    proved something about a version that no longer exists.
    """

    verified_updated_at: datetime


class ImportIn(BaseModel):
    yaml: str = Field(max_length=1_000_000)
    # False: report what would happen. True: do it, unless any entry has an error.
    apply: bool = False


class ImportEntryOut(BaseModel):
    key: str
    title: str
    action: Literal["create", "update_draft", "new_version", "unchanged", "error"]
    item_id: uuid.UUID | None
    error: str | None
    publish_problems: list[str]


class ImportReportOut(BaseModel):
    applied: bool
    # Set when the file as a whole could not be read; `entries` is then empty.
    error: str | None
    entries: list[ImportEntryOut]


# --- helpers ------------------------------------------------------------------------


def _conflict(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=detail)


def _unavailable_concept() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
        detail="One or more concepts are not available",
    )


async def _out(session: AsyncSession, principal: Principal, item: Item) -> ProblemOut:
    doc, parts = await read_document(session, principal, item)
    return ProblemOut(
        id=item.id,
        status=item.status,
        version=item.version,
        supersedes_id=item.supersedes_id,
        source_key=item.source_key,
        updated_at=item.updated_at,
        document=doc,
        parts=[PartRef(id=p.id, label=p.part_label or "") for p in parts],
        publish_problems=publish_problems(doc),
        publish_warnings=publish_warnings(doc),
    )


def _audit(principal: Principal, action: str, item: Item, **payload: object):
    return audit_entry(principal, action, "item", item.id, title=item.title, **payload)


# --- routes -------------------------------------------------------------------------


@router.post("", response_model=ProblemOut, status_code=status.HTTP_201_CREATED)
async def create_problem(
    body: ProblemDoc, principal: CurrentTeacher, session: SessionDep
) -> ProblemOut:
    """Start a problem as a draft. Any amount of it can be missing."""
    try:
        await check_concepts(session, principal, body)
    except UnavailableConcept as exc:
        raise _unavailable_concept() from exc
    item = Item(
        centre_id=principal.centre_id,
        title=body.title,
        kind=body.kind,
        created_by=principal.subject_id,
    )
    session.add(item)
    await session.flush()
    await write_document(session, principal, item, body)
    session.add(_audit(principal, "item.created", item))
    await session.commit()
    await session.refresh(item)
    return await _out(session, principal, item)


@router.post("/import", response_model=ImportReportOut)
async def import_problems(
    body: ImportIn, principal: CurrentTeacher, session: SessionDep
) -> ImportReportOut:
    """Plan, and optionally apply, a YAML file of problems (see `app/problem_import.py`).

    A file with any bad entry applies nothing, and says which entries to fix. Always a 200:
    a file with mistakes in it is the normal first draft of a file, not a failed request.
    """
    try:
        planned = await plan_import(session, principal, body.yaml)
    except ProblemFileError as exc:
        return ImportReportOut(applied=False, error=str(exc), entries=[])

    applied = False
    if body.apply and not any(entry.action == "error" for entry in planned):
        await apply_import(session, principal, planned)
        await session.commit()
        applied = True
    return ImportReportOut(
        applied=applied,
        error=None,
        entries=[
            ImportEntryOut(
                key=entry.key,
                title=entry.title,
                action=entry.action,
                item_id=entry.item_id,
                error=entry.error,
                publish_problems=entry.publish_problems,
            )
            for entry in planned
        ],
    )


@router.get("", response_model=list[ProblemSummaryOut])
async def list_problems(
    principal: CurrentTeacher,
    session: SessionDep,
    item_status: Annotated[list[ItemStatus] | None, Query(alias="status")] = None,
    concept_id: uuid.UUID | None = None,
    difficulty: Annotated[int | None, Query(ge=1, le=3)] = None,
    q: Annotated[str | None, Query(max_length=120)] = None,
) -> list[ProblemSummaryOut]:
    """The bank, newest edit first. Drafts and published by default."""
    items = await list_owned_items(
        session,
        principal,
        statuses=item_status or [ItemStatus.DRAFT, ItemStatus.PUBLISHED],
        concept_id=concept_id,
        difficulty=difficulty,
        search=q.strip() if q else None,
    )
    if not items:
        return []

    # Two queries for the whole page rather than a read_document per row: the list shows
    # tags and counts, never content.
    item_ids = [i.id for i in items]
    parts = (
        await session.exec(
            select(Item.id, Item.parent_id, Item.part_label)
            .where(col(Item.parent_id).in_(item_ids), Item.centre_id == principal.centre_id)
            .order_by(col(Item.sort_order))
        )
    ).all()
    owner = {i: i for i in item_ids} | {part_id: parent for part_id, parent, _ in parts}
    labels: dict[uuid.UUID, list[str]] = {i: [] for i in item_ids}
    for _, parent, label in parts:
        labels[parent].append(label)  # type: ignore[index]

    concepts: dict[uuid.UUID, set[uuid.UUID]] = {i: set() for i in item_ids}
    primary: dict[uuid.UUID, uuid.UUID] = {}
    for tag in (
        await session.exec(select(ItemConcept).where(col(ItemConcept.item_id).in_(list(owner))))
    ).all():
        concepts[owner[tag.item_id]].add(tag.concept_id)
        if tag.is_primary and tag.item_id in labels:
            primary[tag.item_id] = tag.concept_id
    test_counts: dict[uuid.UUID, int] = {i: 0 for i in item_ids}
    for item_id in (
        await session.exec(select(TestCase.item_id).where(col(TestCase.item_id).in_(list(owner))))
    ).all():
        test_counts[owner[item_id]] += 1

    return [
        ProblemSummaryOut(
            id=item.id,
            kind=item.kind,
            title=item.title,
            difficulty=item.difficulty,
            status=item.status,
            version=item.version,
            concept_ids=sorted(concepts[item.id]),
            primary_concept_id=primary.get(item.id),
            part_labels=labels[item.id],
            test_count=test_counts[item.id],
            updated_at=item.updated_at,
        )
        for item in items
    ]


@router.get("/{item_id}", response_model=ProblemOut)
async def read_problem(
    item_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep
) -> ProblemOut:
    return await _out(session, principal, await get_owned_item(session, principal, item_id))


@router.put("/{item_id}", response_model=ProblemOut)
async def save_problem(
    item_id: uuid.UUID, body: ProblemDoc, principal: CurrentTeacher, session: SessionDep
) -> ProblemOut:
    """Replace a draft with the document sent. Anything else is a 409."""
    item = await get_owned_item(session, principal, item_id)
    if item.status != ItemStatus.DRAFT:
        raise _conflict("Only a draft can be edited. Make a new version to change this problem.")
    try:
        await check_concepts(session, principal, body)
    except UnavailableConcept as exc:
        raise _unavailable_concept() from exc
    await write_document(session, principal, item, body)
    session.add(_audit(principal, "item.saved", item))
    await session.commit()
    await session.refresh(item)
    return await _out(session, principal, item)


@router.post("/{item_id}/publish", response_model=ProblemOut)
async def publish_problem(
    item_id: uuid.UUID, body: PublishIn, principal: CurrentTeacher, session: SessionDep
) -> ProblemOut:
    """Make a draft available to sets — and retire the version it replaces, if any."""
    item = await get_owned_item(session, principal, item_id)
    if item.status != ItemStatus.DRAFT:
        raise _conflict("Only a draft can be published")
    if body.verified_updated_at != item.updated_at:
        raise _conflict("The problem changed since its tests were run. Run them again.")
    doc, _ = await read_document(session, principal, item)
    if problems := publish_problems(doc):
        # One sentence, the shape every other refusal has. The editor already lists the
        # gaps from `publish_problems` on every read; this is only reached by a race.
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Not ready to publish yet: " + "; ".join(problems),
        )

    if item.supersedes_id is not None:
        previous = await get_owned_item(session, principal, item.supersedes_id)
        if previous.status == ItemStatus.PUBLISHED:
            # Before the new version goes live: at most one published row per source_key.
            await set_status(session, principal, previous, ItemStatus.SUPERSEDED)
            await session.flush()
    await set_status(session, principal, item, ItemStatus.PUBLISHED)
    session.add(_audit(principal, "item.published", item, version=item.version))
    await session.commit()
    await session.refresh(item)
    return await _out(session, principal, item)


@router.post("/{item_id}/new-version", response_model=ProblemOut)
async def new_version(
    item_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep
) -> ProblemOut:
    """A draft copy of a published problem, to edit and publish in its place.

    If a draft of the next version already exists it is returned rather than a second one
    made: two teachers pressing "edit" on the same problem should land on the same draft.
    """
    item = await get_owned_item(session, principal, item_id)
    if item.status != ItemStatus.PUBLISHED:
        raise _conflict("Only a published problem gets a new version. Edit the draft instead.")
    existing = (
        await session.exec(
            select(Item).where(
                Item.supersedes_id == item.id,
                Item.centre_id == principal.centre_id,
                Item.status == ItemStatus.DRAFT,
            )
        )
    ).first()
    if existing is not None:
        return await _out(session, principal, existing)

    doc, _ = await read_document(session, principal, item)
    successor = Item(
        centre_id=item.centre_id,
        kind=item.kind,
        title=item.title,
        version=item.version + 1,
        supersedes_id=item.id,
        source_key=item.source_key,
        created_by=principal.subject_id,
    )
    session.add(successor)
    await session.flush()
    await write_document(session, principal, successor, doc)
    session.add(_audit(principal, "item.new_version", successor, version=successor.version))
    await session.commit()
    await session.refresh(successor)
    return await _out(session, principal, successor)


@router.post("/{item_id}/archive", response_model=ProblemOut)
async def archive_problem(
    item_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep
) -> ProblemOut:
    """Take a problem out of the bank. Sets that already use it keep it."""
    item = await get_owned_item(session, principal, item_id)
    if item.status == ItemStatus.SUPERSEDED:
        raise _conflict("An old version is already retired")
    if item.status != ItemStatus.ARCHIVED:
        await set_status(session, principal, item, ItemStatus.ARCHIVED)
        session.add(_audit(principal, "item.archived", item))
        await session.commit()
        await session.refresh(item)
    return await _out(session, principal, item)


@router.post("/{item_id}/unarchive", response_model=ProblemOut)
async def unarchive_problem(
    item_id: uuid.UUID, principal: CurrentTeacher, session: SessionDep
) -> ProblemOut:
    """Bring a problem back as a draft.

    Always to draft, never straight to published: a newer version may have been published
    while this one was put away, and a re-publish runs the tests again anyway.
    """
    item = await get_owned_item(session, principal, item_id)
    if item.status != ItemStatus.ARCHIVED:
        raise _conflict("Only an archived problem can be brought back")
    await set_status(session, principal, item, ItemStatus.DRAFT)
    session.add(_audit(principal, "item.unarchived", item))
    try:
        await session.commit()
    except IntegrityError as exc:  # the one-draft-per-source_key index
        await session.rollback()
        raise _conflict("There is already a draft of this problem") from exc
    await session.refresh(item)
    return await _out(session, principal, item)
