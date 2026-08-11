"""Worker loops and jobs."""

import asyncio
import logging
import time
from uuid import UUID

from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from .models import EconomicTick

logger = logging.getLogger("econ_worker")


class TickProcessor:
    """Periodically records a tick and emits an event over Redis."""

    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        redis: Redis,
        interval_seconds: float,
    ) -> None:
        self._session_factory = session_factory
        self._redis = redis
        self._interval = interval_seconds

    async def run_forever(self) -> None:
        logger.info("Starting tick loop with interval=%ss", self._interval)
        while True:
            started = time.perf_counter()
            try:
                tick_id = await self._apply_tick()
                await self._redis.publish("econ:ticks", str(tick_id))
            except Exception as exc:  # pragma: no cover - logged for observability
                logger.exception("Tick failure: %s", exc)
            finally:
                elapsed = time.perf_counter() - started
                await asyncio.sleep(max(self._interval - elapsed, 0))

    async def _apply_tick(self) -> UUID:
        async with self._session_factory() as session:
            tick = EconomicTick()
            session.add(tick)
            await session.commit()
            await session.refresh(tick)
            logger.debug("Recorded tick %s", tick.id)
            return tick.id
