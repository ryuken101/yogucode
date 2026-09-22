"""Response models shared by more than one router."""

import uuid

from pydantic import BaseModel

from app.models import Centre


class CentreOut(BaseModel):
    id: uuid.UUID
    name: str
    slug: str

    @classmethod
    def build(cls, centre: Centre) -> "CentreOut":
        return cls(id=centre.id, name=centre.name, slug=centre.slug)
