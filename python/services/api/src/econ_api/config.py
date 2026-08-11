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
    port: int = Field(default=4000, alias="PORT")
    log_level: str = Field(default="info", alias="LOG_LEVEL")


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
