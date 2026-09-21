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

    supabase_url: str = ""
    supabase_jwt_audience: str = "authenticated"

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
