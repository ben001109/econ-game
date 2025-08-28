import 'dotenv/config';

export const env = {
  DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN || '',
  GUILD_ID: process.env.GUILD_ID || '',
  API_BASE_URL: process.env.API_BASE_URL || 'http://localhost:4000',
};

if (!env.DISCORD_BOT_TOKEN) {
  // eslint-disable-next-line no-console
  console.error('[env] DISCORD_BOT_TOKEN not set.');
}

