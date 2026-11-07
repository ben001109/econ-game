import { pathToFileURL } from 'node:url';

import { Client, Collection, Events, GatewayIntentBits } from 'discord.js';

import { commands } from './commands/index.js';
import { env } from './env.js';
import { loadLocale } from './i18n.js';
import { monitoring, registerProcessLogging, Sentry } from './instrumentation.js';
import { logger } from './logger.js';

export class BotStartupError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'BotStartupError';
    this.code = code;
  }
}

export type StartBotOptions = Readonly<{
  client?: Client;
  token?: string;
  guildId?: string;
  registerLogging?: boolean;
}>;

/** Normal startup registers commands and remains connected; cleanup is not a startup action. */
export async function startBot(options: StartBotOptions = {}): Promise<Client> {
  const token = options.token ?? env.DISCORD_BOT_TOKEN;
  if (!token.trim()) throw new BotStartupError('DISCORD_BOT_TOKEN_NOT_CONFIGURED');

  if (options.registerLogging !== false) registerProcessLogging(logger);
  const client = options.client ?? new Client({ intents: [GatewayIntentBits.Guilds] });
  installHandlers(client, options.guildId ?? env.GUILD_ID);
  await client.login(token);
  return client;
}

function installHandlers(client: Client, guildId: string): void {
  const registry = new Collection<string, (typeof commands)[number]>();
  for (const command of commands) registry.set(command.data.name, command);

  client.once(Events.ClientReady, async (readyClient) => {
    logger.info(`Logged in as ${readyClient.user.tag}`);
    try {
      const definitions = commands.map((command) => command.data.toJSON());
      if (guildId) {
        const guild = await readyClient.guilds.fetch(guildId);
        await guild.commands.set(definitions);
        logger.info({ guild: guildId }, 'Slash commands registered to guild');
      } else if (readyClient.application) {
        await readyClient.application.commands.set(definitions);
        logger.info('Slash commands registered globally');
      }
    } catch (error) {
      captureBotError(error, 'register-commands');
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const command = registry.get(interaction.commandName);
    if (!command) return;
    const translate = loadLocale(interaction.locale);
    try {
      await command.execute(interaction, translate);
    } catch (error) {
      logger.error({ error }, 'Command execute failed');
      if (monitoring.sentry) {
        Sentry.withScope((scope) => {
          scope.setTag('service', 'bot');
          scope.setTag('command', interaction.commandName);
          scope.setUser({ id: interaction.user.id, username: interaction.user.tag });
          Sentry.captureException(error as Error);
        });
      }
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply(translate('error_execute'));
        } else {
          await interaction.reply({ content: translate('error_execute'), ephemeral: true });
        }
      } catch {
        // Discord may reject a second response after the interaction window closes.
      }
    }
  });

  client.on(Events.Error, (error) => captureBotError(error, 'client-error'));
}

function captureBotError(error: unknown, event: string): void {
  logger.error({ error }, `Discord bot ${event} failed`);
  if (!monitoring.sentry) return;
  Sentry.withScope((scope) => {
    scope.setTag('service', 'bot');
    scope.setTag('event', event);
    Sentry.captureException(error as Error);
  });
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  return Boolean(entrypoint && import.meta.url === pathToFileURL(entrypoint).href);
}

if (isMainModule()) {
  void startBot().catch((error) => {
    captureBotError(error, 'startup');
    process.exitCode = 1;
  });
}
