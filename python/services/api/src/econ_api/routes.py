from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .db import get_session
from .models import HealthResponse, Player, PlayerCreate, PlayerRead

router = APIRouter()


@router.get("/health", response_model=HealthResponse)
async def health_check(request: Request, session: AsyncSession = Depends(get_session)) -> HealthResponse:
    health = HealthResponse(status="ok")

    try:
        await session.execute(text("SELECT 1"))
        health.postgres = "ok"
    except Exception as exc:  # pragma: no cover - defensive logging hook
        health.status = "degraded"
        health.postgres = f"error: {exc}"

    redis = request.app.state.redis
    try:
        await redis.ping()
        health.redis = "ok"
    except Exception as exc:  # pragma: no cover - defensive logging hook
        health.status = "degraded"
        health.redis = f"error: {exc}"

    return health


@router.post("/players", response_model=PlayerRead, status_code=status.HTTP_201_CREATED)
async def create_player(payload: PlayerCreate, session: AsyncSession = Depends(get_session)) -> PlayerRead:
    player = Player(username=payload.username)
    session.add(player)

    try:
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Username already exists") from exc

    await session.refresh(player)
    return PlayerRead.model_validate(player)


@router.get("/players/{player_id}", response_model=PlayerRead)
async def get_player(player_id: UUID, session: AsyncSession = Depends(get_session)) -> PlayerRead:
    result = await session.execute(select(Player).where(Player.id == player_id))
    player = result.scalar_one_or_none()

    if player is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Player not found")

    return PlayerRead.model_validate(player)
