from datetime import datetime
from uuid import UUID, uuid4

from sqlmodel import Field, SQLModel


class EconomicTick(SQLModel, table=True):
    __tablename__ = "economic_ticks"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    started_at: datetime = Field(default_factory=datetime.utcnow)
    completed_at: datetime | None = None
    duration_ms: float | None = None
    notes: str | None = Field(default=None, max_length=255)
