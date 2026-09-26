"""Building audit rows, in one place.

`audit_log` exists to answer one question — *what was done to this child's record, and by
whom* — because teacher actions on children's data are Privacy Act actions and cannot be
reconstructed after the fact. The helper here is thin on purpose; what matters is that
every router builds the row the same way, so the answer does not depend on which route
happened to write it.

**Roster actions key on the student, not on the row they changed.** `enrolment.added` and
`enrolment.withdrawn` carry `target_type="student"` and the child's id as `target_id`,
with `class_id` in the payload. That departs from `class.*`, where `target_type` mirrors
the table — but keying to the child means "everything that ever happened to this student"
is one query on `target_id` rather than a union across target types. The verb is already
unambiguous in `action`, so nothing is lost.
"""

import uuid

from app.auth.principal import Principal
from app.models import ActorType, AuditLog


def audit_entry(
    principal: Principal,
    action: str,
    target_type: str,
    target_id: uuid.UUID,
    **payload: object,
) -> AuditLog:
    """An unsaved `AuditLog` row attributed to the acting principal.

    The caller adds it to the session alongside the change it describes, so the audit row
    and the change commit together or not at all.
    """
    return AuditLog(
        centre_id=principal.centre_id,
        actor_type=ActorType.STUDENT if principal.is_student else ActorType.USER,
        actor_id=principal.subject_id,
        action=action,
        target_type=target_type,
        target_id=target_id,
        payload=dict(payload),
    )
