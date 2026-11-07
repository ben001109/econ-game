import type { FastifyInstance, FastifyReply } from 'fastify';

import { ClosedBetaError, ClosedBetaService } from './closed-beta.js';

export function registerClosedBetaRoutes(
  app: FastifyInstance,
  service: ClosedBetaService | undefined,
  allowTestRepository = false,
): void {
  app.post<{ Params: { tenantId: string }; Body: unknown }>(
    '/closed-beta/tenants/:tenantId/cohorts',
    async (request, reply) => {
      try {
        const configured = requireConfigured(service, allowTestRepository);
        const body = exactBody(request.body, [
          'name',
          'purpose',
          'environment',
          'quota',
          'opensAt',
          'closesAt',
          'featureFlags',
          'eligibilityPolicyVersion',
          'eligibilityPolicyDigest',
        ]);
        const result = await configured.createCohort(
          bearerCredential(request.headers.authorization),
          request.params.tenantId,
          body,
          request.id,
        );
        return reply.status(201).send(result);
      } catch (error) {
        return closedBetaErrorReply(error, reply);
      }
    },
  );

  app.post<{ Params: { cohortId: string }; Body: unknown }>(
    '/closed-beta/cohorts/:cohortId/consent-policies',
    async (request, reply) => {
      try {
        const configured = requireConfigured(service, allowTestRepository);
        const body = exactBody(request.body, [
          'purpose',
          'version',
          'policyDigest',
          'scope',
          'dataCategories',
          'retentionDays',
          'requiredForEntry',
        ]);
        const result = await configured.createConsentPolicy(
          bearerCredential(request.headers.authorization),
          request.params.cohortId,
          body,
          request.id,
        );
        return reply.status(201).send(result);
      } catch (error) {
        return closedBetaErrorReply(error, reply);
      }
    },
  );

  app.post<{ Params: { cohortId: string }; Body: unknown }>(
    '/closed-beta/cohorts/:cohortId/open',
    async (request, reply) => {
      try {
        const configured = requireConfigured(service, allowTestRepository);
        const body = exactBody(request.body, ['entryConsentPolicyId']);
        await configured.openCohort(
          bearerCredential(request.headers.authorization),
          request.params.cohortId,
          requiredString(body.entryConsentPolicyId),
          request.id,
        );
        return reply.status(204).send();
      } catch (error) {
        return closedBetaErrorReply(error, reply);
      }
    },
  );

  for (const action of ['close', 'revoke'] as const) {
    app.post<{ Params: { cohortId: string }; Body: unknown }>(
      `/closed-beta/cohorts/:cohortId/${action}`,
      async (request, reply) => {
        try {
          emptyBody(request.body);
          await requireConfigured(service, allowTestRepository).closeCohort(
            bearerCredential(request.headers.authorization),
            request.params.cohortId,
            action,
            request.id,
          );
          return reply.status(204).send();
        } catch (error) {
          return closedBetaErrorReply(error, reply);
        }
      },
    );
  }

  app.post<{ Params: { cohortId: string }; Body: unknown }>(
    '/closed-beta/cohorts/:cohortId/invites',
    async (request, reply) => {
      try {
        const configured = requireConfigured(service, allowTestRepository);
        const body = exactBody(request.body, ['invitedPlayerId', 'ttlSeconds']);
        const result = await configured.createInvite(
          bearerCredential(request.headers.authorization),
          request.params.cohortId,
          body,
          request.id,
        );
        return reply.status(201).send(result);
      } catch (error) {
        return closedBetaErrorReply(error, reply);
      }
    },
  );

  for (const action of ['activate', 'revoke'] as const) {
    app.post<{ Params: { cohortId: string; inviteId: string }; Body: unknown }>(
      `/closed-beta/cohorts/:cohortId/invites/:inviteId/${action}`,
      async (request, reply) => {
        try {
          emptyBody(request.body);
          const configured = requireConfigured(service, allowTestRepository);
          const credential = bearerCredential(request.headers.authorization);
          if (action === 'activate') {
            await configured.activateInvite(
              credential,
              request.params.cohortId,
              request.params.inviteId,
              request.id,
            );
          } else {
            await configured.revokeInvite(
              credential,
              request.params.cohortId,
              request.params.inviteId,
              request.id,
            );
          }
          return reply.status(204).send();
        } catch (error) {
          return closedBetaErrorReply(error, reply);
        }
      },
    );
  }

  app.post<{ Body: unknown }>('/closed-beta/invites/redeem', async (request, reply) => {
    try {
      const body = exactBody(request.body, ['token']);
      await requireConfigured(service, allowTestRepository).redeemInvite(
        bearerCredential(request.headers.authorization),
        requiredString(body.token),
        request.id,
      );
      return reply.status(204).send();
    } catch (error) {
      return closedBetaErrorReply(error, reply);
    }
  });

  for (const decision of ['accept', 'withdraw'] as const) {
    app.post<{ Params: { policyId: string }; Body: unknown }>(
      `/closed-beta/consent-policies/:policyId/${decision}`,
      async (request, reply) => {
        try {
          emptyBody(request.body);
          await requireConfigured(service, allowTestRepository).decideConsent(
            bearerCredential(request.headers.authorization),
            request.params.policyId,
            decision === 'accept' ? 'ACCEPTED' : 'WITHDRAWN',
            request.id,
          );
          return reply.status(204).send();
        } catch (error) {
          return closedBetaErrorReply(error, reply);
        }
      },
    );
  }

  app.post<{ Params: { cohortId: string; playerId: string }; Body: unknown }>(
    '/closed-beta/cohorts/:cohortId/members/:playerId/revoke',
    async (request, reply) => {
      try {
        const body = exactBody(request.body, ['reason']);
        await requireConfigured(service, allowTestRepository).revokeMembership(
          bearerCredential(request.headers.authorization),
          request.params.cohortId,
          request.params.playerId,
          requiredString(body.reason),
          request.id,
        );
        return reply.status(204).send();
      } catch (error) {
        return closedBetaErrorReply(error, reply);
      }
    },
  );

  app.get<{ Params: { tenantId: string } }>(
    '/closed-beta/tenants/:tenantId/eligibility',
    async (request, reply) => {
      try {
        const eligible = await requireConfigured(
          service,
          allowTestRepository,
        ).isAuthenticatedPlayerEligible(
          bearerCredential(request.headers.authorization),
          request.params.tenantId,
        );
        return reply.status(200).send({ eligible });
      } catch (error) {
        return closedBetaErrorReply(error, reply);
      }
    },
  );

  app.post<{ Params: { cohortId: string }; Body: unknown }>(
    '/closed-beta/cohorts/:cohortId/reward-eligibility/decisions',
    async (request, reply) => {
      try {
        const body = exactBody(request.body, [
          'supersedesEligibilityId',
          'eligible',
          'source',
          'reason',
        ]);
        await requireConfigured(service, allowTestRepository).recordOwnerRewardDecision(
          bearerCredential(request.headers.authorization),
          request.params.cohortId,
          body,
          request.id,
        );
        return reply.status(204).send();
      } catch (error) {
        return closedBetaErrorReply(error, reply);
      }
    },
  );
}

function requireConfigured(
  service: ClosedBetaService | undefined,
  allowTestRepository: boolean,
): ClosedBetaService {
  if (!service || (!allowTestRepository && !service.isDurable())) {
    throw new ClosedBetaError(503, 'CLOSED_BETA_NOT_CONFIGURED');
  }
  return service;
}

function bearerCredential(value: string | undefined): string {
  if (
    !value?.startsWith('Bearer ') ||
    value.includes(',') ||
    value.slice('Bearer '.length).includes(' ')
  ) {
    throw new ClosedBetaError(401, 'CLOSED_BETA_AUTHENTICATION_REQUIRED');
  }
  const token = value.slice('Bearer '.length);
  if (!token) throw new ClosedBetaError(401, 'CLOSED_BETA_AUTHENTICATION_REQUIRED');
  return token;
}

function exactBody(input: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) invalidRequest();
  const record = input as Readonly<Record<string, unknown>>;
  const actual = Object.keys(record);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) invalidRequest();
  return record;
}

function emptyBody(input: unknown): void {
  if (input === undefined || input === null) return;
  if (typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 0) {
    invalidRequest();
  }
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4_096) invalidRequest();
  return value;
}

function invalidRequest(): never {
  throw new ClosedBetaError(422, 'CLOSED_BETA_REQUEST_INVALID');
}

function closedBetaErrorReply(error: unknown, reply: FastifyReply) {
  if (!(error instanceof ClosedBetaError)) throw error;
  return reply.status(error.status).send({
    error: { version: 'd05-closed-beta-error/v1', code: error.code },
  });
}
