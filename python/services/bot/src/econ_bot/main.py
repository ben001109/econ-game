"""Entry script for the Discord bot."""

import asyncio
import logging

from .client import EconBot
from .config import get_settings

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("econ_bot")


def main() -> None:
    settings = get_settings()
    bot = EconBot(settings)
    logger.info("Launching Discord bot against %s", settings.api_base_url)
    bot.run(settings.discord_bot_token)


if __name__ == "__main__":  # pragma: no cover
    main()
