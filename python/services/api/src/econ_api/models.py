from datetime import datetime
from typing import Optional
from uuid import UUID, uuid4

from sqlmodel import Field, SQLModel


class Player(SQLModel, table=True):
    __tablename__ = "players"

    id: UUID = Field(default_factory=uuid4, primary_key=True, nullable=False)
    username: str = Field(index=True, unique=True, nullable=False, max_length=64)
    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)


class PlayerCreate(SQLModel):
    username: str


class PlayerRead(SQLModel):
    id: UUID
    username: str
    created_at: datetime


class HealthResponse(SQLModel):
    status: str
    postgres: Optional[str] = None
    redis: Optional[str] = None
