from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    api_base_url: str = Field(default="http://localhost:4000", alias="API_BASE_URL")
    port: int = Field(default=3000, alias="PORT")


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
