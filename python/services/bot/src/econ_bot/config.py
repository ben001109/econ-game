from functools import lru_cache
from typing import Optional

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    discord_bot_token: str = Field(alias="DISCORD_BOT_TOKEN")
    api_base_url: str = Field(default="http://localhost:4000", alias="API_BASE_URL")
    guild_id: Optional[int] = Field(default=None, alias="GUILD_ID")


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
