import 'dotenv/config';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUI from '@fastify/swagger-ui';
import { PrismaClient, PaymentMethod, OrderStatus, OrderType } from '@prisma/client';
import Fastify from 'fastify';
import { z } from 'zod';

import { env } from './env.js';

const prisma = new PrismaClient();
const app = Fastify({ logger: true });

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
  const order = await prisma.order.create({
    data: {
      branchId,
      tableId: tableId || null,
      type: type === 'takeout' ? OrderType.TAKEOUT : type === 'delivery' ? OrderType.DELIVERY : OrderType.DINE_IN,
    },
  });
  return reply.status(201).send(order);
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
  const payment = await prisma.payment.create({ data: { orderId: id, method: pm, amount } });
  if (taxLines.length) {
    await prisma.taxLine.createMany({ data: taxLines.map((t) => ({ orderId: id, name: t.name, amount: t.amount })) });
  }
  if (typeof tip === 'number' && !Number.isNaN(tip)) {
    await prisma.tip.create({ data: { orderId: id, amount: tip } });
  }
  if (close) {
    await prisma.order.update({ where: { id }, data: { status: OrderStatus.CLOSED, closedAt: new Date() } });
  }
  return reply.status(201).send(payment);
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
