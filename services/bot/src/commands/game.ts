import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';

import { createGameplayApiClient } from '@econ-game/sdk';

import {
  BotGameplayRuntime,
  executeGameplaySlashCommand,
  type CreateBotGameplaySlashRuntime,
} from '../gameplay-runtime.js';
import { env } from '../env.js';

/**
 * The Bot exposes only post-bootstrap gameplay operations. Bootstrap and
 * pre-open configuration intentionally remain Web-only, and no legacy POS,
 * KDS, wipe, or link behaviour is registered here.
 */
export const data = new SlashCommandBuilder()
  .setName('game')
  .setDescription('First-day gameplay')
  .addSubcommand((subcommand) => subcommand.setName('status').setDescription('Show game status'))
  .addSubcommand((subcommand) => subcommand.setName('open').setDescription('Open business day one'))
  .addSubcommand((subcommand) =>
    subcommand
      .setName('advance')
      .setDescription('Advance the current service period')
      .addStringOption((option) =>
        option
          .setName('owner-assignment')
          .setDescription('Your assignment for this period')
          .setRequired(true)
          .addChoices(
            { name: 'Kitchen', value: 'KITCHEN' },
            { name: 'Front', value: 'FRONT' },
            { name: 'None', value: 'NONE' },
          ),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName('settle').setDescription('Settle business day one'),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName('replay').setDescription('Request or show day replay'),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('replay-status')
      .setDescription('Show a replay job')
      .addStringOption((option) =>
        option.setName('job-id').setDescription('Replay job ID').setRequired(true),
      ),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
  _t: (key: string, vars?: Record<string, string | number>) => string,
): Promise<void> {
  await executeGameplaySlashCommand(
    interaction as unknown as Parameters<typeof executeGameplaySlashCommand>[0],
    productionGameplaySlashRuntime,
  );
}

const productionGameplaySlashRuntime: CreateBotGameplaySlashRuntime = () =>
  new BotGameplayRuntime({
    apiBaseUrl: env.API_BASE_URL,
    serviceCredential: env.BOT_SERVICE_CREDENTIAL,
    createClient: createGameplayApiClient,
  });
