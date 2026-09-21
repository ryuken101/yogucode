"""Token verification.

These are the tests that decide whether a forged token gets in, so they lean on real
cryptography: the fixtures generate an actual EC P-256 key and sign real tokens. Only
the JWKS endpoint is stubbed.
"""

import asyncio
import uuid
from datetime import UTC, datetime, timedelta

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec

from app.auth.supabase_jwt import JWKSUnavailable, SupabaseJWKSVerifier, TokenError


async def test_a_valid_token_yields_claims(verifier, make_token) -> None:
    subject = str(uuid.uuid4())
    claims = await verifier.verify(make_token(sub=subject, email="ken@example.com"))

    assert claims.supabase_user_id == uuid.UUID(subject)
    assert claims.email == "ken@example.com"
    assert claims.display_name == "Ken Nguyen"


async def test_display_name_falls_back_when_metadata_is_empty(verifier, make_token) -> None:
    claims = await verifier.verify(make_token(full_name=None))
    assert claims.display_name is None


async def test_an_expired_token_is_rejected(verifier, make_token) -> None:
    with pytest.raises(TokenError):
        await verifier.verify(make_token(expires_in=-60))


async def test_a_token_for_another_audience_is_rejected(verifier, make_token) -> None:
    """Supabase issues aud=anon for anonymous sessions; a teacher route is not for them."""
    with pytest.raises(TokenError):
        await verifier.verify(make_token(audience="anon"))


async def test_a_token_from_another_issuer_is_rejected(verifier, make_token) -> None:
    with pytest.raises(TokenError):
        await verifier.verify(make_token(issuer="https://attacker.supabase.co/auth/v1"))


async def test_a_token_signed_by_a_different_key_is_rejected(verifier, make_token) -> None:
    """Right shape, right kid, wrong key — the signature must be what decides."""
    attacker_key = ec.generate_private_key(ec.SECP256R1())
    with pytest.raises(TokenError):
        await verifier.verify(make_token(key=attacker_key))


async def test_an_hs256_token_is_rejected(verifier, jwks_document, supabase_url, test_kid) -> None:
    """Algorithm confusion: signing with the published public key as an HMAC secret.

    This is the classic JWT attack. The algorithm allowlist has to reject it before the
    key is ever selected.
    """
    public_jwk = jwks_document["keys"][0]
    forged = jwt.encode(
        {
            "sub": str(uuid.uuid4()),
            "email": "attacker@example.com",
            "aud": "authenticated",
            "iss": f"{supabase_url}/auth/v1",
            "exp": datetime.now(UTC) + timedelta(hours=1),
        },
        key=public_jwk["x"],
        algorithm="HS256",
        headers={"kid": test_kid},
    )
    with pytest.raises(TokenError, match="unsupported signing algorithm"):
        await verifier.verify(forged)


async def test_an_unsigned_token_is_rejected(verifier) -> None:
    forged = jwt.encode(
        {"sub": str(uuid.uuid4()), "email": "a@example.com"}, key=None, algorithm="none"
    )
    with pytest.raises(TokenError):
        await verifier.verify(forged)


async def test_a_token_without_sub_or_email_is_rejected(verifier, make_token) -> None:
    with pytest.raises(TokenError):
        await verifier.verify(make_token(email=""))


async def test_a_non_uuid_sub_is_rejected(verifier, make_token) -> None:
    """users.supabase_user_id is a uuid column, so a non-uuid sub cannot be stored."""
    with pytest.raises(TokenError, match="sub is not a uuid"):
        await verifier.verify(make_token(sub="not-a-uuid"))


async def test_garbage_is_rejected(verifier) -> None:
    with pytest.raises(TokenError):
        await verifier.verify("not.a.token")


# --- caching -----------------------------------------------------------------------


async def test_keys_are_fetched_once_and_then_cached(verifier, make_token, jwks_server) -> None:
    for _ in range(5):
        await verifier.verify(make_token())
    assert jwks_server.fetch_count == 1


async def test_an_unknown_kid_triggers_one_refresh(verifier, make_token, jwks_server) -> None:
    """How a key rotation is noticed without a redeploy."""
    await verifier.verify(make_token())
    assert jwks_server.fetch_count == 1

    with pytest.raises(TokenError, match="no signing key matches"):
        await verifier.verify(make_token(kid="rotated-key"))
    assert jwks_server.fetch_count == 2


async def test_unknown_kid_refreshes_are_rate_limited(verifier, make_token, jwks_server) -> None:
    """A forged kid must not be a lever for driving traffic at Supabase."""
    await verifier.verify(make_token())
    assert jwks_server.fetch_count == 1

    for index in range(10):
        with pytest.raises(TokenError):
            await verifier.verify(make_token(kid=f"forged-{index}"))

    # One refresh for the first unknown kid; the rest are refused by the interval.
    assert jwks_server.fetch_count == 2


async def test_a_rotated_key_is_picked_up(verifier, make_token, jwks_server, make_jwk) -> None:
    await verifier.verify(make_token())

    rotated_key = ec.generate_private_key(ec.SECP256R1())
    jwks_server.document = {"keys": [make_jwk(rotated_key.public_key(), "rotated-key")]}
    # The rate limiter would normally block the refresh; a rotation is exactly when it
    # must not, so the interval is set to zero for this test rather than sleeping.
    verifier.settings.jwks_min_refresh_interval_seconds = 0

    claims = await verifier.verify(make_token(kid="rotated-key", key=rotated_key))
    assert claims.email == "teacher@example.com"


async def test_stale_keys_are_served_when_the_refresh_fails(
    verifier, make_token, jwks_server
) -> None:
    """A Supabase blip must not sign out a teacher mid-lesson."""
    await verifier.verify(make_token())

    jwks_server.fail = True
    verifier.settings.jwks_cache_ttl_seconds = 0  # force a refresh attempt
    claims = await verifier.verify(make_token())
    assert claims.email == "teacher@example.com"


async def test_a_first_fetch_failure_raises(test_settings, jwks_server, make_token) -> None:
    """With nothing cached there is nothing to fall back to, so fail closed."""
    jwks_server.fail = True
    cold = SupabaseJWKSVerifier(test_settings, transport=httpx.MockTransport(jwks_server.handler))
    with pytest.raises(JWKSUnavailable):
        await cold.verify(make_token())


async def test_concurrent_verifications_fetch_the_keys_once(
    verifier, make_token, jwks_server
) -> None:
    """Twelve students' worth of requests at lesson start is one outbound call."""
    tokens = [make_token() for _ in range(12)]
    await asyncio.gather(*(verifier.verify(token) for token in tokens))
    assert jwks_server.fetch_count == 1
