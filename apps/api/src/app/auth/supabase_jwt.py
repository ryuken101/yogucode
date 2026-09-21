"""Verification of Supabase Auth access tokens against the project's JWKS.

Supabase signs session JWTs with an asymmetric key (ES256 on a P-256 curve for new
projects, RS256 also possible) and publishes the public half at
`{SUPABASE_URL}/auth/v1/.well-known/jwks.json`. The public key is safe to fetch and
cache; verification needs no call to Supabase per request.

**Only asymmetric algorithms are accepted.** Supabase still supports a legacy HS256
shared secret, and we deliberately do not implement that path: accepting both families
is where JWT algorithm-confusion bugs live, and a shared secret is a symmetric key this
service would have to hold. If a project ever turns out to lack asymmetric keys, that is
a step-10 discovery to solve then, not a code path to carry until it happens.

Cache behaviour, in order of how much trouble each avoids:

- **Refresh when a token carries an unknown `kid`.** This is how a key rotation is
  picked up without a redeploy. A cache that only expires on a timer breaks for however
  long the TTL is after every rotation — a real, reported Supabase failure mode.
- **Rate-limit those refreshes.** Otherwise a forged token with a random `kid` is a free
  way to make this service hammer Supabase.
- **One fetch at a time.** A lock, so twelve requests arriving together produce one
  outbound call rather than twelve.
- **Serve stale keys if a refresh fails.** A Supabase outage should not sign out a
  teacher mid-lesson. Keys are long-lived and rotation is rare, so stale keys are a far
  smaller risk than a hard dependency on Supabase being reachable for every request.
"""

import asyncio
import time
import uuid
from dataclasses import dataclass
from typing import Any

import httpx
import jwt
from jwt import PyJWKSet

from app.config import Settings, get_settings

# Asymmetric only. Never add an HS* algorithm here: the verifying key would then be a
# secret the API holds, and a token could name the algorithm it is verified with.
ALLOWED_ALGORITHMS = ["ES256", "RS256"]


class TokenError(Exception):
    """The token is missing, malformed, expired, or not signed by this project."""


class JWKSUnavailable(Exception):
    """The signing keys could not be fetched and nothing usable is cached."""


@dataclass
class TeacherClaims:
    """The parts of a verified Supabase token this application acts on."""

    supabase_user_id: uuid.UUID
    email: str
    display_name: str | None

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "TeacherClaims":
        subject = payload.get("sub")
        email = payload.get("email")
        if not subject or not email:
            # A token without these is valid to Supabase but useless to us: there is
            # nobody to provision. Treated as a bad token rather than a 500.
            raise TokenError("token is missing sub or email")

        try:
            supabase_user_id = uuid.UUID(str(subject))
        except ValueError as exc:
            # users.supabase_user_id is a uuid column; Supabase always issues a UUID sub.
            raise TokenError("sub is not a uuid") from exc

        metadata = payload.get("user_metadata") or {}
        display_name = metadata.get("full_name") or metadata.get("name")
        return cls(
            supabase_user_id=supabase_user_id,
            email=str(email),
            display_name=str(display_name) if display_name else None,
        )


class SupabaseJWKSVerifier:
    def __init__(
        self,
        settings: Settings | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.settings = settings or get_settings()
        # Injected in tests so the JWKS document can be served without a network call
        # or a real project. None means httpx's own transport.
        self._transport = transport
        self._jwks: PyJWKSet | None = None
        self._fetched_at: float = 0.0
        self._last_forced_at: float = float("-inf")
        self._lock = asyncio.Lock()

    async def verify(self, token: str) -> TeacherClaims:
        """Verify a token's signature and claims, or raise TokenError."""
        try:
            header = jwt.get_unverified_header(token)
        except jwt.PyJWTError as exc:
            raise TokenError("malformed token header") from exc

        # Reject the algorithm before touching the key, so an unexpected `alg` can never
        # reach the decode step.
        algorithm = header.get("alg")
        if algorithm not in ALLOWED_ALGORITHMS:
            raise TokenError(f"unsupported signing algorithm: {algorithm!r}")

        kid = header.get("kid")
        if not kid:
            raise TokenError("token header is missing kid")

        key = await self._signing_key(kid)
        settings = self.settings
        try:
            payload = jwt.decode(
                token,
                key=key,
                algorithms=ALLOWED_ALGORITHMS,
                audience=settings.supabase_jwt_audience,
                issuer=settings.supabase_issuer,
                options={"require": ["exp", "sub"], "verify_exp": True},
            )
        except jwt.PyJWTError as exc:
            # The reason is deliberately not echoed to the caller; it goes in logs, not
            # in a 401 body.
            raise TokenError(f"token rejected: {exc}") from exc

        return TeacherClaims.from_payload(payload)

    async def _signing_key(self, kid: str):
        jwks = await self._current_jwks()
        key = self._find(jwks, kid)
        if key is not None:
            return key

        # Unknown kid: either a rotation we have not seen, or a forged token. Refresh
        # once, rate-limited, then decide.
        jwks = await self._current_jwks(force=True)
        key = self._find(jwks, kid)
        if key is None:
            raise TokenError(f"no signing key matches kid {kid!r}")
        return key

    @staticmethod
    def _find(jwks: PyJWKSet | None, kid: str):
        if jwks is None:
            return None
        for candidate in jwks.keys:
            if candidate.key_id == kid:
                return candidate.key
        return None

    def _is_fresh(self, now: float) -> bool:
        return (
            self._jwks is not None and now - self._fetched_at < self.settings.jwks_cache_ttl_seconds
        )

    async def _current_jwks(self, force: bool = False) -> PyJWKSet | None:
        if not force and self._is_fresh(time.monotonic()):
            return self._jwks

        async with self._lock:
            # Another request may have refreshed while this one waited for the lock.
            now = time.monotonic()
            if not force and self._is_fresh(now):
                return self._jwks

            if force and self._jwks is not None:
                # The rate limit governs forced refreshes only, and is deliberately not
                # primed by the ordinary first fetch — otherwise the very first unknown
                # kid after startup would be refused, which is the key-rotation case
                # this exists to handle.
                since_forced = now - self._last_forced_at
                if since_forced < self.settings.jwks_min_refresh_interval_seconds:
                    # A token with an unrecognised kid is not a lever for driving
                    # traffic at Supabase.
                    return self._jwks
                self._last_forced_at = now

            try:
                self._jwks = await self._fetch()
                self._fetched_at = time.monotonic()
            except (httpx.HTTPError, ValueError, KeyError) as exc:
                if self._jwks is not None:
                    # Stale keys beat signing every teacher out during a Supabase blip.
                    return self._jwks
                raise JWKSUnavailable("could not fetch Supabase signing keys") from exc

        return self._jwks

    async def _fetch(self) -> PyJWKSet:
        settings = self.settings
        if not settings.supabase_url:
            raise JWKSUnavailable("SUPABASE_URL is not configured")

        timeout = settings.jwks_request_timeout_seconds
        async with httpx.AsyncClient(timeout=timeout, transport=self._transport) as client:
            response = await client.get(settings.supabase_jwks_url)
            response.raise_for_status()
            return PyJWKSet.from_dict(response.json())


_verifier: SupabaseJWKSVerifier | None = None


def get_verifier() -> SupabaseJWKSVerifier:
    """The process-wide verifier, so the key cache is shared across requests."""
    global _verifier
    if _verifier is None:
        _verifier = SupabaseJWKSVerifier()
    return _verifier


def reset_verifier() -> None:
    """Drop the cached verifier. For tests, and for a config change at runtime."""
    global _verifier
    _verifier = None
