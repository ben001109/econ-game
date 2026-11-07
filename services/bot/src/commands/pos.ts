import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';

import { productionBotCommandRuntime } from '../bot-command-runtime.js';
import { BotCommandError, type D02CommandValue } from '../d02-game-command-client.js';

export const data = new SlashCommandBuilder()
  .setName('pos')
  .setDescription('Front-of-house order management')
  .addSubcommand((sub) =>
    sub
      .setName('open')
      .setDescription('Open a new order')
      .addStringOption((opt) =>
        opt.setName('branch-id').setDescription('Branch ID').setRequired(true),
      )
      .addStringOption((opt) => opt.setName('table-id').setDescription('Table ID (optional)'))
      .addStringOption((opt) =>
        opt
          .setName('type')
          .setDescription('Order type')
          .addChoices(
            { name: 'Dine-in', value: 'dine-in' },
            { name: 'Takeout', value: 'takeout' },
            { name: 'Delivery', value: 'delivery' },
          ),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('add-item')
      .setDescription('Add a menu item to an order')
      .addStringOption((opt) =>
        opt.setName('order-id').setDescription('Order ID').setRequired(true),
      )
      .addStringOption((opt) =>
        opt.setName('menu-item-id').setDescription('Menu item ID').setRequired(true),
      )
      .addIntegerOption((opt) =>
        opt.setName('quantity').setDescription('Quantity (default: 1)').setMinValue(1),
      )
      .addStringOption((opt) => opt.setName('notes').setDescription('Special instructions')),
  )
  .addSubcommand((sub) =>
    sub
      .setName('close')
      .setDescription('Take payment and optionally close an order')
      .addStringOption((opt) =>
        opt.setName('order-id').setDescription('Order ID').setRequired(true),
      )
      .addStringOption((opt) =>
        opt
          .setName('method')
          .setDescription('Payment method')
          .setRequired(true)
          .addChoices({ name: 'Cash', value: 'cash' }, { name: 'Card', value: 'card' }),
      )
      .addNumberOption((opt) =>
        opt.setName('amount').setDescription('Payment amount').setMinValue(0.01).setRequired(true),
      )
      .addNumberOption((opt) => opt.setName('tip').setDescription('Tip amount').setMinValue(0))
      .addBooleanOption((opt) =>
        opt
          .setName('keep-open')
          .setDescription('Keep the order open after payment (default closes)'),
      ),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
  t: (key: string, vars?: Record<string, string | number>) => string,
) {
  const sub = interaction.options.getSubcommand();
  await interaction.deferReply({ ephemeral: true });

  if (sub === 'open') {
    await executeOperation(
      interaction,
      t,
      'pos.open',
      {
        branchId: interaction.options.getString('branch-id', true),
        ...(optionalString(interaction, 'table-id')
          ? { tableId: optionalString(interaction, 'table-id')! }
          : {}),
        ...(optionalString(interaction, 'type')
          ? { type: optionalString(interaction, 'type')! }
          : {}),
      },
      'pos_open_success',
    );
    return;
  }

  if (sub === 'add-item') {
    const quantity = interaction.options.getInteger('quantity');
    const notes = interaction.options.getString('notes');
    await executeOperation(
      interaction,
      t,
      'pos.add-item',
      {
        orderId: interaction.options.getString('order-id', true),
        menuItemId: interaction.options.getString('menu-item-id', true),
        ...(quantity === null ? {} : { quantity }),
        ...(notes ? { notes } : {}),
      },
      'pos_add_item_success',
    );
    return;
  }

  if (sub === 'close') {
    const tip = interaction.options.getNumber('tip');
    await executeOperation(
      interaction,
      t,
      'pos.close',
      {
        orderId: interaction.options.getString('order-id', true),
        method: interaction.options.getString('method', true),
        amount: interaction.options.getNumber('amount', true),
        ...(tip === null ? {} : { tip }),
        close: !(interaction.options.getBoolean('keep-open') ?? false),
      },
      'pos_close_success',
    );
    return;
  }

  await interaction.editReply(t('unknown_subcommand'));
}

async function executeOperation(
  interaction: ChatInputCommandInteraction,
  t: (key: string, vars?: Record<string, string | number>) => string,
  operation: string,
  payload: Readonly<Record<string, D02CommandValue>>,
  successKey: string,
): Promise<void> {
  try {
    const result = await productionBotCommandRuntime.execute(operation, {
      discordUserId: interaction.user.id,
      interactionId: interaction.id,
      payload,
    });
    await interaction.editReply(t(successKey, { commandId: result.commandId }));
  } catch (error) {
    const code = error instanceof BotCommandError ? error.code : 'BOT_COMMAND_FAILED';
    await interaction.editReply(`${t('error_execute')} (${code})`);
  }
}

function optionalString(
  interaction: ChatInputCommandInteraction,
  name: string,
): string | undefined {
  return interaction.options.getString(name) ?? undefined;
}
