"""FastAPI entrypoint for the Econ Game Python API."""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from redis.asyncio import Redis

from .config import get_settings
from .db import init_db
from .routes import router

settings = get_settings()
logger = logging.getLogger("econ_api")
logging.basicConfig(level=getattr(logging, settings.log_level.upper(), logging.INFO))


@asynccontextmanager
async def lifespan(app: FastAPI):
    redis = Redis.from_url(settings.redis_url, encoding="utf-8", decode_responses=True)
    app.state.redis = redis

    await init_db()
    logger.info("Database schema ensured and Redis connected")

    try:
        yield
    finally:
        await redis.close()
        await redis.connection_pool.disconnect()
        logger.info("Redis connection closed")


def create_app() -> FastAPI:
    app = FastAPI(title="Econ Game API (Python)", version="0.1.0", lifespan=lifespan)
    app.include_router(router)
    return app


app = create_app()


if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    uvicorn.run("econ_api.main:app", host="0.0.0.0", port=settings.port, reload=True)
