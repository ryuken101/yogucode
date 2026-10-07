"""Problems from a YAML file — the fast path for writing a bank.

Spec §7: writing 100+ good problems is the real bottleneck, and nobody writes a hundred
problems one web form at a time. A file can be written in an editor, reviewed, shared with
another teacher and imported in one go.

**The file format is written for teachers, not for the API.** `prints:` and `returns:`
rather than `kind: io` and `expected:`; concepts by key (`lists`) rather than by uuid.
`to_document` translates one entry into the `ProblemDoc` the editor saves, so an imported
problem is indistinguishable from a typed one.

**Importing is two steps: plan, then apply.** The plan says, per entry, what would happen —
create, update the draft, start a new version, or nothing — and the apply does exactly
that. A teacher sees the plan before anything changes, and a file with any error applies
nothing: half an import is harder to reason about than none.

**Import never publishes.** Publishing needs the reference solution run in a browser
(`problem_bank.py`), so imported problems arrive as drafts and the bank's "Check & publish
all" finishes the job. A changed problem that is already published gets a new-version
draft, exactly as "Make changes" would — what students saw stays live until then.

`key` is each problem's identity across imports (`items.source_key`). Re-importing an
unchanged file is a no-op.

    uv run check-problems problems.yaml     # validate a file, no database
"""

import sys
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.audit import audit_entry
from app.auth.principal import Principal
from app.models import Item, ItemStatus
from app.problem_bank import (
    FunctionTest,
    HintDoc,
    IoTest,
    OptionDoc,
    PartDoc,
    ProblemDoc,
    publish_problems,
    read_document,
    write_document,
)
from app.scoping import list_visible_concepts

MAX_FILE_CHARS = 1_000_000
MAX_PROBLEMS = 200
KEY_PATTERN = r"^[a-z0-9][a-z0-9_-]{0,79}$"


# --- the file format ------------------------------------------------------------------


class _Strict(BaseModel):
    # A misspelt field ("prompts:") should be an error, not silently ignored.
    model_config = ConfigDict(extra="forbid")


class FileTest(_Strict):
    name: str
    hidden: bool = False
    # Exactly one of these two shapes:
    prints: str | None = None
    input: str = ""
    match: Literal["exact", "contains"] = "exact"
    call: str | None = None
    returns: str | None = None

    @model_validator(mode="after")
    def _one_shape(self) -> "FileTest":
        if (self.prints is None) == (self.call is None):
            raise ValueError("a test needs either `prints:` or `call:` + `returns:`")
        if self.call is not None and self.returns is None:
            raise ValueError("a `call:` test needs `returns:`")
        return self


class FileOption(_Strict):
    text: str
    correct: bool = False
    misconception: str | None = None


class FileHint(_Strict):
    text: str
    after_runs: int = 1
    after_minutes: float = 2


class FileLeaf(_Strict):
    difficulty: int = 1
    concepts: list[str] = Field(default_factory=list)
    main: str | None = None
    starter: str = ""
    solution: str = ""
    tests: list[FileTest] = Field(default_factory=list)
    hints: list[FileHint] = Field(default_factory=list)


class FilePart(FileLeaf):
    label: str
    prompt: str = ""


class FileProblem(FileLeaf):
    key: str = Field(pattern=KEY_PATTERN)
    title: str
    prompt: str = ""
    parts: list[FilePart] = Field(default_factory=list)
    # A problem with `options:` is multiple choice; one is `correct: true`, and each wrong
    # one should name its `misconception`.
    options: list[FileOption] = Field(default_factory=list)


class ProblemFile(_Strict):
    problems: list[FileProblem] = Field(max_length=MAX_PROBLEMS)


# --- translation ----------------------------------------------------------------------


class ProblemFileError(ValueError):
    """One entry cannot be imported; the message names what to fix."""


def _leaf_fields(leaf: FileLeaf, concept_ids: dict[str, uuid.UUID]) -> dict:
    unknown = [
        key
        for key in [*leaf.concepts, *([leaf.main] if leaf.main else [])]
        if key not in concept_ids
    ]
    if unknown:
        raise ProblemFileError(f"unknown concept {', '.join(sorted(set(unknown)))}")
    if leaf.main is not None and leaf.main not in leaf.concepts:
        raise ProblemFileError(f"main concept {leaf.main} is not in its concepts list")
    main = leaf.main or (leaf.concepts[0] if leaf.concepts else None)
    return {
        "difficulty": leaf.difficulty,
        "concept_ids": [concept_ids[key] for key in leaf.concepts],
        "primary_concept_id": concept_ids[main] if main else None,
        "starter_code": leaf.starter,
        "solution_code": leaf.solution,
        "tests": [
            IoTest(name=t.name, hidden=t.hidden, stdin=t.input, expected=t.prints, match=t.match)
            if t.prints is not None
            else FunctionTest(
                kind="function", name=t.name, hidden=t.hidden, call=t.call, expected=t.returns
            )
            for t in leaf.tests
        ],
        "hints": [
            HintDoc(
                body_md=h.text,
                unlock_after_runs=h.after_runs,
                unlock_after_seconds=round(h.after_minutes * 60),
            )
            for h in leaf.hints
        ],
    }


def to_document(entry: FileProblem, concept_ids: dict[str, uuid.UUID]) -> ProblemDoc:
    """One file entry as the document the editor would save. Raises ProblemFileError."""
    try:
        return ProblemDoc(
            kind="mcq" if entry.options else "code",
            options=[OptionDoc(**option.model_dump()) for option in entry.options],
            title=entry.title,
            prompt_md=entry.prompt,
            parts=[
                PartDoc(label=p.label, prompt_md=p.prompt, **_leaf_fields(p, concept_ids))
                for p in entry.parts
            ],
            **_leaf_fields(entry, concept_ids),
        )
    except ValidationError as exc:
        raise ProblemFileError(_first_error(exc)) from exc


def _first_error(exc: ValidationError) -> str:
    error = exc.errors()[0]
    where = ".".join(str(part) for part in error["loc"])
    return f"{where}: {error['msg']}" if where else error["msg"]


def parse_file(text: str) -> ProblemFile:
    """The file, structurally checked. Raises ProblemFileError with a line-free message."""
    if len(text) > MAX_FILE_CHARS:
        raise ProblemFileError("the file is too large — split it into several")
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        raise ProblemFileError(f"this is not valid YAML: {exc}") from exc
    try:
        parsed = ProblemFile.model_validate(data)
    except ValidationError as exc:
        raise ProblemFileError(_first_error(exc)) from exc
    keys = [p.key for p in parsed.problems]
    duplicates = sorted({k for k in keys if keys.count(k) > 1})
    if duplicates:
        raise ProblemFileError(f"the key {', '.join(duplicates)} is used twice")
    return parsed


# --- plan and apply -------------------------------------------------------------------

Action = Literal["create", "update_draft", "new_version", "unchanged", "error"]


@dataclass
class PlannedEntry:
    key: str
    title: str
    action: Action
    doc: ProblemDoc | None = None
    target: Item | None = None
    error: str | None = None
    publish_problems: list[str] = field(default_factory=list)
    item_id: uuid.UUID | None = None


def _comparable(doc: ProblemDoc) -> dict:
    """A document as a value, with tag order not mattering — the server stores them sorted."""
    dumped = doc.model_dump(mode="json")
    for leaf in [dumped, *dumped["parts"]]:
        leaf["concept_ids"] = sorted(leaf["concept_ids"])
    return dumped


async def _live(session: AsyncSession, principal: Principal, key: str) -> dict[ItemStatus, Item]:
    rows = (
        await session.exec(
            select(Item).where(
                Item.centre_id == principal.centre_id,
                Item.source_key == key,
                Item.parent_id.is_(None),  # type: ignore[union-attr]
                Item.status.in_([ItemStatus.DRAFT, ItemStatus.PUBLISHED]),  # type: ignore[attr-defined]
            )
        )
    ).all()
    return {row.status: row for row in rows}


async def plan_import(session: AsyncSession, principal: Principal, text: str) -> list[PlannedEntry]:
    """What importing `text` would do. Raises ProblemFileError if the file as a whole is bad."""
    parsed = parse_file(text)
    concept_ids = {c.key: c.id for c in await list_visible_concepts(session, principal)}
    planned: list[PlannedEntry] = []
    for entry in parsed.problems:
        try:
            doc = to_document(entry, concept_ids)
        except ProblemFileError as exc:
            planned.append(PlannedEntry(entry.key, entry.title, "error", error=str(exc)))
            continue

        live = await _live(session, principal, entry.key)
        draft, published = live.get(ItemStatus.DRAFT), live.get(ItemStatus.PUBLISHED)
        # Compare against the newest live version: a draft if one is in progress.
        current = draft or published
        action: Action = "create"
        if current is not None:
            existing, _ = await read_document(session, principal, current)
            if _comparable(existing) == _comparable(doc):
                action = "unchanged"
            else:
                action = "update_draft" if draft is not None else "new_version"
        planned.append(
            PlannedEntry(
                entry.key,
                entry.title,
                action,
                doc=doc,
                target=current,
                publish_problems=publish_problems(doc),
                item_id=current.id if current else None,
            )
        )
    return planned


async def apply_import(
    session: AsyncSession, principal: Principal, planned: list[PlannedEntry]
) -> None:
    """Carry out a plan with no errors in it. The caller owns the transaction."""
    assert not any(p.action == "error" for p in planned), "apply only an error-free plan"
    for entry in planned:
        if entry.action in ("unchanged", "error") or entry.doc is None:
            continue
        if entry.action == "update_draft" and entry.target is not None:
            item = entry.target
        else:
            previous = entry.target
            item = Item(
                centre_id=principal.centre_id,
                title=entry.doc.title,
                source_key=entry.key,
                created_by=principal.subject_id,
                version=previous.version + 1 if previous else 1,
                supersedes_id=previous.id if previous else None,
            )
            session.add(item)
            await session.flush()
        await write_document(session, principal, item, entry.doc)
        entry.item_id = item.id
        session.add(
            audit_entry(
                principal,
                f"item.imported.{entry.action}",
                "item",
                item.id,
                title=item.title,
                source_key=entry.key,
            )
        )


# --- the command line -------------------------------------------------------------------


def main() -> None:
    """`uv run check-problems FILE` — validate a problem file without touching a database.

    Checks the structure, that every concept key exists in `seed/concepts.yaml`, and what
    each problem still lacks before it could be published. It does not run the solutions:
    that happens in the browser, under the same Pyodide the students use.
    """
    if len(sys.argv) != 2:
        print("usage: check-problems FILE.yaml", file=sys.stderr)
        raise SystemExit(2)
    concepts_file = Path(__file__).parent / "seed" / "concepts.yaml"
    concept_ids = {
        node["key"]: uuid.uuid5(uuid.NAMESPACE_URL, node["key"])
        for node in _walk(yaml.safe_load(concepts_file.read_text())["concepts"])
    }
    try:
        parsed = parse_file(Path(sys.argv[1]).read_text())
    except ProblemFileError as exc:
        print(f"✗ {exc}")
        raise SystemExit(1) from exc

    failed = False
    for entry in parsed.problems:
        try:
            doc = to_document(entry, concept_ids)
        except ProblemFileError as exc:
            failed = True
            print(f"✗ {entry.key}: {exc}")
            continue
        gaps = publish_problems(doc)
        print(f"{'✓' if not gaps else '○'} {entry.key}: {entry.title}")
        for gap in gaps:
            print(f"    – {gap}")
    raise SystemExit(1 if failed else 0)


def _walk(nodes: list[dict]):
    for node in nodes:
        yield node
        yield from _walk(node.get("children", []))
