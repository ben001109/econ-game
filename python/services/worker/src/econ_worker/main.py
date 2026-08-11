"""Entrypoint for the Econ worker."""

import asyncio
import logging

from redis.asyncio import Redis

from .config import get_settings
from .db import SessionLocal, init_db
from .tasks import TickProcessor

settings = get_settings()
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("econ_worker")


async def run() -> None:
    await init_db()
    redis = Redis.from_url(settings.redis_url, encoding="utf-8", decode_responses=True)

    processor = TickProcessor(SessionLocal, redis, settings.tick_interval_seconds)

    try:
        await processor.run_forever()
    finally:
        await redis.close()
        await redis.connection_pool.disconnect()


def main() -> None:
    asyncio.run(run())


if __name__ == "__main__":  # pragma: no cover
    main()
