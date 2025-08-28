import 'dotenv/config';
import swagger from '@fastify/swagger';
import swaggerUI from '@fastify/swagger-ui';
import { PrismaClient, PaymentMethod, OrderStatus, OrderType } from '@prisma/client';
import Fastify from 'fastify';

import { env } from './env.js';

const prisma = new PrismaClient();
const app = Fastify({ logger: true });

await app.register(swagger, {
  openapi: {
    info: { title: 'Restaurant API', version: '0.1.0' },
  },
});
await app.register(swaggerUI, { routePrefix: '/docs' });

app.get('/health', async () => ({ status: 'ok' }));

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
app.post<{ Body: { branchId: string; tableId?: string; type?: 'dine-in' | 'takeout' | 'delivery' } }>(
  '/orders',
  async (req, reply) => {
    const { branchId, tableId, type = 'dine-in' } = req.body;
    const order = await prisma.order.create({
      data: {
        branchId,
        tableId: tableId || null,
        type: type === 'takeout' ? OrderType.TAKEOUT : type === 'delivery' ? OrderType.DELIVERY : OrderType.DINE_IN,
      },
    });
    return reply.status(201).send(order);
  }
);

// Add item to order
app.post<{ Params: { id: string }; Body: { menuItemId: string; qty?: number; priceOverride?: number; notes?: string } }>(
  '/orders/:id/items',
  async (req, reply) => {
    const { id } = req.params;
    const { menuItemId, qty = 1, priceOverride, notes } = req.body;
    const menuItem = await prisma.menuItem.findUnique({ where: { id: menuItemId } });
    if (!menuItem) return reply.status(404).send({ code: 'MENU_ITEM_NOT_FOUND' });
    const price = priceOverride ?? Number(menuItem.basePrice);
    const item = await prisma.orderItem.create({ data: { orderId: id, menuItemId, qty, price, notes } });
    return reply.status(201).send(item);
  }
);

// Add payment (optionally tax lines and tip)
app.post<{
  Params: { id: string };
  Body: {
    method: 'cash' | 'card';
    amount: number;
    taxLines?: { name: string; amount: number }[];
    tip?: number;
    close?: boolean;
  };
}>(
  '/orders/:id/payments',
  async (req, reply) => {
    const { id } = req.params;
    const { method, amount, taxLines = [], tip, close } = req.body;
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
  }
);

// Fetch order
app.get<{ Params: { id: string } }>('/orders/:id', async (req, reply) => {
  const order = await prisma.order.findUnique({
    where: { id: req.params.id },
    include: { items: { include: { menuItem: true } }, payments: true, taxLines: true, tips: true },
  });
  if (!order) return reply.status(404).send({ code: 'ORDER_NOT_FOUND' });
  return reply.send(order);
});

try {
  await app.listen({ host: '0.0.0.0', port: env.PORT });
  app.log.info(`API listening on :${env.PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
