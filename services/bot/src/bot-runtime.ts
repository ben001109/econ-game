import { Client, Collection, Events, GatewayIntentBits } from 'discord.js';

import { commands } from './commands/index.js';
import { env } from './env.js';
import { loadLocale } from './i18n.js';
import { logger } from './logger.js';
import { startConnectedBot } from './startup-policy.js';

export { BotStartupError } from './startup-policy.js';

export type BotRuntimeErrorHandler = (error: unknown, event: string) => void;

export type StartBotOptions = Readonly<{
  client?: Client;
  token?: string;
  guildId?: string;
  onError?: BotRuntimeErrorHandler;
}>;

/** Normal startup registers commands and remains connected; cleanup is not a startup action. */
export async function startBot(options: StartBotOptions = {}): Promise<Client> {
  const token = options.token ?? env.DISCORD_BOT_TOKEN;
  const client = options.client ?? new Client({ intents: [GatewayIntentBits.Guilds] });
  return startConnectedBot(client, token, (connectedClient) =>
    installHandlers(
      connectedClient,
      options.guildId ?? env.GUILD_ID,
      options.onError ?? logRuntimeError,
    ),
  );
}

function installHandlers(client: Client, guildId: string, onError: BotRuntimeErrorHandler): void {
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
      onError(error, 'register-commands');
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
      onError(error, `command:${interaction.commandName}`);
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

  client.on(Events.Error, (error) => onError(error, 'client-error'));
}

function logRuntimeError(error: unknown, event: string): void {
  logger.error({ error }, `Discord bot ${event} failed`);
}
