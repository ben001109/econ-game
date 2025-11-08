import { monitoring, Sentry, registerProcessLogging } from './instrumentation.js';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUI from '@fastify/swagger-ui';
import { PrismaClient, PaymentMethod, OrderStatus, OrderType } from '@prisma/client';
import Fastify from 'fastify';
import { z } from 'zod';

import { env } from './env.js';
import { logger } from './logger.js';

const prisma = new PrismaClient();
const app = Fastify({ logger });

registerProcessLogging(logger);

class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

const isApiError = (err: unknown): err is ApiError => err instanceof ApiError;

if (monitoring.sentry) {
  app.addHook('onError', async (request, _reply, error) => {
    const route =
      typeof request.routeOptions?.url === 'string' && request.routeOptions.url.length > 0
        ? request.routeOptions.url
        : request.url;
    Sentry.withScope((scope) => {
      scope.setTag('service', 'api');
      scope.setTag('method', request.method);
      scope.setTag('route', route);
      scope.setExtra('requestId', request.id);
      scope.setExtra('url', request.url);
      scope.setExtra('params', request.params);
      scope.setExtra('query', request.query);
      scope.setExtra('body', request.body);
      Sentry.captureException(error);
    });
  });
}

await app.register(cors, { origin: true });

await app.register(swagger, {
  openapi: {
    info: { title: 'Restaurant API', version: '0.1.0' },
  },
});
await app.register(swaggerUI, { routePrefix: '/docs' });

app.get('/health', async () => ({ status: 'ok' }));

// Basic browse endpoints to help frontend avoid manual IDs
app.get('/restaurants', async (_req, reply) => {
  const restaurants = await prisma.restaurant.findMany({
    include: { branches: { include: { tables: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return reply.send(restaurants);
});

// Bootstrap sample data for quick-start dev
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
            tables: { create: [{ code: 'T1', seats: 2 }, { code: 'T2', seats: 4 }] },
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

// Menus
app.get('/menus', async (_req, reply) => {
  const items = await prisma.menuItem.findMany({ orderBy: { name: 'asc' } });
  return reply.send(items);
});

// Create order
const OrderCreateBody = z.object({
  branchId: z.string().min(1),
  tableId: z.string().min(1).optional(),
  type: z.enum(['dine-in', 'takeout', 'delivery']).optional(),
});

app.post('/orders', async (req, reply) => {
  const parsed = OrderCreateBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    return reply.status(400).send({ code: 'BAD_REQUEST', issues: parsed.error.issues });
  }
  const { branchId, tableId, type = 'dine-in' } = parsed.data;
  try {
    const order = await prisma.$transaction(async (tx) => {
      const branch = await tx.branch.findUnique({ where: { id: branchId }, select: { id: true } });
      if (!branch) {
        throw new ApiError(404, 'BRANCH_NOT_FOUND');
      }

      if (tableId) {
        const table = await tx.table.findUnique({ where: { id: tableId }, select: { id: true, branchId: true } });
        if (!table || table.branchId !== branchId) {
          throw new ApiError(404, 'TABLE_NOT_FOUND');
        }
        const updated = await tx.table.updateMany({
          where: { id: tableId, branchId, status: 'AVAILABLE' },
          data: { status: 'OCCUPIED' },
        });
        if (updated.count === 0) {
          throw new ApiError(409, 'TABLE_NOT_AVAILABLE');
        }
      }

      return tx.order.create({
        data: {
          branchId,
          tableId: tableId || null,
          type: type === 'takeout' ? OrderType.TAKEOUT : type === 'delivery' ? OrderType.DELIVERY : OrderType.DINE_IN,
        },
      });
    });
    return reply.status(201).send(order);
  } catch (err) {
    if (isApiError(err)) {
      return reply.status(err.status).send({ code: err.code, message: err.message });
    }
    throw err;
  }
});

// Add item to order
const OrderItemBody = z.object({
  menuItemId: z.string().min(1),
  qty: z.number().int().positive().optional(),
  priceOverride: z.number().positive().optional(),
  notes: z.string().optional(),
});

app.post<{ Params: { id: string } }>('/orders/:id/items', async (req, reply) => {
  const { id } = req.params;
  const parsed = OrderItemBody.safeParse(req.body ?? {});
  if (!parsed.success) return reply.status(400).send({ code: 'BAD_REQUEST', issues: parsed.error.issues });
  const { menuItemId, qty = 1, priceOverride, notes } = parsed.data;
  const menuItem = await prisma.menuItem.findUnique({ where: { id: menuItemId } });
  if (!menuItem) return reply.status(404).send({ code: 'MENU_ITEM_NOT_FOUND' });
  const price = priceOverride ?? Number(menuItem.basePrice);
  const item = await prisma.orderItem.create({ data: { orderId: id, menuItemId, qty, price, notes } });
  return reply.status(201).send(item);
});

// Add payment (optionally tax lines and tip)
const PaymentBody = z.object({
  method: z.enum(['cash', 'card']),
  amount: z.number().positive(),
  taxLines: z
    .array(
      z.object({
        name: z.string().min(1),
        amount: z.number(),
      })
    )
    .optional(),
  tip: z.number().optional(),
  close: z.boolean().optional(),
});

app.post<{ Params: { id: string } }>('/orders/:id/payments', async (req, reply) => {
  const { id } = req.params;
  const parsed = PaymentBody.safeParse(req.body ?? {});
  if (!parsed.success) return reply.status(400).send({ code: 'BAD_REQUEST', issues: parsed.error.issues });
  const { method, amount, taxLines = [], tip, close } = parsed.data;
  const pm = method === 'card' ? PaymentMethod.CARD : PaymentMethod.CASH;
  try {
    const payment = await prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { id }, select: { id: true, status: true, tableId: true } });
      if (!order) {
        throw new ApiError(404, 'ORDER_NOT_FOUND');
      }
      if (order.status === OrderStatus.CLOSED || order.status === OrderStatus.CANCELED) {
        throw new ApiError(409, 'ORDER_FINALIZED');
      }

      const record = await tx.payment.create({ data: { orderId: id, method: pm, amount } });
      if (taxLines.length) {
        await tx.taxLine.createMany({ data: taxLines.map((t) => ({ orderId: id, name: t.name, amount: t.amount })) });
      }
      if (typeof tip === 'number' && !Number.isNaN(tip)) {
        await tx.tip.create({ data: { orderId: id, amount: tip } });
      }
      if (close) {
        const closed = await tx.order.update({
          where: { id },
          data: { status: OrderStatus.CLOSED, closedAt: new Date() },
          select: { id: true, tableId: true },
        });
        if (closed.tableId) {
          const remaining = await tx.order.count({
            where: {
              tableId: closed.tableId,
              id: { not: closed.id },
              status: { in: [OrderStatus.OPEN, OrderStatus.IN_PROGRESS, OrderStatus.SERVED] },
            },
          });
          if (remaining === 0) {
            await tx.table.update({ where: { id: closed.tableId }, data: { status: 'AVAILABLE' } });
          }
        }
      }
      return record;
    });
    return reply.status(201).send(payment);
  } catch (err) {
    if (isApiError(err)) {
      return reply.status(err.status).send({ code: err.code, message: err.message });
    }
    throw err;
  }
});

// Fetch order
app.get<{ Params: { id: string } }>('/orders/:id', async (req, reply) => {
  const order = await prisma.order.findUnique({
    where: { id: req.params.id },
    include: { items: { include: { menuItem: true } }, payments: true, taxLines: true, tips: true },
  });
  if (!order) return reply.status(404).send({ code: 'ORDER_NOT_FOUND' });
  return reply.send(order);
});

// KDS: list active tickets (orders not closed/canceled)
app.get('/kds/tickets', async (_req, reply) => {
  const tickets = await prisma.order.findMany({
    where: { NOT: [{ status: OrderStatus.CLOSED }, { status: OrderStatus.CANCELED }] },
    orderBy: { openedAt: 'asc' },
    include: { items: { include: { menuItem: true } } },
  });
  return reply.send(tickets);
});

// KDS: start ticket (mark IN_PROGRESS)
app.post<{ Params: { id: string } }>('/kds/tickets/:id/start', async (req, reply) => {
  const { id } = req.params;
  try {
    const updated = await prisma.order.update({
      where: { id },
      data: { status: OrderStatus.IN_PROGRESS },
    });
    return reply.send(updated);
  } catch {
    return reply.status(404).send({ code: 'TICKET_NOT_FOUND' });
  }
});

// KDS: serve ticket (mark SERVED)
app.post<{ Params: { id: string } }>('/kds/tickets/:id/serve', async (req, reply) => {
  const { id } = req.params;
  try {
    const updated = await prisma.order.update({
      where: { id },
      data: { status: OrderStatus.SERVED },
    });
    return reply.send(updated);
  } catch {
    return reply.status(404).send({ code: 'TICKET_NOT_FOUND' });
  }
});

try {
  await app.listen({ host: '0.0.0.0', port: env.PORT });
  app.log.info(`API listening on :${env.PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
