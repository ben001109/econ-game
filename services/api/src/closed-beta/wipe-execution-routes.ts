import type { FastifyInstance, FastifyReply } from 'fastify';

import { CommandError, isCommandError } from '../commands/command-contract.js';
import type { WipeExecutionLeaseService } from './wipe-execution.js';

export function registerWipeExecutionLeaseRoutes(
  app: FastifyInstance,
  service: WipeExecutionLeaseService | undefined,
  allowTestService = false,
) {
  for (const [action, phase] of [
    ['clear', 'CLEARED'],
    ['verify', 'VERIFIED'],
  ] as const) {
    app.post<{ Params: { tenantId: string; batchId: string }; Body: unknown }>(
      `/closed-beta/tenants/:tenantId/wipe-batches/:batchId/${action}-leases`,
      async (request, reply) =>
        leaseReply(reply, async () => {
          if (!service || (!allowTestService && !service.isDurable())) {
            throw new CommandError(503, 'WIPE_EXECUTION_PERSISTENCE_REQUIRED');
          }
          return service.request(
            bearer(request.headers.authorization),
            request.params.tenantId,
            request.params.batchId,
            phase,
            request.body,
          );
        }),
    );
  }
}

function bearer(value: string | undefined) {
  if (!value?.startsWith('Bearer ') || value.includes(',') || value.slice(7).includes(' ')) {
    throw new CommandError(401, 'WIPE_AUTHENTICATION_REQUIRED');
  }
  return value.slice(7);
}

async function leaseReply(reply: FastifyReply, operation: () => Promise<unknown>) {
  try {
    return reply.status(202).send(await operation());
  } catch (error) {
    if (isCommandError(error)) return reply.status(error.status).send(error.toBody());
    throw error;
  }
}
