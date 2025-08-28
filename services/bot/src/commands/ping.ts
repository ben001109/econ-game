import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';

export const data = new SlashCommandBuilder().setName('ping').setDescription('Ping the bot');

export async function execute(interaction: ChatInputCommandInteraction, t: (k: string) => string) {
  await interaction.reply(t('pong'));
}

