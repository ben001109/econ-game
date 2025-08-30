import { SlashCommandBuilder, ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { env } from '../env.js';

export const data = new SlashCommandBuilder().setName('init').setDescription('Initialize demo restaurant data');

export async function execute(
  interaction: ChatInputCommandInteraction,
  t: (k: string) => string
) {
  try {
    const res = await fetch(`${env.API_BASE_URL}/bootstrap`, { method: 'POST' });
    if (res.ok) {
      await interaction.reply(t('init_success'));
    } else {
      // Try to parse error code/message if any
      let msg = t('init_failed');
      try {
        const body = (await res.json()) as { code?: string; message?: string };
        if (body?.code) msg = `${msg} (${body.code})`;
      } catch {
        // ignore parse error
      }
      await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
    }
  } catch (err) {
    await interaction.reply({ content: t('error_execute'), flags: MessageFlags.Ephemeral });
  }
}
