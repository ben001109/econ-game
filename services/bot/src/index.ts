import 'dotenv/config';
import pino from 'pino';
import { Client, Collection, Events, GatewayIntentBits } from 'discord.js';

import { commands } from './commands/index.js';
import { env } from './env.js';
import { loadLocale } from './i18n.js';

const logger = pino({ name: 'econ-bot' });

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const registry = new Collection<string, (typeof commands)[number]>();
for (const c of commands) {
  registry.set(c.data.name, c);
}

client.once(Events.ClientReady, async (c) => {
  logger.info(`Logged in as ${c.user.tag}`);
  try {
    if (env.GUILD_ID) {
      const guild = await client.guilds.fetch(env.GUILD_ID);
      await guild.commands.set(commands.map((c) => c.data.toJSON()));
      logger.info({ guild: env.GUILD_ID }, 'Slash commands registered to guild');
    } else if (client.application) {
      await client.application.commands.set(commands.map((c) => c.data.toJSON()));
      logger.info('Slash commands registered globally');
    }
  } catch (err) {
    logger.error({ err }, 'Failed to register commands');
  }
  if (process.env.CI) {
    logger.info('CI environment detected, shutting down.');
    await client.destroy();
    process.exit(0);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const command = registry.get(interaction.commandName);
  if (!command) return;
  const t = loadLocale(interaction.locale);
  try {
    await command.execute(interaction, t);
  } catch (err) {
    logger.error({ err }, 'Command execute failed');
    try {
      await interaction.reply({ content: t('error_execute'), ephemeral: true });
    } catch {
      // ignore follow-up errors
    }
  }
});

if (!env.DISCORD_BOT_TOKEN) {
  logger.error('DISCORD_BOT_TOKEN not provided.');
  process.exit(1);
}

client.login(env.DISCORD_BOT_TOKEN);

