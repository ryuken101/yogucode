"""SQLModel tables.

Importing this package registers every table on SQLModel.metadata, which is what
Alembic's env.py autogenerates against. A table that is not imported here is invisible
to migrations.
"""

from app.models.audit import ActorType, AuditLog
from app.models.base import TimestampMixin, new_uuid, utcnow
from app.models.centres import Centre
from app.models.classes import (
    Class,
    ClassJoinCode,
    ClassStatus,
    ClassTeacher,
    ClassTeacherRole,
    Enrolment,
    EnrolmentStatus,
)
from app.models.concepts import Concept, ConceptStatus
from app.models.students import (
    Student,
    StudentCredential,
    StudentSession,
    StudentStatus,
)
from app.models.users import User, UserRole, UserStatus

__all__ = [
    "ActorType",
    "AuditLog",
    "Centre",
    "Class",
    "ClassJoinCode",
    "ClassStatus",
    "ClassTeacher",
    "ClassTeacherRole",
    "Concept",
    "ConceptStatus",
    "Enrolment",
    "EnrolmentStatus",
    "Student",
    "StudentCredential",
    "StudentSession",
    "StudentStatus",
    "TimestampMixin",
    "User",
    "UserRole",
    "UserStatus",
    "new_uuid",
    "utcnow",
]
