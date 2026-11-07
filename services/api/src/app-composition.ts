import Fastify, { type FastifyServerOptions } from 'fastify';

import {
  createTrustedCommandContextResolver,
  createTrustedPlayerIdentityResolver,
  type TrustedContextSecurityOptions,
} from './auth/trusted-command-context.js';
import { registerClosedBetaRoutes } from './closed-beta/closed-beta-routes.js';
import { ClosedBetaError, type ClosedBetaService } from './closed-beta/closed-beta.js';
import { registerWipeBatchRoutes } from './closed-beta/wipe-batch-routes.js';
import type { WipeBatchService } from './closed-beta/wipe-batch.js';
import { registerWipeExecutionLeaseRoutes } from './closed-beta/wipe-execution-routes.js';
import type { WipeExecutionLeaseService } from './closed-beta/wipe-execution.js';
import { CommandError } from './commands/command-contract.js';
import {
  CommandDispatcher,
  PersistenceRequiredCommandExecutionStore,
} from './commands/command-dispatcher.js';
import { registerCommandRoutes } from './commands/command-routes.js';
import { createLedgerCommandHandlers } from './domains/ledger/ledger-command.js';
import {
  PostgresDurableCommandExecutionStore,
  type D03Database,
} from './domains/ledger/postgres-ledger-store.js';
import {
  registerInitializeCompetitiveSaveRoutes,
  type BootstrapWebIdentityResolver,
  type DurableBootstrapInitializer,
  type TestBootstrapInitializer,
} from './gameplay/initialize-competitive-save-routes.js';
import { createAdvanceServicePeriodCommandHandler } from './gameplay/advance-service-period-command.js';
import { createConfigurePreopenDayCommandHandler } from './gameplay/configure-preopen-day-command.js';
import { createOpenBusinessDayCommandHandler } from './gameplay/open-business-day-command.js';
import { createRequestDayReplayCommandHandler } from './gameplay/request-day-replay-command.js';
import { createSettleBusinessDayCommandHandler } from './gameplay/settle-business-day-command.js';
import { registerPreopenConfigurationChoicesRoutes } from './gameplay/preopen-configuration-choices-routes.js';
import {
  PrismaPreopenConfigurationChoicesRepository,
  type PreopenConfigurationChoicesRepository,
} from './gameplay/prisma-preopen-configuration-choices-repository.js';
import {
  PrismaGameplayReadModelRepository,
  registerGameplayReadModelRoutes,
  type GameplayReadModelRepository,
} from './gameplay/gameplay-read-model.js';
import type { DiscordIdentityLinkService } from './identity/discord-identity-link.js';
import { registerDiscordIdentityLinkRoutes } from './identity/discord-identity-routes.js';
import {
  registerLegacyCompatibilityRoutes,
  type LegacyCompatibilityDatabase,
} from './legacy-compatibility.js';
import {
  API_BODY_LIMIT_BYTES,
  assertJsonWithinResourceLimits,
  JsonResourceLimitError,
} from './security/json-resource-limits.js';

export const REQUEST_LIMIT_ERROR_ENVELOPE_VERSION = 'b2-request-limit-error/v1' as const;
export const RUNTIME_ERROR_ENVELOPE_VERSION = 'b3-runtime-error/v1' as const;

export type ApiCompositionOptions = Readonly<{
  logger?: FastifyServerOptions['logger'];
  commandDispatcher?: CommandDispatcher;
  durableCommandDatabase?: D03Database;
  identitySecurity?: TrustedContextSecurityOptions;
  discordIdentityLinkService?: DiscordIdentityLinkService;
  testOnlyDiscordIdentityLinkService?: DiscordIdentityLinkService;
  closedBetaService?: ClosedBetaService;
  testOnlyClosedBetaService?: ClosedBetaService;
  wipeBatchService?: WipeBatchService;
  testOnlyWipeBatchService?: WipeBatchService;
  testOnlyWipeExecutionLeaseService?: WipeExecutionLeaseService;
  bootstrapInitializer?: DurableBootstrapInitializer;
  bootstrapWebIdentityResolver?: BootstrapWebIdentityResolver;
  testOnlyBootstrapInitializer?: TestBootstrapInitializer;
  testOnlyBootstrapWebIdentityResolver?: BootstrapWebIdentityResolver;
  testOnlyGameplayReadModelRepository?: GameplayReadModelRepository;
  testOnlyPreopenConfigurationChoicesRepository?: PreopenConfigurationChoicesRepository;
  testOnlyBypassClosedBetaEligibility?: true;
}>;

/**
 * Production/default composition exposes only the fail-closed D02 route. The
 * legacy POS/KDS writers require an explicit process-local composition option;
 * no request field, header, or query parameter can enable them.
 */
export function createApiComposition(options: ApiCompositionOptions = {}) {
  const app = Fastify({ logger: options.logger, bodyLimit: API_BODY_LIMIT_BYTES });
  app.addHook('preValidation', async (request) => {
    if (request.body !== undefined) assertJsonWithinResourceLimits(request.body);
  });
  app.setErrorHandler((error, request, reply) => {
    const metadata = errorMetadata(error);
    if (error instanceof JsonResourceLimitError || metadata.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.status(413).send({
        error: {
          version: REQUEST_LIMIT_ERROR_ENVELOPE_VERSION,
          code: 'REQUEST_BODY_RESOURCE_LIMIT_EXCEEDED',
          ...(error instanceof JsonResourceLimitError
            ? { details: { limit: error.kind } }
            : { details: { limit: 'BODY_BYTES' } }),
        },
      });
    }
    request.log.error({ err: error }, 'request failed');
    const statusCode =
      typeof metadata.statusCode === 'number' &&
      metadata.statusCode >= 400 &&
      metadata.statusCode < 500
        ? metadata.statusCode
        : 500;
    return reply.status(statusCode).send({
      error: {
        version: RUNTIME_ERROR_ENVELOPE_VERSION,
        code: statusCode === 500 ? 'INTERNAL_SERVER_ERROR' : 'REQUEST_REJECTED',
      },
    });
  });
  if (options.commandDispatcher && options.durableCommandDatabase) {
    throw new Error('Configure either an explicit command dispatcher or the durable D03 database');
  }
  const closedBetaService = options.closedBetaService ?? options.testOnlyClosedBetaService;
  const wipeBatchService = options.wipeBatchService ?? options.testOnlyWipeBatchService;
  const allowTestClosedBetaRepository = options.testOnlyClosedBetaService !== undefined;
  const identityResolver = options.identitySecurity
    ? createTrustedCommandContextResolver(options.identitySecurity)
    : () => undefined;
  const playerIdentityResolver = options.identitySecurity
    ? createTrustedPlayerIdentityResolver(options.identitySecurity)
    : async () => {
        throw new CommandError(401, 'UNTRUSTED_COMMAND_CONTEXT');
      };
  registerCommandRoutes(app, {
    dispatcher:
      options.commandDispatcher ??
      (options.durableCommandDatabase
        ? new CommandDispatcher(
            [
              ...createLedgerCommandHandlers(),
              createConfigurePreopenDayCommandHandler(),
              createOpenBusinessDayCommandHandler(),
              createAdvanceServicePeriodCommandHandler(),
              createSettleBusinessDayCommandHandler(),
              createRequestDayReplayCommandHandler(),
            ],
            new PostgresDurableCommandExecutionStore(options.durableCommandDatabase),
          )
        : new CommandDispatcher([], new PersistenceRequiredCommandExecutionStore())),
    resolveTrustedContext: async (request) => {
      const context = await identityResolver(request);
      if (!context) return undefined;
      if (options.testOnlyBypassClosedBetaEligibility) return context;
      if (wipeBatchService) {
        await wipeBatchService.assertSaveMutationAllowed(
          context.actorId,
          context.tenantId,
          context.saveId,
        );
      }
      if (
        !closedBetaService ||
        (!allowTestClosedBetaRepository && !closedBetaService.isDurable())
      ) {
        throw new CommandError(503, 'CLOSED_BETA_NOT_CONFIGURED');
      }
      try {
        await closedBetaService.assertEntranceEligible(context.actorId, context.tenantId);
      } catch (error) {
        if (error instanceof ClosedBetaError) throw new CommandError(error.status, error.code);
        throw error;
      }
      return context;
    },
  });
  app.get('/health', async () => ({ status: 'ok' }));

  registerDiscordIdentityLinkRoutes(
    app,
    options.discordIdentityLinkService ?? options.testOnlyDiscordIdentityLinkService,
    options.testOnlyDiscordIdentityLinkService !== undefined,
  );
  registerClosedBetaRoutes(app, closedBetaService, allowTestClosedBetaRepository);
  registerWipeBatchRoutes(app, wipeBatchService, options.testOnlyWipeBatchService !== undefined);
  registerWipeExecutionLeaseRoutes(
    app,
    options.testOnlyWipeExecutionLeaseService,
    options.testOnlyWipeExecutionLeaseService !== undefined,
  );

  const bootstrapInitializer = options.bootstrapInitializer ?? options.testOnlyBootstrapInitializer;
  const bootstrapWebIdentityResolver =
    options.bootstrapWebIdentityResolver ?? options.testOnlyBootstrapWebIdentityResolver;
  if ((bootstrapInitializer === undefined) !== (bootstrapWebIdentityResolver === undefined)) {
    throw new Error('Bootstrap initializer and Web identity resolver must be configured together');
  }
  if (bootstrapInitializer && bootstrapWebIdentityResolver) {
    registerInitializeCompetitiveSaveRoutes(app, {
      initializer: bootstrapInitializer,
      resolveWebIdentity: bootstrapWebIdentityResolver,
      allowTestInitializer: options.testOnlyBootstrapInitializer !== undefined,
    });
  }

  registerGameplayReadModelRoutes(app, {
    resolveIdentity: playerIdentityResolver,
    repository:
      options.testOnlyGameplayReadModelRepository ??
      (options.durableCommandDatabase
        ? new PrismaGameplayReadModelRepository(options.durableCommandDatabase)
        : undefined),
    assertScopeAllowed: async (playerId, tenantId) => {
      if (options.testOnlyBypassClosedBetaEligibility) return;
      if (
        !closedBetaService ||
        (!allowTestClosedBetaRepository && !closedBetaService.isDurable())
      ) {
        throw new CommandError(503, 'CLOSED_BETA_NOT_CONFIGURED');
      }
      try {
        await closedBetaService.assertEntranceEligible(playerId, tenantId);
      } catch (error) {
        if (error instanceof ClosedBetaError) throw new CommandError(error.status, error.code);
        throw error;
      }
    },
  });

  registerPreopenConfigurationChoicesRoutes(app, {
    resolveIdentity: playerIdentityResolver,
    repository:
      options.testOnlyPreopenConfigurationChoicesRepository ??
      (options.durableCommandDatabase
        ? new PrismaPreopenConfigurationChoicesRepository(options.durableCommandDatabase)
        : undefined),
    assertScopeAllowed: async (playerId, tenantId) => {
      if (options.testOnlyBypassClosedBetaEligibility) return;
      if (
        !closedBetaService ||
        (!allowTestClosedBetaRepository && !closedBetaService.isDurable())
      ) {
        throw new CommandError(503, 'CLOSED_BETA_NOT_CONFIGURED');
      }
      try {
        await closedBetaService.assertEntranceEligible(playerId, tenantId);
      } catch (error) {
        if (error instanceof ClosedBetaError) throw new CommandError(error.status, error.code);
        throw error;
      }
    },
  });

  return app;
}

function errorMetadata(error: unknown): Readonly<{ code?: unknown; statusCode?: unknown }> {
  return typeof error === 'object' && error !== null
    ? (error as Readonly<{ code?: unknown; statusCode?: unknown }>)
    : {};
}

/** Test-only compatibility host; the formal production factory cannot select it. */
export function createTestOnlyLegacyApiComposition(
  options: ApiCompositionOptions &
    Readonly<{ legacyCompatibility: Readonly<{ prisma: LegacyCompatibilityDatabase }> }>,
) {
  const app = createApiComposition(options);
  registerLegacyCompatibilityRoutes(app, options.legacyCompatibility.prisma);
  return app;
}
