"""Test fixtures.

Migrations are applied to the test database once per session, from empty. A broken
migration therefore fails the test run — there is no separate "does it migrate" step to
forget to run.

Each test then gets a session inside a transaction that is rolled back afterwards, so
tests never see each other's rows.
"""

import base64
import os
import subprocess
import uuid
from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import jwt
import pytest
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives.asymmetric import ec
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool
from sqlmodel.ext.asyncio.session import AsyncSession

from app.auth.rate_limit import pin_failures
from app.auth.supabase_jwt import SupabaseJWKSVerifier, get_verifier
from app.config import Settings, get_settings
from app.db import get_session
from app.main import app as fastapi_app
from app.models import Centre, Class, Enrolment, Student

API_ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="session")
def database_url() -> str:
    return get_settings().test_database_url


@pytest.fixture(scope="session")
def run_alembic(database_url: str):
    """Run an alembic command against the test database."""

    def _run(*args: str) -> subprocess.CompletedProcess[str]:
        env = {**os.environ, "ALEMBIC_DATABASE_URL": database_url}
        return subprocess.run(
            ["alembic", *args], cwd=API_ROOT, env=env, capture_output=True, text=True
        )

    return _run


@pytest.fixture(scope="session", autouse=True)
def migrated_database(run_alembic) -> None:
    """Bring the test database to head from empty, proving the migration both ways."""
    for args in (("downgrade", "base"), ("upgrade", "head")):
        result = run_alembic(*args)
        assert result.returncode == 0, result.stdout + result.stderr


@pytest.fixture
async def session(database_url: str) -> AsyncGenerator[AsyncSession, None]:
    engine = create_async_engine(database_url, poolclass=NullPool)
    connection = await engine.connect()
    transaction = await connection.begin()
    # create_savepoint keeps a test's own rollback — after an expected IntegrityError,
    # say — from tearing down the outer transaction this fixture owns. It also means a
    # route under test can call session.commit() without escaping the test's rollback.
    factory = async_sessionmaker(
        bind=connection,
        class_=AsyncSession,
        expire_on_commit=False,
        join_transaction_mode="create_savepoint",
    )
    async with factory() as db_session:
        yield db_session
    await transaction.rollback()
    await connection.close()
    await engine.dispose()


# --- Supabase token fixtures -------------------------------------------------------
#
# There is no Supabase project yet (step 10), and CI must not depend on one existing.
# These generate a real EC P-256 keypair, serve it as a JWKS document the verifier
# fetches through a stubbed transport, and mint genuinely signed tokens. The crypto is
# real; only the issuer is local.

SUPABASE_URL = "https://testproject.supabase.co"
TEST_PIN_KEY = Fernet.generate_key().decode()
TEST_KID = "test-key-1"


@pytest.fixture(scope="session")
def supabase_url() -> str:
    return SUPABASE_URL


@pytest.fixture(scope="session")
def test_kid() -> str:
    return TEST_KID


def jwk_from_public_key(key: ec.EllipticCurvePublicKey, kid: str) -> dict:
    """An EC public key in the JWK shape Supabase's JWKS endpoint publishes."""
    numbers = key.public_numbers()

    def b64(value: int) -> str:
        return base64.urlsafe_b64encode(value.to_bytes(32, "big")).rstrip(b"=").decode()

    return {
        "kty": "EC",
        "crv": "P-256",
        "kid": kid,
        "use": "sig",
        "alg": "ES256",
        "x": b64(numbers.x),
        "y": b64(numbers.y),
    }


@pytest.fixture(scope="session")
def make_jwk():
    """Expose the JWK builder to tests that need to publish a rotated key."""
    return jwk_from_public_key


@pytest.fixture(scope="session")
def signing_key() -> ec.EllipticCurvePrivateKey:
    return ec.generate_private_key(ec.SECP256R1())


@pytest.fixture(scope="session")
def jwks_document(signing_key: ec.EllipticCurvePrivateKey) -> dict:
    """The public half, in the shape Supabase's JWKS endpoint returns."""
    return {"keys": [jwk_from_public_key(signing_key.public_key(), TEST_KID)]}


@pytest.fixture
def make_token(signing_key: ec.EllipticCurvePrivateKey):
    """Mint a signed Supabase-shaped access token, with overridable claims."""

    def _make(
        *,
        sub: str | None = None,
        email: str = "teacher@example.com",
        full_name: str | None = "Ken Nguyen",
        audience: str = "authenticated",
        issuer: str | None = None,
        expires_in: int = 3600,
        kid: str = TEST_KID,
        algorithm: str = "ES256",
        key=None,
        **extra,
    ) -> str:
        now = datetime.now(UTC)
        payload = {
            "sub": sub if sub is not None else str(uuid.uuid4()),
            "email": email,
            "aud": audience,
            "iss": issuer if issuer is not None else f"{SUPABASE_URL}/auth/v1",
            "iat": now,
            "exp": now + timedelta(seconds=expires_in),
            "role": "authenticated",
            "user_metadata": {"full_name": full_name} if full_name else {},
            **extra,
        }
        return jwt.encode(
            payload,
            key if key is not None else signing_key,
            algorithm=algorithm,
            headers={"kid": kid},
        )

    return _make


@pytest.fixture
def jwks_server(jwks_document: dict):
    """A stub for the JWKS endpoint that counts how often it is fetched."""

    class Server:
        def __init__(self) -> None:
            self.document = jwks_document
            self.fetch_count = 0
            self.fail = False

        def handler(self, request: httpx.Request) -> httpx.Response:
            self.fetch_count += 1
            if self.fail:
                raise httpx.ConnectError("jwks unreachable", request=request)
            return httpx.Response(200, json=self.document)

    return Server()


@pytest.fixture
def test_settings() -> Settings:
    return Settings(
        supabase_url=SUPABASE_URL,
        teacher_email_allowlist="@example.com",
        centre_slug="castle-hill",
        centre_name="Magikid Castle Hill",
        # The test client's base_url is http://test, and httpx drops a Secure cookie
        # served over plain http — silently, so a round-trip sign-in test would fail
        # looking like a session bug. Off here; on everywhere real.
        cookie_secure=False,
        # The quiz timer would open a session outside the test's transaction; the lazy
        # finalise-on-read path is what the tests exercise instead.
        quiz_timer=False,
        quiz_stop_grace_seconds=0,
        # Show PIN on, under a key made fresh for the run. test_show_pin.py turns it off.
        pin_encryption_keys=TEST_PIN_KEY,
    )


@pytest.fixture
def verifier(test_settings: Settings, jwks_server) -> SupabaseJWKSVerifier:
    """A verifier pointed at the JWKS stub, with a fresh cache per test."""
    return SupabaseJWKSVerifier(test_settings, transport=httpx.MockTransport(jwks_server.handler))


@pytest.fixture
async def client(
    session: AsyncSession,
    test_settings: Settings,
    verifier: SupabaseJWKSVerifier,
) -> AsyncGenerator[httpx.AsyncClient, None]:
    """An HTTP client bound to the app, sharing the test's transaction.

    Settings, the verifier and the database session are all FastAPI dependencies
    precisely so they can be swapped here rather than monkeypatched into place.
    """

    async def override_session() -> AsyncGenerator[AsyncSession, None]:
        yield session

    fastapi_app.dependency_overrides[get_session] = override_session
    fastapi_app.dependency_overrides[get_settings] = lambda: test_settings
    fastapi_app.dependency_overrides[get_verifier] = lambda: verifier

    transport = httpx.ASGITransport(app=fastapi_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as http_client:
        yield http_client
    fastapi_app.dependency_overrides.clear()


@pytest.fixture
async def signed_in(client: httpx.AsyncClient, make_token):
    """Provision a teacher and return their auth headers.

    Takes an email so a test can sign in a second teacher at the same centre.
    """

    async def _sign_in(email: str = "ken@example.com", **token_kwargs) -> dict[str, str]:
        token = make_token(email=email, **token_kwargs)
        response = await client.post(
            "/auth/teacher/session", headers={"Authorization": f"Bearer {token}"}
        )
        assert response.status_code == 200, response.text
        return {"Authorization": f"Bearer {token}"}

    return _sign_in


@pytest.fixture
async def foreign_centre(session: AsyncSession) -> dict:
    """Another centre with a class, a student and an enrolment in it, inserted directly.

    There is no way to reach this through the API — one deployment has one centre — which
    is the point: it exists so the tenancy tests have something to fail to reach. The
    student is here because a leak of a child's record is the failure that matters most.
    """
    centre = Centre(name="Magikid Parramatta", slug="parramatta")
    session.add(centre)
    await session.flush()

    klass = Class(centre_id=centre.id, name="Someone else's class", term_label="2026 T4")
    student = Student(
        centre_id=centre.id, display_name="Someone else's child", username="someone.else"
    )
    session.add_all([klass, student])
    await session.flush()

    enrolment = Enrolment(class_id=klass.id, student_id=student.id)
    session.add(enrolment)
    await session.flush()
    return {"centre": centre, "class": klass, "student": student, "enrolment": enrolment}


@pytest.fixture
async def student_on_roster(client: httpx.AsyncClient, signed_in):
    """A class with one child's account in it — their username and PIN.

    Built the way a teacher would build it (Ken's decision, 11 Oct 2026): create the
    class, then Add student with a name, which suggests the username and draws the PIN.
    """

    async def _build(display_name: str = "Aria K", class_name: str = "Year 4-6 Python") -> dict:
        headers = await signed_in()
        created = (await client.post("/classes", json={"name": class_name}, headers=headers)).json()
        slip = await client.post(
            f"/classes/{created['id']}/students",
            json={"display_name": display_name},
            headers=headers,
        )
        assert slip.status_code == 201, slip.text
        return {
            "headers": headers,
            "class_id": created["id"],
            "code": created["join_code"],
            "student_id": slip.json()["student_id"],
            "display_name": display_name,
            "username": slip.json()["username"],
            "pin": slip.json()["pin"],
        }

    return _build


@pytest.fixture
async def signed_in_student(client: httpx.AsyncClient, student_on_roster):
    """Sign a student in with their username and PIN; leave the cookie on the client."""

    async def _sign_in(display_name: str = "Aria K") -> dict:
        roster = await student_on_roster(display_name)
        response = await client.post(
            "/auth/student/session",
            json={"username": roster["username"], "pin": roster["pin"]},
        )
        assert response.status_code == 200, response.text
        return roster

    return _sign_in


@pytest.fixture(autouse=True)
def fresh_pin_limits():
    """The per-device limit on wrong PINs is in memory; each test starts clean."""
    pin_failures.reset()
    yield
    pin_failures.reset()
