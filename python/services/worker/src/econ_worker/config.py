from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    database_url: str = Field(
        default="postgresql+asyncpg://game:gamepass@localhost:5432/game",
        alias="DATABASE_URL",
    )
    redis_url: str = Field(default="redis://localhost:6379/0", alias="REDIS_URL")
    tick_interval_seconds: float = Field(default=10, alias="TICK_INTERVAL_SECONDS")


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
