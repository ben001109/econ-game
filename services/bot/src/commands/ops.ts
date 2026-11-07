import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';

import { env } from '../env.js';

export const data = new SlashCommandBuilder()
  .setName('ops')
  .setDescription('Operations utilities')
  .addSubcommand((sub) => sub.setName('health').setDescription('Check API health endpoint'));

export async function execute(
  interaction: ChatInputCommandInteraction,
  t: (key: string, vars?: Record<string, string | number>) => string,
) {
  await interaction.deferReply({ ephemeral: true });
  if (interaction.options.getSubcommand() !== 'health') {
    await interaction.editReply(t('unknown_subcommand'));
    return;
  }
  if (!env.API_BASE_URL) {
    await interaction.editReply(`${t('ops_health_failed')} (API_BASE_URL_NOT_CONFIGURED)`);
    return;
  }

  try {
    const response = await fetch(`${env.API_BASE_URL.replace(/\/+$/, '')}/health`);
    if (!response.ok) {
      await interaction.editReply(t('ops_health_failed'));
      return;
    }
    const body = (await response.json()) as { status?: unknown };
    const status = typeof body.status === 'string' ? body.status : 'unknown';
    await interaction.editReply(t('ops_health_success', { status }));
  } catch {
    await interaction.editReply(t('ops_health_failed'));
  }
}
