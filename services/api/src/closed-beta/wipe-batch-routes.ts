import type { FastifyInstance, FastifyReply } from 'fastify';

import { CommandError, isCommandError } from '../commands/command-contract.js';
import { WipeBatchService } from './wipe-batch.js';

export function registerWipeBatchRoutes(
  app: FastifyInstance,
  service: WipeBatchService | undefined,
  allowTestRepository = false,
): void {
  app.post<{ Params: { tenantId: string }; Body: unknown }>(
    '/closed-beta/tenants/:tenantId/wipe-batches/dry-run',
    async (request, reply) => wipeReply(reply, async () => ({
      status: 200,
      body: await configured(service, allowTestRepository).dryRun(
        bearer(request.headers.authorization),
        request.params.tenantId,
        request.body,
      ),
    })),
  );

  app.post<{ Params: { tenantId: string }; Body: unknown }>(
    '/closed-beta/tenants/:tenantId/wipe-batches',
    async (request, reply) => wipeReply(reply, async () => ({
      status: 201,
      body: await configured(service, allowTestRepository).request(
        bearer(request.headers.authorization),
        request.params.tenantId,
        request.body,
        request.id,
      ),
    })),
  );

  for (const action of ['approve', 'freeze', 'isolate', 'resume'] as const) {
    app.post<{ Params: { tenantId: string; batchId: string }; Body: unknown }>(
      `/closed-beta/tenants/:tenantId/wipe-batches/:batchId/${action}`,
      async (request, reply) => wipeReply(reply, async () => {
        const target = configured(service, allowTestRepository);
        const result = await target[action](
          bearer(request.headers.authorization),
          request.params.tenantId,
          request.params.batchId,
          request.body,
          request.id,
        );
        return { status: 200, body: result };
      }),
    );
  }

  app.get<{ Params: { tenantId: string; batchId: string } }>(
    '/closed-beta/tenants/:tenantId/wipe-batches/:batchId',
    async (request, reply) => wipeReply(reply, async () => ({
      status: 200,
      body: await configured(service, allowTestRepository).status(
        bearer(request.headers.authorization),
        request.params.tenantId,
        request.params.batchId,
      ),
    })),
  );
}

function configured(
  service: WipeBatchService | undefined,
  allowTestRepository: boolean,
): WipeBatchService {
  if (!service || (!allowTestRepository && !service.isDurable())) {
    throw new CommandError(503, 'WIPE_PERSISTENCE_REQUIRED');
  }
  return service;
}

function bearer(value: string | undefined) {
  if (!value?.startsWith('Bearer ') || value.includes(',') || value.slice(7).includes(' ')) {
    throw new CommandError(401, 'WIPE_AUTHENTICATION_REQUIRED');
  }
  const token = value.slice(7);
  if (!token) throw new CommandError(401, 'WIPE_AUTHENTICATION_REQUIRED');
  return token;
}

async function wipeReply(
  reply: FastifyReply,
  operation: () => Promise<Readonly<{ status: number; body: unknown }>>,
) {
  try {
    const result = await operation();
    return reply.status(result.status).send(result.body);
  } catch (error) {
    if (isCommandError(error)) return reply.status(error.status).send(error.toBody());
    throw error;
  }
}
