"""A limit on wrong PIN guesses per device (IP address) — Ken's decision, 11 Oct 2026.

Children sign in with a username and a PIN, with no class code in front any more. The
per-child lockout (5 wrong tries → 15 minutes) stops guessing one child's PIN; this stops
one device guessing across many children's usernames. Only failures count, so a class of
twelve signing in at once from the centre's one IP address is never slowed.

In memory, like the live hub: one machine (fly.toml). A restart forgets the counts,
which costs an attacker nothing they couldn't get by waiting out the window.
"""

import time
from collections import deque


class FailureLimiter:
    def __init__(self) -> None:
        self._failures: dict[str, deque[float]] = {}

    def _recent(self, key: str, window_seconds: float, now: float) -> deque[float]:
        times = self._failures.setdefault(key, deque())
        while times and times[0] <= now - window_seconds:
            times.popleft()
        return times

    def blocked(self, key: str, limit: int, window_seconds: float) -> bool:
        return len(self._recent(key, window_seconds, time.monotonic())) >= limit

    def fail(self, key: str, window_seconds: float) -> None:
        now = time.monotonic()
        self._recent(key, window_seconds, now).append(now)

    def reset(self) -> None:
        self._failures.clear()


pin_failures = FailureLimiter()
