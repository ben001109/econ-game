import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';

import { env } from '../env.js';

async function parseJsonSafe(res: Response) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export const data = new SlashCommandBuilder()
  .setName('ops')
  .setDescription('Operations utilities')
  .addSubcommand((sub) =>
    sub.setName('bootstrap').setDescription('Initialize demo restaurant data')
  )
  .addSubcommand((sub) =>
    sub.setName('health').setDescription('Check API health endpoint')
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
  t: (key: string, vars?: Record<string, string | number>) => string
) {
  const sub = interaction.options.getSubcommand();
  await interaction.deferReply({ ephemeral: true });

  try {
    if (sub === 'bootstrap') {
      const res = await fetch(`${env.API_BASE_URL}/bootstrap`, { method: 'POST' });
      if (res.ok) {
        await interaction.editReply(t('ops_bootstrap_success'));
        return;
      }
      const body = (await parseJsonSafe(res)) as { code?: string; message?: string } | null;
      const errorMsg = body?.message || body?.code;
      await interaction.editReply(`${t('ops_bootstrap_failed')} ${errorMsg ? `(${errorMsg})` : ''}`.trim());
      return;
    }

    if (sub === 'health') {
      const res = await fetch(`${env.API_BASE_URL}/health`);
      if (!res.ok) {
        await interaction.editReply(t('ops_health_failed'));
        return;
      }
      const body = (await parseJsonSafe(res)) as { status?: string } | null;
      const status = body?.status || 'unknown';
      await interaction.editReply(t('ops_health_success', { status }));
      return;
    }

    await interaction.editReply(t('unknown_subcommand'));
  } catch (err) {
    await interaction.editReply(t('error_execute'));
  }
}
