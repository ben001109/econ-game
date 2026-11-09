import type { FastifyInstance, FastifyReply } from 'fastify';

import { DiscordIdentityLinkService, IdentityLinkError } from './discord-identity-link.js';

export function registerDiscordIdentityLinkRoutes(
  app: FastifyInstance,
  service: DiscordIdentityLinkService | undefined,
  allowTestRepository = false,
): void {
  app.post<{ Body: unknown }>('/identity/discord/challenges', async (request, reply) => {
    try {
      const configured = requireConfiguredService(service, allowTestRepository);
      const body = exactStringBody(request.body, ['discordUserId', 'correlationId']);
      const credential = authorizationCredential(request.headers.authorization, 'Bot');
      const challenge = await configured.createChallenge({
        botCredential: credential,
        discordUserId: body.discordUserId,
        correlationId: body.correlationId,
      });
      return reply.status(201).send(challenge);
    } catch (error) {
      return identityErrorReply(error, reply);
    }
  });

  app.post<{ Body: unknown }>('/identity/discord/links', async (request, reply) => {
    try {
      const configured = requireConfiguredService(service, allowTestRepository);
      const body = stringBodyWithOptional(
        request.body,
        ['challengeToken', 'discordOAuthProof'],
        ['reauthenticationProof'],
      );
      const result = await configured.confirmLink({
        clerkJwt: authorizationCredential(request.headers.authorization, 'Bearer'),
        challengeToken: body.challengeToken,
        discordOAuthProof: body.discordOAuthProof,
        ...(body.reauthenticationProof
          ? { reauthenticationProof: body.reauthenticationProof }
          : {}),
      });
      return reply.status(200).send({ status: result });
    } catch (error) {
      return identityErrorReply(error, reply);
    }
  });

  app.delete<{ Body: unknown }>('/identity/discord/link', async (request, reply) => {
    return revokeRoute(
      request.headers.authorization,
      request.body,
      reply,
      service,
      allowTestRepository,
      'unlink',
    );
  });

  app.post<{ Body: unknown }>('/identity/discord/link/revoke', async (request, reply) => {
    return revokeRoute(
      request.headers.authorization,
      request.body,
      reply,
      service,
      allowTestRepository,
      'revoke',
    );
  });
}

function requireConfiguredService(
  service: DiscordIdentityLinkService | undefined,
  allowTestRepository: boolean,
): DiscordIdentityLinkService {
  if (!service || (!allowTestRepository && !service.isDurable())) {
    throw new IdentityLinkError(503, 'IDENTITY_SECURITY_NOT_CONFIGURED');
  }
  return service;
}

async function revokeRoute(
  authorization: string | undefined,
  input: unknown,
  reply: FastifyReply,
  service: DiscordIdentityLinkService | undefined,
  allowTestRepository: boolean,
  action: 'unlink' | 'revoke',
) {
  try {
    const configured = requireConfiguredService(service, allowTestRepository);
    const body = exactStringBody(input, ['reauthenticationProof', 'correlationId']);
    const method =
      action === 'unlink' ? configured.unlink.bind(configured) : configured.revoke.bind(configured);
    const result = await method({
      clerkJwt: authorizationCredential(authorization, 'Bearer'),
      reauthenticationProof: body.reauthenticationProof,
      correlationId: body.correlationId,
    });
    return reply.status(200).send({ status: result });
  } catch (error) {
    return identityErrorReply(error, reply);
  }
}

function authorizationCredential(value: string | undefined, scheme: 'Bearer' | 'Bot'): string {
  const prefix = `${scheme} `;
  if (
    !value?.startsWith(prefix) ||
    value.includes(',') ||
    value.slice(prefix.length).includes(' ')
  ) {
    throw new IdentityLinkError(401, 'IDENTITY_AUTHENTICATION_REQUIRED');
  }
  const credential = value.slice(prefix.length);
  if (!credential) throw new IdentityLinkError(401, 'IDENTITY_AUTHENTICATION_REQUIRED');
  return credential;
}

function exactStringBody<T extends readonly string[]>(
  input: unknown,
  keys: T,
): Record<T[number], string> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new IdentityLinkError(422, 'IDENTITY_REQUEST_INVALID');
  }
  const record = input as Record<string, unknown>;
  if (
    Object.keys(record).length !== keys.length ||
    Object.keys(record).some((key) => !keys.includes(key)) ||
    keys.some(
      (key) => typeof record[key] !== 'string' || !record[key] || record[key].length > 4_096,
    )
  ) {
    throw new IdentityLinkError(422, 'IDENTITY_REQUEST_INVALID');
  }
  return record as Record<T[number], string>;
}

function stringBodyWithOptional<R extends readonly string[], O extends readonly string[]>(
  input: unknown,
  required: R,
  optional: O,
): Record<R[number], string> & Partial<Record<O[number], string>> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new IdentityLinkError(422, 'IDENTITY_REQUEST_INVALID');
  }
  const record = input as Record<string, unknown>;
  const allowed = [...required, ...optional] as string[];
  if (
    Object.keys(record).some((key) => !allowed.includes(key)) ||
    required.some(
      (key) => typeof record[key] !== 'string' || !record[key] || record[key].length > 4_096,
    ) ||
    optional.some(
      (key) =>
        record[key] !== undefined &&
        (typeof record[key] !== 'string' || !record[key] || record[key].length > 4_096),
    )
  ) {
    throw new IdentityLinkError(422, 'IDENTITY_REQUEST_INVALID');
  }
  return record as Record<R[number], string> & Partial<Record<O[number], string>>;
}

function identityErrorReply(error: unknown, reply: FastifyReply) {
  if (!(error instanceof IdentityLinkError)) throw error;
  return reply.status(error.status).send({
    error: { version: 'd04-identity-error/v1', code: error.code },
  });
}
