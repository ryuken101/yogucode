"""Application settings. See .env.example for the documented set."""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+asyncpg://localhost/coding_tool_dev"
    test_database_url: str = "postgresql+asyncpg://localhost/coding_tool_test"

    # Teacher sign-in gate. Checked before a users row is created, so an address that
    # is not listed never provisions a centre.
    teacher_email_allowlist: str = ""

    # Student sessions on shared centre laptops: survives a browser restart mid-lesson,
    # does not outlive the day, and logs itself out if the laptop is abandoned.
    student_session_hours: int = 12
    student_session_idle_minutes: int = 90

    pin_max_failed_attempts: int = 5
    pin_lockout_minutes: int = 15

    # The student session cookie's Secure flag. True everywhere real; false only for
    # local http development and tests, where a browser (and httpx) will silently refuse
    # to store a Secure cookie served over plain http — a failure that looks like a
    # session bug and is not one.
    cookie_secure: bool = True

    # The single centre every allowlisted teacher joins. The first teacher to sign in
    # creates it; everyone after joins it. One academy, one tenant — a second centre
    # means a second deployment or a real invite flow, not a second teacher signing in.
    centre_slug: str = "castle-hill"
    centre_name: str = "Magikid Castle Hill"

    supabase_url: str = ""
    # Supabase issues aud="authenticated" for signed-in users and aud="anon" for
    # anonymous ones, so pinning this also rejects anonymous sessions.
    supabase_jwt_audience: str = "authenticated"

    # Supabase's edge caches the JWKS for 10 minutes, so a shorter TTL buys nothing.
    jwks_cache_ttl_seconds: int = 600
    # A token bearing an unknown kid triggers a refresh, which is how key rotation is
    # picked up without a redeploy. Rate-limited so forged kids cannot be used to
    # hammer the JWKS endpoint.
    jwks_min_refresh_interval_seconds: int = 60
    jwks_request_timeout_seconds: float = 5.0

    @property
    def supabase_issuer(self) -> str:
        """The `iss` claim Supabase puts in an access token."""
        return f"{self.supabase_url.rstrip('/')}/auth/v1"

    @property
    def supabase_jwks_url(self) -> str:
        return f"{self.supabase_issuer}/.well-known/jwks.json"

    @property
    def allowed_teacher_emails(self) -> list[str]:
        """Allowlist entries, lowercased. An entry is a full address or an @domain."""
        return [e.strip().lower() for e in self.teacher_email_allowlist.split(",") if e.strip()]

    def is_teacher_email_allowed(self, email: str) -> bool:
        candidate = email.strip().lower()
        domain = candidate.partition("@")[2]
        return any(
            candidate == entry or (entry.startswith("@") and domain == entry[1:])
            for entry in self.allowed_teacher_emails
        )


@lru_cache
def get_settings() -> Settings:
    return Settings()
