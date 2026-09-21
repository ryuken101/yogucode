"""Authentication and the authorisation seam."""

from app.auth.principal import (
    CurrentPrincipal,
    CurrentTeacher,
    Principal,
    get_current_principal,
    require_teacher,
)

__all__ = [
    "CurrentPrincipal",
    "CurrentTeacher",
    "Principal",
    "get_current_principal",
    "require_teacher",
]
