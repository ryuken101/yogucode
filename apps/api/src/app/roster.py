"""Turning a teacher's pasted list of names into decisions about children.

A teacher will not add twelve students one form at a time, so the roster's primary entry
path is a textarea. The awkward part is not parsing it — it is that a pasted name is
ambiguous evidence. "Bella N" might be a new child, or the Bella N who was in last term's
class, or a second Bella N who is genuinely a different person, or a line the teacher
fat-fingered. Guessing wrong in the first case costs Phase 8 its promise that mastery
follows a child across terms; guessing wrong in the third merges two children's records.

So this module only ever *proposes*. `resolve_paste` returns one verdict per line and
writes nothing; the router hands those verdicts to the teacher, and a second request
commits the ones they accepted. The commit re-runs this same resolution rather than
trusting the verdicts it is sent — the preview is an affordance for the teacher, not the
authority on what happens.

Parsing splits on newlines and tabs and **not on commas.** Newlines cover a typed list
and a pasted spreadsheet column, tabs cover a pasted row. A comma inside a line is more
likely part of a naming habit than a separator, and guessing wrong there silently splits
one child into two. `"Aiden C, Bella N"` instead arrives as one odd-looking name, which
the teacher sees in the preview and fixes — which is the whole reason the preview exists.
"""

import re
import uuid
from collections.abc import Container, Sequence
from dataclasses import dataclass, field
from enum import StrEnum

from app.models import Student, StudentStatus

# The display name is the only PII a student carries, so the cap is about sanity rather
# than storage: the column is an unbounded Postgres varchar, exactly like `classes.name`,
# and the limit lives on the DTO.
MAX_NAME_LENGTH = 80

# Twelve is the real target. A hundred fits a whole centre in one paste without letting a
# single request become a way to bulk-write rows, and the character cap on the raw text
# bounds the parsing itself.
MAX_ENTRIES = 100
MAX_PASTE_CHARS = 20_000

# `str.splitlines()` already consumed \n \r \v \f \x1c-\x1e \x85 and the Unicode line
# separators, and tabs are split on separately. What is left is genuinely not a name.
_CONTROL_CHARS = re.compile(r"[\x00-\x08\x0e-\x1b\x7f]")
_WHITESPACE_RUN = re.compile(r"\s+")


def normalise_name(raw: str) -> str:
    """Trim, and collapse internal whitespace runs to a single space.

    A pasted name arrives with whatever the source had in it — a trailing space from a
    spreadsheet cell, a double space between first name and initial. Storing those
    verbatim makes two spellings of one child, and makes the duplicate check miss.
    """
    return _WHITESPACE_RUN.sub(" ", raw).strip()


def name_key(raw: str) -> str:
    """The comparison key for a name.

    Every place that asks "is this the same name" must use this, so the preview, the bulk
    commit and the single-enrolment conflict check cannot disagree with each other.
    """
    return normalise_name(raw).casefold()


def name_problem(name: str) -> str | None:
    """Why a normalised name is unusable, or None if it is fine."""
    if not name:
        return "blank"
    if len(name) > MAX_NAME_LENGTH:
        return f"longer than {MAX_NAME_LENGTH} characters"
    if _CONTROL_CHARS.search(name):
        return "contains control characters"
    return None


class PasteAction(StrEnum):
    CREATE = "create"
    ENROL_EXISTING = "enrol_existing"
    ALREADY_ENROLLED = "already_enrolled"
    AMBIGUOUS = "ambiguous"
    DUPLICATE_IN_PASTE = "duplicate_in_paste"
    INVALID = "invalid"


#: The verdicts a teacher has to resolve before a commit will accept them.
UNRESOLVED_ACTIONS = frozenset(
    {PasteAction.AMBIGUOUS, PasteAction.DUPLICATE_IN_PASTE, PasteAction.INVALID}
)


@dataclass(frozen=True, slots=True)
class ParsedLine:
    """One candidate name, and where in the pasted text it came from."""

    line: int
    """1-based, counted in the original text — so a preview can point at the bad line
    even though blank lines were dropped and tab-separated fragments share a line."""
    raw: str
    name: str
    problem: str | None = None


@dataclass(frozen=True, slots=True)
class Candidate:
    """An existing centre student a pasted name might refer to."""

    student_id: uuid.UUID
    display_name: str
    status: StudentStatus


@dataclass(frozen=True, slots=True)
class PreviewEntry:
    line: int
    raw: str
    name: str
    action: PasteAction
    student_id: uuid.UUID | None = None
    student_status: StudentStatus | None = None
    candidates: tuple[Candidate, ...] = ()
    reason: str | None = None


@dataclass(slots=True)
class ParseResult:
    entries: list[ParsedLine] = field(default_factory=list)
    truncated: bool = False
    """True when the paste held more than MAX_ENTRIES names, so `entries` is the first
    MAX_ENTRIES of them. Reported rather than silently dropped."""


def parse_names(raw: str) -> ParseResult:
    """Split pasted text into candidate names, keeping original line numbers.

    Lines that are empty after normalisation are dropped rather than reported: a paste
    almost always has a trailing newline, and calling that an error would be pedantic.
    A name that is present but unusable is kept, with `problem` set, so the teacher sees
    it was noticed rather than silently swallowed.
    """
    result = ParseResult()
    for index, line in enumerate(raw.splitlines(), start=1):
        for fragment in line.split("\t"):
            name = normalise_name(fragment)
            if not name:
                continue
            if len(result.entries) >= MAX_ENTRIES:
                result.truncated = True
                return result
            result.entries.append(
                ParsedLine(line=index, raw=fragment, name=name, problem=name_problem(name))
            )
    return result


def resolve_paste(
    parsed: Sequence[ParsedLine],
    centre_students: Sequence[Student],
    active_enrolled_ids: Container[uuid.UUID],
) -> list[PreviewEntry]:
    """Assign each parsed name a verdict against the centre's existing students.

    `centre_students` is every student at the centre including archived ones — a child who
    left and came back should be recognised, not duplicated. `active_enrolled_ids` is who
    is already actively in this class.

    Order of the checks matters in one non-obvious place: **already-enrolled wins over
    ambiguous.** If a centre has two legitimately distinct students named "Aiden C" and
    one of them is already in this class, the useful answer is "Aiden C is already in this
    class", not "pick which Aiden C you meant" — and enrolling the other one would be
    refused anyway, because two identically-named children in one class break the name
    picker a student uses to sign in.
    """
    by_key: dict[str, list[Student]] = {}
    for student in centre_students:
        by_key.setdefault(name_key(student.display_name), []).append(student)
    for matches in by_key.values():
        matches.sort(key=lambda s: (s.display_name.casefold(), s.id))

    resolved: list[PreviewEntry] = []
    seen: set[str] = set()

    for line in parsed:
        if line.problem is not None:
            resolved.append(
                PreviewEntry(
                    line=line.line,
                    raw=line.raw,
                    name=line.name,
                    action=PasteAction.INVALID,
                    reason=line.problem,
                )
            )
            continue

        key = name_key(line.name)
        if key in seen:
            resolved.append(
                PreviewEntry(
                    line=line.line,
                    raw=line.raw,
                    name=line.name,
                    action=PasteAction.DUPLICATE_IN_PASTE,
                    reason="the same name appears earlier in this list",
                )
            )
            continue
        seen.add(key)

        matches = by_key.get(key, [])
        enrolled = next((s for s in matches if s.id in active_enrolled_ids), None)
        if enrolled is not None:
            action, student = PasteAction.ALREADY_ENROLLED, enrolled
        elif not matches:
            action, student = PasteAction.CREATE, None
        elif len(matches) == 1:
            action, student = PasteAction.ENROL_EXISTING, matches[0]
        else:
            resolved.append(
                PreviewEntry(
                    line=line.line,
                    raw=line.raw,
                    name=line.name,
                    action=PasteAction.AMBIGUOUS,
                    candidates=tuple(
                        Candidate(student_id=s.id, display_name=s.display_name, status=s.status)
                        for s in matches
                    ),
                    reason=f"{len(matches)} students at this centre have this name",
                )
            )
            continue

        resolved.append(
            PreviewEntry(
                line=line.line,
                raw=line.raw,
                name=line.name,
                action=action,
                student_id=student.id if student else None,
                student_status=student.status if student else None,
            )
        )

    return resolved
