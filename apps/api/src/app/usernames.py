"""Student usernames: what they look like, and suggesting one from a name.

A child signs in with a username and a PIN (Ken's decision, 11 Oct 2026). The teacher
types the name and the username is suggested — "Aria Kim" → `aria.k` — and can be edited.
Usernames are unique across the whole system, case-insensitively, so sign-in needs
nothing else to find the account; a taken suggestion gets a number (`aria.k2`).

Lower-case letters, digits and dots only, 2–30 long: easy for a nine-year-old to type
on a shared laptop, and nothing that looks different but reads the same.
"""

import re
import unicodedata

from fastapi import HTTPException, status
from sqlmodel import func, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.models import Student

USERNAME_RE = re.compile(r"^[a-z0-9.]{2,30}$")
MAX_BASE = 26  # room for a number on the end


def base_username(display_name: str) -> str:
    """ "Aria Kim" → "aria.k"; "Chen" → "chen"; accents dropped; never shorter than 2."""
    ascii_name = (
        unicodedata.normalize("NFKD", display_name).encode("ascii", "ignore").decode().lower()
    )
    words = re.findall(r"[a-z0-9]+", ascii_name)
    if not words:
        return "student"
    base = f"{words[0]}.{words[-1][0]}" if len(words) > 1 else words[0]
    base = base[:MAX_BASE].strip(".")
    return base if len(base) >= 2 else "student"


def suggest_username(display_name: str, taken: set[str]) -> str:
    base = base_username(display_name)
    if base not in taken:
        return base
    number = 2
    while f"{base}{number}" in taken:
        number += 1
    return f"{base}{number}"


def clean_username(raw: str) -> str:
    """A username as typed, made canonical — or a 422 a teacher can act on."""
    username = raw.strip().lower()
    if not USERNAME_RE.fullmatch(username):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Usernames use lower-case letters, numbers and dots, 2 to 30 long",
        )
    return username


async def taken_usernames(session: AsyncSession) -> set[str]:
    """Every username in use, lower-cased. Across all centres: usernames are global."""
    return set((await session.exec(select(func.lower(Student.username)))).all())


def username_taken(suggestion: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={
            "code": "username_taken",
            "message": f"That username is taken — how about {suggestion}?",
            "suggestion": suggestion,
        },
    )
