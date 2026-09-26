"""Student PINs: generation, hashing, and the lockout arithmetic.

**Teachers set PINs; students never choose one.** The API mints the PIN, returns the
plaintext exactly once so it can be printed on a slip, and stores only an Argon2id hash.
The alternative — a child claiming an unclaimed name on first login and picking their own
PIN — lets whoever reaches a laptop first claim someone else's name, and from Phase 8 that
means another child's mastery data.

Two consequences of that, both deliberate:

- **Weak-PIN rejection is exclusion from the generator, not request validation.** No human
  ever types a PIN, so there is nothing to validate; there is only a draw to refuse.
- **A forgotten PIN can only be replaced, never recovered.** The hash is one-way, so not
  even the teacher can look one up. That is why `pin.reset` is a primary flow rather than
  an edge case: a Year 4 student forgets theirs roughly weekly.

**On the honest value of hashing here.** Four digits is a 10,000-space. Against someone
holding the database that is a trivial offline search, and no KDF parameters change that.
What hashing buys is that a child's credential never sits in plaintext in a table, a log,
a backup or a screenshot — which is the Privacy Act point, and reason enough on its own.
The threat the *PIN* defends against is a classmate, who gets five guesses.

That is also why the Argon2id parameters are set explicitly rather than left at
argon2-cffi's defaults. The default `memory_cost` is 64 MiB per verification; twelve
children signing in at the start of a lesson would be up to 768 MiB of peak allocation on
a Fly.io machine that may have 256 MiB. OWASP's Argon2id minimum — 19 MiB, t=2, p=1 —
gives the same not-in-plaintext guarantee at a fraction of the memory, and buys nothing
less against an attack that a 4-digit secret already loses.
"""

import secrets

from argon2 import PasswordHasher
from argon2.exceptions import Argon2Error, InvalidHashError, VerifyMismatchError

PIN_LENGTH = 4

# OWASP's Argon2id minimum. See the module docstring for why the default is wrong here.
_hasher = PasswordHasher(time_cost=2, memory_cost=19_456, parallelism=1, hash_len=32, salt_len=16)

# The four the phase plan names by hand. The rules below already cover all of them; they
# are listed so the connection to the written threat model is not lost.
NAMED_WEAK_PINS = frozenset({"0000", "1234", "1111", "1212"})


def is_weak(pin: str) -> bool:
    """Whether a PIN is one a classmate would try first.

    Three shapes, which together are about 120 of the 10,000: every digit the same, a run
    of consecutive digits in either direction (including wrapping past 9), and a repeated
    pair like 1212. Excluding them costs nothing — the generator simply draws again.
    """
    if len(pin) != PIN_LENGTH or not pin.isdigit():
        return True
    if pin in NAMED_WEAK_PINS:
        return True

    digits = [int(d) for d in pin]
    if len(set(digits)) == 1:
        return True
    pairs = list(zip(digits[:-1], digits[1:], strict=True))
    if all((b - a) % 10 == 1 for a, b in pairs):
        return True
    if all((a - b) % 10 == 1 for a, b in pairs):
        return True
    return digits[0] == digits[2] and digits[1] == digits[3]


def generate_pin() -> str:
    """A fresh PIN that is not an obvious one. `secrets`, not `random`."""
    while True:
        pin = f"{secrets.randbelow(10**PIN_LENGTH):0{PIN_LENGTH}d}"
        if not is_weak(pin):
            return pin


def hash_pin(pin: str) -> str:
    return _hasher.hash(pin)


def verify_pin(pin_hash: str, pin: str) -> bool:
    """Constant-ish time check. A malformed stored hash is a failure, never a crash."""
    try:
        return _hasher.verify(pin_hash, pin)
    except VerifyMismatchError:
        return False
    except (InvalidHashError, Argon2Error):
        # InvalidHashError subclasses ValueError rather than Argon2Error, so it has to be
        # named: a stored hash this library cannot parse would otherwise be a 500 instead
        # of a refusal. Nobody can sign in to that account either way, which is the safe
        # direction; the teacher's remedy is a reset.
        return False
