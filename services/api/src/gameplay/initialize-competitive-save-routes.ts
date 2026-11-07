import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

import { JwtVerificationError, type JwtVerifier } from '../auth/jwt-verifier.js';
import type { PlayerRecord } from '../auth/trusted-command-context.js';
import { CommandError, isCommandError, type CanonicalCommandValue } from '../commands/command-contract.js';
import {
  INITIALIZE_COMPETITIVE_SAVE,
  InitializeCompetitiveSaveError,
  isBootstrapCommandId,
  parseInitializeCompetitiveSaveIntent,
  type InitializeCompetitiveSaveIntent,
  type JsonValue,
} from './initialize-competitive-save.js';

export const BOOTSTRAP_COMMAND_ENVELOPE_VERSION = 'd02-bootstrap-command/v1' as const;
export const INITIALIZE_COMPETITIVE_SAVE_ROUTE =
  '/bootstrap/actions/INITIALIZE_COMPETITIVE_SAVE' as const;

export type BootstrapWebIdentityResolver = (
  bearerToken: string,
) => Promise<Readonly<{ playerId: string }> | undefined>;

export type DurableBootstrapInitializer = Readonly<{
  durability: 'durable';
  initialize(input: Readonly<{
    actorPlayerId: string;
    aggregateScope: string;
    commandId: string;
    idempotencyKey: string;
    expectedVersion: number;
    requestFingerprint: string;
    intent: InitializeCompetitiveSaveIntent;
  }>): Promise<Readonly<{
    commandId: string;
    aggregateVersion: number;
    result: JsonValue;
  }>>;
}>;

export type TestBootstrapInitializer = Omit<DurableBootstrapInitializer, 'durability'> &
  Readonly<{ durability: 'test' }>;

type BootstrapCommandEnvelope = Readonly<{
  schemaVersion: typeof BOOTSTRAP_COMMAND_ENVELOPE_VERSION;
  commandId: string;
  idempotencyKey: string;
  commandType: typeof INITIALIZE_COMPETITIVE_SAVE;
  expectedVersion: number;
  payload: InitializeCompetitiveSaveIntent;
}>;

export function registerInitializeCompetitiveSaveRoutes(
  app: FastifyInstance,
  options: Readonly<{
    initializer: DurableBootstrapInitializer | TestBootstrapInitializer;
    resolveWebIdentity: BootstrapWebIdentityResolver;
    allowTestInitializer?: boolean;
  }>,
): void {
  if (options.initializer.durability !== 'durable' && options.allowTestInitializer !== true) {
    throw new Error('bootstrap initializer must be durable');
  }

  app.post<{ Body: unknown }>(INITIALIZE_COMPETITIVE_SAVE_ROUTE, async (request, reply) => {
    try {
      const token = webBearerToken(request.headers.authorization);
      const identity = await options.resolveWebIdentity(token);
      if (!identity?.playerId) throw new CommandError(403, 'INITIALIZE_COMPETITIVE_SAVE_FORBIDDEN');

      const envelope = parseBootstrapCommandEnvelope(request.body);
      const aggregateScope = bootstrapPlayerScope(identity.playerId);
      const requestFingerprint = hashBootstrapRequest(envelope, identity.playerId);
      const execution = await options.initializer.initialize({
        actorPlayerId: identity.playerId,
        aggregateScope,
        commandId: envelope.commandId,
        idempotencyKey: envelope.idempotencyKey,
        expectedVersion: envelope.expectedVersion,
        requestFingerprint,
        intent: envelope.payload,
      });
      if (execution.aggregateVersion !== envelope.expectedVersion + 1) {
        throw new CommandError(503, 'INITIALIZE_COMPETITIVE_SAVE_PERSISTENCE_INVALID');
      }
      return reply.status(200).send({
        commandId: execution.commandId,
        idempotencyKey: envelope.idempotencyKey,
        commandType: INITIALIZE_COMPETITIVE_SAVE,
        aggregateId: aggregateScope,
        aggregateVersion: execution.aggregateVersion,
        result: execution.result,
      });
    } catch (error) {
      if (isCommandError(error)) return reply.status(error.status).send(error.toBody());
      throw error;
    }
  });
}

export function createBootstrapWebIdentityResolver(options: Readonly<{
  jwtVerifier: JwtVerifier;
  repository: Readonly<{
    findPlayerByClerkSubject(subject: string): Promise<PlayerRecord | undefined>;
  }>;
}>): BootstrapWebIdentityResolver {
  return async (bearerToken) => {
    try {
      const verified = await options.jwtVerifier.verify(bearerToken);
      const player = await options.repository.findPlayerByClerkSubject(verified.subject);
      return player ? Object.freeze({ playerId: player.id }) : undefined;
    } catch (error) {
      if (error instanceof JwtVerificationError) {
        throw new CommandError(401, 'UNTRUSTED_COMMAND_CONTEXT');
      }
      throw error;
    }
  };
}

export function bootstrapPlayerScope(playerId: string): string {
  if (!playerId.trim()) throw new CommandError(403, 'INITIALIZE_COMPETITIVE_SAVE_FORBIDDEN');
  return `bootstrap-player:${playerId}`;
}

function webBearerToken(value: string | undefined): string {
  if (
    !value?.startsWith('Bearer ') ||
    value.includes(',') ||
    value.slice('Bearer '.length).includes(' ')
  ) {
    throw new CommandError(401, 'UNTRUSTED_COMMAND_CONTEXT');
  }
  const token = value.slice('Bearer '.length);
  if (!token) throw new CommandError(401, 'UNTRUSTED_COMMAND_CONTEXT');
  return token;
}

function parseBootstrapCommandEnvelope(input: unknown): BootstrapCommandEnvelope {
  if (!isRecord(input)) throw invalidEnvelope();
  const expectedKeys = [
    'commandId',
    'commandType',
    'expectedVersion',
    'idempotencyKey',
    'payload',
    'schemaVersion',
  ];
  const actualKeys = Object.keys(input).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index]) ||
    input.schemaVersion !== BOOTSTRAP_COMMAND_ENVELOPE_VERSION ||
    input.commandType !== INITIALIZE_COMPETITIVE_SAVE ||
    typeof input.commandId !== 'string' ||
    !isBootstrapCommandId(input.commandId) ||
    typeof input.idempotencyKey !== 'string' ||
    input.idempotencyKey.length < 1 ||
    input.idempotencyKey.length > 200 ||
    typeof input.expectedVersion !== 'number' ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 0
  ) {
    throw invalidEnvelope();
  }
  let payload: InitializeCompetitiveSaveIntent;
  try {
    payload = parseInitializeCompetitiveSaveIntent(input.payload);
  } catch (error) {
    if (error instanceof InitializeCompetitiveSaveError) throw invalidEnvelope();
    throw error;
  }
  return Object.freeze({
    schemaVersion: BOOTSTRAP_COMMAND_ENVELOPE_VERSION,
    commandId: input.commandId,
    idempotencyKey: input.idempotencyKey,
    commandType: INITIALIZE_COMPETITIVE_SAVE,
    expectedVersion: input.expectedVersion,
    payload,
  });
}

function hashBootstrapRequest(envelope: BootstrapCommandEnvelope, playerId: string): string {
  const canonical = canonicalize({
    request: {
      schemaVersion: envelope.schemaVersion,
      commandType: envelope.commandType,
      expectedVersion: envelope.expectedVersion,
      payload: envelope.payload,
    },
    trustedScope: { kind: 'bootstrap-player', playerId },
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function canonicalize(value: CanonicalCommandValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') return JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalize(nested)}`)
    .join(',')}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidEnvelope(): CommandError {
  return new CommandError(422, 'COMMAND_ENVELOPE_INVALID');
}
