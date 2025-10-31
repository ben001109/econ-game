import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';

import { env } from '../env.js';

async function parseJsonSafe(res: Response) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function normalizeKey(source: string) {
  return source.toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

function localizeOrFallback(
  translate: (key: string, vars?: Record<string, string | number>) => string,
  key: string,
  fallback: string
) {
  const value = translate(key);
  return value === key ? fallback : value;
}

export const data = new SlashCommandBuilder()
  .setName('pos')
  .setDescription('Front-of-house order management')
  .addSubcommand((sub) =>
    sub
      .setName('open')
      .setDescription('Open a new order')
      .addStringOption((opt) =>
        opt.setName('branch-id').setDescription('Branch ID').setRequired(true)
      )
      .addStringOption((opt) =>
        opt.setName('table-id').setDescription('Table ID (optional)')
      )
      .addStringOption((opt) =>
        opt
          .setName('type')
          .setDescription('Order type')
          .addChoices(
            { name: 'Dine-in', value: 'dine-in' },
            { name: 'Takeout', value: 'takeout' },
            { name: 'Delivery', value: 'delivery' }
          )
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('add-item')
      .setDescription('Add a menu item to an order')
      .addStringOption((opt) =>
        opt.setName('order-id').setDescription('Order ID').setRequired(true)
      )
      .addStringOption((opt) =>
        opt
          .setName('menu-item-id')
          .setDescription('Menu item ID')
          .setRequired(true)
      )
      .addIntegerOption((opt) =>
        opt
          .setName('quantity')
          .setDescription('Quantity (default: 1)')
          .setMinValue(1)
      )
      .addNumberOption((opt) =>
        opt
          .setName('price-override')
          .setDescription('Override price amount')
          .setMinValue(0.01)
      )
      .addStringOption((opt) =>
        opt.setName('notes').setDescription('Special instructions')
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('close')
      .setDescription('Take payment and optionally close an order')
      .addStringOption((opt) =>
        opt.setName('order-id').setDescription('Order ID').setRequired(true)
      )
      .addStringOption((opt) =>
        opt
          .setName('method')
          .setDescription('Payment method')
          .setRequired(true)
          .addChoices(
            { name: 'Cash', value: 'cash' },
            { name: 'Card', value: 'card' }
          )
      )
      .addNumberOption((opt) =>
        opt
          .setName('amount')
          .setDescription('Payment amount')
          .setMinValue(0.01)
          .setRequired(true)
      )
      .addNumberOption((opt) =>
        opt
          .setName('tip')
          .setDescription('Tip amount')
          .setMinValue(0)
      )
      .addBooleanOption((opt) =>
        opt
          .setName('keep-open')
          .setDescription('Keep the order open after payment (default closes)')
      )
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
  t: (key: string, vars?: Record<string, string | number>) => string
) {
  const sub = interaction.options.getSubcommand();
  await interaction.deferReply({ ephemeral: true });

  try {
    if (sub === 'open') {
      const branchId = interaction.options.getString('branch-id', true);
      const tableId = interaction.options.getString('table-id');
      const type = interaction.options.getString('type') || undefined;
      const res = await fetch(`${env.API_BASE_URL}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          branchId,
          ...(tableId ? { tableId } : {}),
          ...(type ? { type } : {}),
        }),
      });
      const body = await parseJsonSafe(res);
      if (res.ok && body && typeof body === 'object') {
        const order = body as { id?: string; status?: string; tableId?: string | null };
        const statusRaw = (order.status ?? 'OPEN').toString();
        const statusKey = `pos_status_${normalizeKey(statusRaw)}`;
        const statusLabel = localizeOrFallback(t, statusKey, statusRaw);
        await interaction.editReply(
          t('pos_open_success', {
            orderId: order.id ?? 'unknown',
            status: statusLabel,
          })
        );
        return;
      }
      const errorMsg =
        (body as { message?: string; code?: string } | null)?.message ||
        (body as { message?: string; code?: string } | null)?.code;
      await interaction.editReply(`${t('pos_open_failed')} ${errorMsg ? `(${errorMsg})` : ''}`.trim());
      return;
    }

    if (sub === 'add-item') {
      const orderId = interaction.options.getString('order-id', true);
      const menuItemId = interaction.options.getString('menu-item-id', true);
      const qty = interaction.options.getInteger('quantity') ?? undefined;
      const priceOverride = interaction.options.getNumber('price-override') ?? undefined;
      const notes = interaction.options.getString('notes') ?? undefined;
      const res = await fetch(`${env.API_BASE_URL}/orders/${orderId}/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          menuItemId,
          ...(qty ? { qty } : {}),
          ...(priceOverride ? { priceOverride } : {}),
          ...(notes ? { notes } : {}),
        }),
      });
      const body = await parseJsonSafe(res);
      if (res.ok && body && typeof body === 'object') {
        const item = body as { id?: string; qty?: number };
        await interaction.editReply(
          t('pos_add_item_success', {
            itemId: item.id ?? 'unknown',
            qty: (item.qty ?? qty ?? 1).toString(),
          })
        );
        return;
      }
      const errorMsg =
        (body as { message?: string; code?: string } | null)?.message ||
        (body as { message?: string; code?: string } | null)?.code;
      await interaction.editReply(`${t('pos_add_item_failed')} ${errorMsg ? `(${errorMsg})` : ''}`.trim());
      return;
    }

    if (sub === 'close') {
      const orderId = interaction.options.getString('order-id', true);
      const method = interaction.options.getString('method', true) as 'cash' | 'card';
      const amount = interaction.options.getNumber('amount', true);
      const tip =
        interaction.options.getNumber('tip') !== null
          ? interaction.options.getNumber('tip') ?? undefined
          : undefined;
      const keepOpen = interaction.options.getBoolean('keep-open') ?? false;
      const res = await fetch(`${env.API_BASE_URL}/orders/${orderId}/payments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method,
          amount,
          ...(typeof tip === 'number' ? { tip } : {}),
          close: !keepOpen,
        }),
      });
      const body = await parseJsonSafe(res);
      if (res.ok && body && typeof body === 'object') {
        const methodLabel = localizeOrFallback(t, `pos_method_${method}`, method);
        const closedLabel = localizeOrFallback(t, `common_${!keepOpen ? 'yes' : 'no'}`, (!keepOpen).toString());
        await interaction.editReply(
          t('pos_close_success', {
            orderId,
            amount: amount.toFixed(2),
            method: methodLabel,
            closed: closedLabel,
          })
        );
        return;
      }
      const errorMsg =
        (body as { message?: string; code?: string } | null)?.message ||
        (body as { message?: string; code?: string } | null)?.code;
      await interaction.editReply(`${t('pos_close_failed')} ${errorMsg ? `(${errorMsg})` : ''}`.trim());
      return;
    }

    await interaction.editReply(t('unknown_subcommand'));
  } catch (err) {
    await interaction.editReply(t('error_execute'));
  }
}
