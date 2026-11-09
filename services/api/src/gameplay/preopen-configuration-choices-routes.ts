import type { FastifyInstance } from 'fastify';

import type {
  TrustedPlayerIdentity,
  TrustedPlayerIdentityResolver,
} from '../auth/trusted-command-context.js';
import { CommandError, isCommandError } from '../commands/command-contract.js';
import {
  PREOPEN_CONFIGURATION_CHOICES_ERROR_CODES,
  PreopenConfigurationChoicesError,
  providePreopenConfigurationChoices,
} from './preopen-configuration-choices.js';
import type {
  PreopenConfigurationChoicesRepository,
  PreopenConfigurationChoicesScope,
} from './prisma-preopen-configuration-choices-repository.js';

export const PREOPEN_CONFIGURATION_CHOICES_ROUTE =
  '/saves/:saveId/preopen/configuration-choices' as const;

const saveIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

export function registerPreopenConfigurationChoicesRoutes(
  app: FastifyInstance,
  options: Readonly<{
    resolveIdentity: TrustedPlayerIdentityResolver;
    repository?: PreopenConfigurationChoicesRepository;
    assertScopeAllowed?: (playerId: string, tenantId: string) => Promise<void>;
  }>,
): void {
  app.get<{ Params: { saveId: string } }>(
    PREOPEN_CONFIGURATION_CHOICES_ROUTE,
    async (request, reply) => {
      try {
        const identity = await options.resolveIdentity(request);
        if (identity.principal.type !== 'web') {
          throw new CommandError(403, 'PREOPEN_CONFIGURATION_CHOICES_WEB_ONLY');
        }
        const saveId = parseSaveId(request.params.saveId);
        const repository = requiredRepository(options.repository);
        const scope = await repository.resolveScope(identity.playerId, saveId);
        if (!scope) throw notFound();

        await assertEligibility(options.assertScopeAllowed, identity, scope);
        await recordScopeResolution(identity, scope);

        const scoped = await repository.loadAuthority(scope);
        if (!scoped) throw notFound();
        if (!sameScope(scoped.scope, scope)) throw unavailable();
        return reply.status(200).send(providePreopenConfigurationChoices(scoped.authority));
      } catch (error) {
        return sendReadError(error, reply);
      }
    },
  );
}

function sameScope(
  actual: PreopenConfigurationChoicesScope,
  expected: PreopenConfigurationChoicesScope,
): boolean {
  return (
    actual.playerId === expected.playerId &&
    actual.membershipId === expected.membershipId &&
    actual.tenantId === expected.tenantId &&
    actual.saveId === expected.saveId &&
    actual.role === expected.role
  );
}

async function assertEligibility(
  assertScopeAllowed: ((playerId: string, tenantId: string) => Promise<void>) | undefined,
  identity: TrustedPlayerIdentity,
  scope: PreopenConfigurationChoicesScope,
): Promise<void> {
  if (!assertScopeAllowed) throw unavailable();
  try {
    await assertScopeAllowed(identity.playerId, scope.tenantId);
  } catch (error) {
    if (isCommandError(error) && error.status === 403) throw notFound();
    throw error;
  }
}

async function recordScopeResolution(
  identity: TrustedPlayerIdentity,
  scope: PreopenConfigurationChoicesScope,
): Promise<void> {
  if (typeof identity.recordScopeResolution !== 'function') throw unavailable();
  try {
    await identity.recordScopeResolution({
      operation: 'READ_PREOPEN_CONFIGURATION_CHOICES',
      membershipId: scope.membershipId,
      tenantId: scope.tenantId,
      saveId: scope.saveId,
      role: scope.role,
    });
  } catch {
    throw unavailable();
  }
}

function parseSaveId(value: string): string {
  if (!saveIdPattern.test(value)) throw notFound();
  return value;
}

function requiredRepository(
  repository: PreopenConfigurationChoicesRepository | undefined,
): PreopenConfigurationChoicesRepository {
  if (!repository) throw unavailable();
  return repository;
}

function notFound(): CommandError {
  return new CommandError(404, 'GAMEPLAY_RESOURCE_NOT_FOUND');
}

function unavailable(): CommandError {
  return new CommandError(503, 'PREOPEN_CONFIGURATION_CHOICES_UNAVAILABLE');
}

function sendReadError(
  error: unknown,
  reply: Readonly<{ status(code: number): { send(body: unknown): unknown } }>,
): unknown {
  if (error instanceof PreopenConfigurationChoicesError) {
    if (
      error.code ===
      PREOPEN_CONFIGURATION_CHOICES_ERROR_CODES.PREOPEN_EQUIPMENT_INSTALLATION_REQUIRED
    ) {
      const conflict = new CommandError(409, error.code);
      return reply.status(conflict.status).send(conflict.toBody());
    }
    const unavailableError = unavailable();
    return reply.status(unavailableError.status).send(unavailableError.toBody());
  }
  if (isCommandError(error)) return reply.status(error.status).send(error.toBody());
  const unavailableError = unavailable();
  return reply.status(unavailableError.status).send(unavailableError.toBody());
}
