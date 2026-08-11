"""Discord bot implementation."""

import logging
from typing import Any

import discord
from discord import app_commands
from discord.ext import commands
import httpx

from .config import Settings

logger = logging.getLogger("econ_bot")


class EconBot(commands.Bot):
    def __init__(self, settings: Settings) -> None:
        intents = discord.Intents.default()
        super().__init__(command_prefix="!", intents=intents)
        self.settings = settings
        self.http_client = httpx.AsyncClient(base_url=settings.api_base_url, timeout=10)

    async def setup_hook(self) -> None:
        self.tree.add_command(ping_command)
        self.tree.add_command(init_command)

        if self.settings.guild_id:
            guild = discord.Object(id=self.settings.guild_id)
            await self.tree.sync(guild=guild)
            logger.info("Synced commands to guild %s", self.settings.guild_id)
        else:
            await self.tree.sync()
            logger.info("Synced global commands")

    async def close(self) -> None:
        await self.http_client.aclose()
        await super().close()


@app_commands.command(name="ping", description="Check whether the bot is alive")
async def ping_command(interaction: discord.Interaction) -> None:
    await interaction.response.send_message("Pong!", ephemeral=True)


@app_commands.command(name="init", description="Create a player in the Econ Game API")
async def init_command(interaction: discord.Interaction) -> None:
    bot = interaction.client
    if not isinstance(bot, EconBot):  # pragma: no cover - safety guard
        await interaction.response.send_message("Bot not ready", ephemeral=True)
        return

    payload = {"username": interaction.user.display_name or interaction.user.name}

    try:
        response = await bot.http_client.post("/players", json=payload)
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        await interaction.response.send_message(
            f"API rejected the request ({exc.response.status_code})", ephemeral=True
        )
        return
    except httpx.HTTPError as exc:  # pragma: no cover - network error
        await interaction.response.send_message(f"API error: {exc}", ephemeral=True)
        return

    data: Any = response.json()
    await interaction.response.send_message(
        f"Player created with id {data.get('id', 'unknown')}", ephemeral=True
    )
