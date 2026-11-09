import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';

import { productionBotCommandRuntime } from '../bot-command-runtime.js';
import { BotCommandError } from '../d02-game-command-client.js';

export const data = new SlashCommandBuilder()
  .setName('kds')
  .setDescription('Kitchen display actions')
  .addSubcommand((sub) => sub.setName('tickets').setDescription('List active tickets'))
  .addSubcommand((sub) =>
    sub
      .setName('start')
      .setDescription('Mark a ticket as in progress')
      .addStringOption((opt) =>
        opt.setName('order-id').setDescription('Order ID').setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('serve')
      .setDescription('Mark a ticket as served')
      .addStringOption((opt) =>
        opt.setName('order-id').setDescription('Order ID').setRequired(true),
      ),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
  t: (key: string, vars?: Record<string, string | number>) => string,
) {
  const sub = interaction.options.getSubcommand();
  await interaction.deferReply({ ephemeral: true });

  if (sub === 'tickets') {
    await interaction.editReply(`${t('kds_tickets_failed')} (D02_READ_MODEL_NOT_CONFIGURED)`);
    return;
  }

  if (sub !== 'start' && sub !== 'serve') {
    await interaction.editReply(t('unknown_subcommand'));
    return;
  }

  try {
    const result = await productionBotCommandRuntime.execute(`kds.${sub}`, {
      discordUserId: interaction.user.id,
      interactionId: interaction.id,
      payload: { orderId: interaction.options.getString('order-id', true) },
    });
    await interaction.editReply(
      t('kds_action_success', {
        action: sub,
        orderId: interaction.options.getString('order-id', true),
        status: result.aggregateVersion.toString(),
      }),
    );
  } catch (error) {
    const code = error instanceof BotCommandError ? error.code : 'BOT_COMMAND_FAILED';
    await interaction.editReply(`${t('kds_action_failed', { action: sub })} (${code})`);
  }
}
