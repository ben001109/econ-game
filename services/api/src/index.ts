import 'dotenv/config';
import swagger from '@fastify/swagger';
import swaggerUI from '@fastify/swagger-ui';
import { PrismaClient } from '@prisma/client';
import Fastify from 'fastify';

import { env } from './env.js';

const prisma = new PrismaClient();
const app = Fastify({ logger: true });

await app.register(swagger, {
  openapi: {
    info: { title: 'Econ Game API', version: '0.1.0' },
  },
});
await app.register(swaggerUI, { routePrefix: '/docs' });

app.get('/health', async () => ({ status: 'ok' }));

app.post<{ Body: { username: string; locale?: string } }>(
  '/players',
  async (req, reply) => {
    const { username, locale = 'en' } = req.body;
    const player = await prisma.player.create({
      data: { username, locale },
    });
    // Create default accounts for the player
    await prisma.account.createMany({
      data: [
        { name: 'Cash', type: 'ASSET', currencyCode: 'USD', playerId: player.id },
        { name: 'Equity', type: 'EQUITY', currencyCode: 'USD', playerId: player.id },
      ],
    });
    return reply.status(201).send(player);
  }
);

app.get<{ Params: { id: string } }>('/players/:id', async (req, reply) => {
  const player = await prisma.player.findUnique({ where: { id: req.params.id } });
  if (!player) return reply.status(404).send({ code: 'PLAYER_NOT_FOUND' });
  return player;
});

try {
  await app.listen({ host: '0.0.0.0', port: env.PORT });
  app.log.info(`API listening on :${env.PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
