import type { FastifyInstance, FastifyRequest } from 'fastify';

import { isCommandError, CommandError, type TrustedCommandContext } from './command-contract.js';
import { CommandDispatcher } from './command-dispatcher.js';

export type TrustedCommandContextResolver = (
  request: FastifyRequest,
) => Promise<TrustedCommandContext | undefined> | TrustedCommandContext | undefined;

/**
 * D04 is the only future producer of TrustedCommandContext. This adapter never
 * reads actor, tenant, save, role, or permission values from the request body.
 */
export function registerCommandRoutes(
  app: FastifyInstance,
  options: Readonly<{
    dispatcher: CommandDispatcher;
    resolveTrustedContext: TrustedCommandContextResolver;
  }>,
): void {
  app.post<{
    Params: { saveId: string; commandType: string };
    Body: unknown;
  }>('/saves/:saveId/actions/:commandType', async (request, reply) => {
    try {
      const context = await options.resolveTrustedContext(request);
      if (!context) throw new CommandError(401, 'UNTRUSTED_COMMAND_CONTEXT');
      const response = await options.dispatcher.dispatch({
        context,
        target: request.params,
        envelope: request.body,
      });
      return reply.status(response.status).send(response.body);
    } catch (error) {
      if (isCommandError(error)) return reply.status(error.status).send(error.toBody());
      throw error;
    }
  });
}
