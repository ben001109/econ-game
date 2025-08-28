import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { env } from '../env.js';

export const data = new SlashCommandBuilder().setName('init').setDescription('Initialize your player');

export async function execute(
  interaction: ChatInputCommandInteraction,
  t: (k: string) => string
) {
  try {
    const username = `discord:${interaction.user.id}`;
    const locale = interaction.locale?.toLowerCase().startsWith('zh') ? 'zh' : 'en';
    const res = await fetch(`${env.API_BASE_URL}/players`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, locale }),
    });
    if (res.status === 201) {
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
      await interaction.reply({ content: msg, ephemeral: true });
    }
  } catch (err) {
    await interaction.reply({ content: t('error_execute'), ephemeral: true });
  }
}

