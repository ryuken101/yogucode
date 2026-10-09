"""The bootstrap allowlist: who may become a teacher without an invite (the first owner).

Sign-in is gated on this in step 3. Without it, anyone who can request a magic link on
the staging URL provisions a centre.
"""

import pytest

from app.config import Settings


@pytest.mark.parametrize(
    ("allowlist", "email", "expected"),
    [
        ("ken@example.com", "ken@example.com", True),
        ("ken@example.com", "KEN@Example.com", True),
        ("ken@example.com", " ken@example.com ", True),
        ("ken@example.com", "someone@example.com", False),
        ("@magikid.com.au", "teacher@magikid.com.au", True),
        ("@magikid.com.au", "teacher@notmagikid.com.au", False),
        ("@magikid.com.au", "teacher@magikid.com.au.evil.com", False),
        ("ken@example.com, @magikid.com.au", "teacher@magikid.com.au", True),
        ("", "anyone@example.com", False),
    ],
)
def test_teacher_email_allowlist(allowlist: str, email: str, expected: bool) -> None:
    settings = Settings(teacher_email_allowlist=allowlist)
    assert settings.is_teacher_email_allowed(email) is expected
