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

type Ticket = {
  id: string;
  status: string;
  openedAt?: string;
  items?: { qty?: number; menuItem?: { name?: string } }[];
};

export const data = new SlashCommandBuilder()
  .setName('kds')
  .setDescription('Kitchen display actions')
  .addSubcommand((sub) =>
    sub
      .setName('tickets')
      .setDescription('List active tickets')
      .addIntegerOption((opt) =>
        opt
          .setName('limit')
          .setDescription('Maximum number of tickets to show')
          .setMinValue(1)
          .setMaxValue(25)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('start')
      .setDescription('Mark a ticket as in progress')
      .addStringOption((opt) =>
        opt.setName('order-id').setDescription('Order ID').setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('serve')
      .setDescription('Mark a ticket as served')
      .addStringOption((opt) =>
        opt.setName('order-id').setDescription('Order ID').setRequired(true)
      )
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
  t: (key: string, vars?: Record<string, string | number>) => string
) {
  const sub = interaction.options.getSubcommand();
  await interaction.deferReply({ ephemeral: true });

  try {
    if (sub === 'tickets') {
      const limit = interaction.options.getInteger('limit') ?? 5;
      const res = await fetch(`${env.API_BASE_URL}/kds/tickets`);
      const body = await parseJsonSafe(res);
      if (!res.ok || !Array.isArray(body)) {
        await interaction.editReply(t('kds_tickets_failed'));
        return;
      }
      const tickets = body as Ticket[];
      if (!tickets.length) {
        await interaction.editReply(t('kds_tickets_empty'));
        return;
      }
      const entries = tickets.slice(0, limit).map((ticket) => {
        const statusRaw = ticket.status ?? 'OPEN';
        const statusLabel = localizeOrFallback(
          t,
          `kds_status_${normalizeKey(statusRaw)}`,
          statusRaw
        );
        const items = ticket.items
          ?.map((item) => `${item.qty ?? 1}× ${item.menuItem?.name ?? 'Item'}`)
          .join(', ');
        return t('kds_ticket_line', {
          id: ticket.id.slice(0, 6),
          status: statusLabel,
          items: items || t('kds_ticket_line_empty_items'),
        });
      });
      const extra =
        tickets.length > limit
          ? `\n${t('kds_tickets_more', { remaining: tickets.length - limit })}`
          : '';
      await interaction.editReply(
        `${t('kds_tickets_header', { count: tickets.length })}\n${entries.join('\n')}${extra}`
      );
      return;
    }

    if (sub === 'start' || sub === 'serve') {
      const orderId = interaction.options.getString('order-id', true);
      const action = sub === 'start' ? 'start' : 'serve';
      const actionLabel = localizeOrFallback(
        t,
        sub === 'start' ? 'kds_action_label_start' : 'kds_action_label_serve',
        action
      );
      const res = await fetch(`${env.API_BASE_URL}/kds/tickets/${orderId}/${action}`, {
        method: 'POST',
      });
      const body = await parseJsonSafe(res);
      if (res.ok) {
        await interaction.editReply(
          t('kds_action_success', {
            action: actionLabel,
            orderId,
            status: (body as { status?: string } | null)?.status ?? '',
          })
        );
        return;
      }
      const errorMsg =
        (body as { message?: string; code?: string } | null)?.message ||
        (body as { message?: string; code?: string } | null)?.code;
      await interaction.editReply(
        `${t('kds_action_failed', { action: actionLabel })} ${errorMsg ? `(${errorMsg})` : ''}`.trim()
      );
      return;
    }

    await interaction.editReply(t('unknown_subcommand'));
  } catch {
    await interaction.editReply(t('error_execute'));
  }
}
