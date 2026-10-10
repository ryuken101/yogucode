"""SQLModel tables.

Importing this package registers every table on SQLModel.metadata, which is what
Alembic's env.py autogenerates against. A table that is not imported here is invisible
to migrations.
"""

from app.models.assignments import (
    Assignment,
    AssignmentMode,
    AssignmentStatus,
    Attempt,
    AttemptStatus,
    ProblemSet,
    SetItem,
    SetStatus,
)
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
from app.models.curriculum import Course, CurriculumStatus, Lesson, LessonConcept, Unit
from app.models.documents import DocumentStatus, StudentDocument
from app.models.events import Event, EventType
from app.models.folders import StudentFolder, TeacherFolder
from app.models.marking import (
    AssignmentNote,
    FeedbackSnippet,
    Mark,
    SnippetStatus,
    Submission,
    SubmissionSource,
)
from app.models.problems import Hint, Item, ItemConcept, ItemKind, ItemStatus, TestCase, TestKind
from app.models.students import (
    Student,
    StudentCredential,
    StudentSession,
    StudentStatus,
)
from app.models.teacher_documents import TeacherDocument
from app.models.teacher_invites import InviteStatus, TeacherInvite
from app.models.users import User, UserRole, UserStatus

__all__ = [
    "ActorType",
    "Assignment",
    "AssignmentMode",
    "AssignmentNote",
    "AssignmentStatus",
    "Attempt",
    "AttemptStatus",
    "AuditLog",
    "Centre",
    "Class",
    "ClassJoinCode",
    "ClassStatus",
    "ClassTeacher",
    "ClassTeacherRole",
    "Concept",
    "ConceptStatus",
    "Course",
    "CurriculumStatus",
    "DocumentStatus",
    "Enrolment",
    "EnrolmentStatus",
    "FeedbackSnippet",
    "Event",
    "EventType",
    "Hint",
    "Item",
    "ItemConcept",
    "ItemKind",
    "InviteStatus",
    "ItemStatus",
    "Lesson",
    "LessonConcept",
    "Mark",
    "ProblemSet",
    "SetItem",
    "SetStatus",
    "SnippetStatus",
    "Student",
    "StudentDocument",
    "StudentFolder",
    "StudentCredential",
    "StudentSession",
    "StudentStatus",
    "Submission",
    "SubmissionSource",
    "TeacherDocument",
    "TeacherFolder",
    "TeacherInvite",
    "TestCase",
    "TestKind",
    "TimestampMixin",
    "Unit",
    "User",
    "UserRole",
    "UserStatus",
    "new_uuid",
    "utcnow",
]
