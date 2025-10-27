import 'dotenv/config';

export const env = {
  DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN || '',
  GUILD_ID: process.env.GUILD_ID || '',
  API_BASE_URL: process.env.API_BASE_URL || 'http://localhost:4000',
  NEW_RELIC_APP_NAME: process.env.NEW_RELIC_APP_NAME || process.env.RELIC_APP_NAME || 'econ-game-bot',
  NEW_RELIC_LICENSE_KEY: process.env.NEW_RELIC_LICENSE_KEY || process.env.RELIC_API_KEY || '',
};

if (!env.DISCORD_BOT_TOKEN) {
  // eslint-disable-next-line no-console
  console.error('[env] DISCORD_BOT_TOKEN not set.');
}
