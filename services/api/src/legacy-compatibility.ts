import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const LegacyPaymentMethod = { CARD: 'CARD', CASH: 'CASH' } as const;
const LegacyOrderStatus = {
  OPEN: 'OPEN',
  IN_PROGRESS: 'IN_PROGRESS',
  SERVED: 'SERVED',
  CLOSED: 'CLOSED',
  CANCELED: 'CANCELED',
} as const;
const LegacyOrderType = {
  DINE_IN: 'DINE_IN',
  TAKEOUT: 'TAKEOUT',
  DELIVERY: 'DELIVERY',
} as const;

type LegacyOrderStatusValue = (typeof LegacyOrderStatus)[keyof typeof LegacyOrderStatus];
type LegacyOrderRecord = Readonly<{
  id: string;
  status: LegacyOrderStatusValue;
  tableId: string | null;
}>;
type LegacyDatabaseRecord = Readonly<Record<string, unknown>>;

type LegacyTransaction = Readonly<{
  branch: Readonly<{ findUnique(input: unknown): Promise<Readonly<{ id: string }> | null> }>;
  table: Readonly<{
    findUnique(input: unknown): Promise<Readonly<{ id: string; branchId: string }> | null>;
    updateMany(input: unknown): Promise<Readonly<{ count: number }>>;
    update(input: unknown): Promise<unknown>;
  }>;
  order: Readonly<{
    create(input: unknown): Promise<unknown>;
    findUnique(input: unknown): Promise<LegacyOrderRecord | null>;
    update(input: unknown): Promise<Readonly<{ id: string; tableId: string | null }>>;
    count(input: unknown): Promise<number>;
  }>;
  payment: Readonly<{ create(input: unknown): Promise<unknown> }>;
  taxLine: Readonly<{ createMany(input: unknown): Promise<unknown> }>;
  tip: Readonly<{ create(input: unknown): Promise<unknown> }>;
}>;

/** Minimal runtime contract for the explicit legacy compatibility adapter. */
export type LegacyCompatibilityDatabase = Readonly<{
  restaurant: Readonly<{ create(input: unknown): Promise<unknown> }>;
  menuItem: Readonly<{
    findUnique(input: unknown): Promise<Readonly<{ basePrice: unknown }> | null>;
  }>;
  orderItem: Readonly<{ create(input: unknown): Promise<unknown> }>;
  order: Readonly<{ update(input: unknown): Promise<unknown> }>;
  $transaction<T>(operation: (transaction: LegacyTransaction) => Promise<T>): Promise<T>;
}>;

class LegacyApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

const isLegacyApiError = (error: unknown): error is LegacyApiError =>
  error instanceof LegacyApiError;

const OrderCreateBody = z.object({
  branchId: z.string().min(1),
  tableId: z.string().min(1).optional(),
  type: z.enum(['dine-in', 'takeout', 'delivery']).optional(),
});

const OrderItemBody = z.object({
  menuItemId: z.string().min(1),
  qty: z.number().int().positive().optional(),
  priceOverride: z.number().positive().optional(),
  notes: z.string().optional(),
});

const PaymentBody = z.object({
  method: z.enum(['cash', 'card']),
  amount: z.number().positive(),
  taxLines: z
    .array(
      z.object({
        name: z.string().min(1),
        amount: z.number(),
      }),
    )
    .optional(),
  tip: z.number().optional(),
  close: z.boolean().optional(),
});

/**
 * Temporary POS/KDS compatibility surface. It is never registered by the
 * production/default composition because it bypasses D02 server-derived scope.
 * Web and Discord callers must migrate to D02 before becoming a P0 platform path.
 */
export function registerLegacyCompatibilityRoutes(
  app: FastifyInstance,
  prisma: LegacyCompatibilityDatabase,
): void {
  app.post('/bootstrap', async (_req, reply) => {
    const restaurant = await prisma.restaurant.create({
      data: {
        name: 'Demo Bistro',
        timezone: 'Asia/Taipei',
        branches: {
          create: [
            {
              name: 'Main Branch',
              address: '123 Demo St',
              hours: '10:00-22:00',
              tables: {
                create: [
                  { code: 'T1', seats: 2 },
                  { code: 'T2', seats: 4 },
                ],
              },
              menuItems: {
                create: [
                  { sku: 'FOOD-001', name: 'Beef Noodles', basePrice: 180 },
                  { sku: 'FOOD-002', name: 'Fried Rice', basePrice: 120 },
                  { sku: 'DRINK-001', name: 'Iced Tea', basePrice: 40 },
                ],
              },
            },
          ],
        },
      },
      include: { branches: { include: { tables: true, menuItems: true } } },
    });
    return reply.status(201).send(restaurant);
  });

  app.post('/orders', async (req, reply) => {
    const parsed = OrderCreateBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ code: 'BAD_REQUEST', issues: parsed.error.issues });
    }
    const { branchId, tableId, type = 'dine-in' } = parsed.data;
    try {
      const order = await prisma.$transaction(async (tx) => {
        const branch = await tx.branch.findUnique({
          where: { id: branchId },
          select: { id: true },
        });
        if (!branch) throw new LegacyApiError(404, 'BRANCH_NOT_FOUND');

        if (tableId) {
          const table = await tx.table.findUnique({
            where: { id: tableId },
            select: { id: true, branchId: true },
          });
          if (!table || table.branchId !== branchId) {
            throw new LegacyApiError(404, 'TABLE_NOT_FOUND');
          }
          const updated = await tx.table.updateMany({
            where: { id: tableId, branchId, status: 'AVAILABLE' },
            data: { status: 'OCCUPIED' },
          });
          if (updated.count === 0) throw new LegacyApiError(409, 'TABLE_NOT_AVAILABLE');
        }

        return tx.order.create({
          data: {
            branchId,
            tableId: tableId || null,
            type:
              type === 'takeout'
                ? LegacyOrderType.TAKEOUT
                : type === 'delivery'
                  ? LegacyOrderType.DELIVERY
                  : LegacyOrderType.DINE_IN,
          },
        });
      });
      return reply.status(201).send(order);
    } catch (error) {
      if (isLegacyApiError(error)) {
        return reply.status(error.status).send({ code: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.post<{ Params: { id: string } }>('/orders/:id/items', async (req, reply) => {
    const parsed = OrderItemBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ code: 'BAD_REQUEST', issues: parsed.error.issues });
    }
    const { menuItemId, qty = 1, priceOverride, notes } = parsed.data;
    const menuItem = await prisma.menuItem.findUnique({ where: { id: menuItemId } });
    if (!menuItem) return reply.status(404).send({ code: 'MENU_ITEM_NOT_FOUND' });
    const item = await prisma.orderItem.create({
      data: {
        orderId: req.params.id,
        menuItemId,
        qty,
        price: priceOverride ?? Number(menuItem.basePrice),
        notes,
      },
    });
    return reply.status(201).send(item);
  });

  app.post<{ Params: { id: string } }>('/orders/:id/payments', async (req, reply) => {
    const parsed = PaymentBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ code: 'BAD_REQUEST', issues: parsed.error.issues });
    }
    const { method, amount, taxLines = [], tip, close } = parsed.data;
    try {
      const payment = await prisma.$transaction(async (tx) => {
        const order = await tx.order.findUnique({
          where: { id: req.params.id },
          select: { id: true, status: true, tableId: true },
        });
        if (!order) throw new LegacyApiError(404, 'ORDER_NOT_FOUND');
        if (
          order.status === LegacyOrderStatus.CLOSED ||
          order.status === LegacyOrderStatus.CANCELED
        ) {
          throw new LegacyApiError(409, 'ORDER_FINALIZED');
        }

        const record = await tx.payment.create({
          data: {
            orderId: req.params.id,
            method: method === 'card' ? LegacyPaymentMethod.CARD : LegacyPaymentMethod.CASH,
            amount,
          },
        });
        if (taxLines.length) {
          await tx.taxLine.createMany({
            data: taxLines.map((taxLine) => ({
              orderId: req.params.id,
              name: taxLine.name,
              amount: taxLine.amount,
            })),
          });
        }
        if (typeof tip === 'number' && !Number.isNaN(tip)) {
          await tx.tip.create({ data: { orderId: req.params.id, amount: tip } });
        }
        if (close) {
          const closed = await tx.order.update({
            where: { id: req.params.id },
            data: { status: LegacyOrderStatus.CLOSED, closedAt: new Date() },
            select: { id: true, tableId: true },
          });
          if (closed.tableId) {
            const remaining = await tx.order.count({
              where: {
                tableId: closed.tableId,
                id: { not: closed.id },
                status: {
                  in: [
                    LegacyOrderStatus.OPEN,
                    LegacyOrderStatus.IN_PROGRESS,
                    LegacyOrderStatus.SERVED,
                  ],
                },
              },
            });
            if (remaining === 0) {
              await tx.table.update({
                where: { id: closed.tableId },
                data: { status: 'AVAILABLE' },
              });
            }
          }
        }
        return record;
      });
      return reply.status(201).send(payment);
    } catch (error) {
      if (isLegacyApiError(error)) {
        return reply.status(error.status).send({ code: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.post<{ Params: { id: string } }>('/kds/tickets/:id/start', async (req, reply) => {
    try {
      return reply.send(
        await prisma.order.update({
          where: { id: req.params.id },
          data: { status: LegacyOrderStatus.IN_PROGRESS },
        }),
      );
    } catch {
      return reply.status(404).send({ code: 'TICKET_NOT_FOUND' });
    }
  });

  app.post<{ Params: { id: string } }>('/kds/tickets/:id/serve', async (req, reply) => {
    try {
      return reply.send(
        await prisma.order.update({
          where: { id: req.params.id },
          data: { status: LegacyOrderStatus.SERVED },
        }),
      );
    } catch {
      return reply.status(404).send({ code: 'TICKET_NOT_FOUND' });
    }
  });
}
