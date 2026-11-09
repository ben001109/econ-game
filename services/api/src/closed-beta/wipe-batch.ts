import { createHash, randomUUID } from 'node:crypto';

import { JwtVerificationError, type JwtVerifier } from '../auth/jwt-verifier.js';
import type { PlayerRecord } from '../auth/trusted-command-context.js';
import {
  CommandError,
  hashCommandRequest,
  parseCommandEnvelope,
  type CanonicalCommandValue,
  type CommandEnvelope,
} from '../commands/command-contract.js';

export const WIPE_SCOPE_VERSION = 'd05-wipe-scope/v2' as const;
export const WIPE_POLICY_VERSION = 'd05-complete-non-historical-save-clear/v1' as const;

const POLICY = Object.freeze({
  version: WIPE_POLICY_VERSION,
  isolationDays: 30,
  clearAfter30Days: Object.freeze(['MenuSelection', 'OrderItem', 'Payment', 'TaxLine', 'Tip']),
  tombstone: Object.freeze([
    'CompetitiveSave',
    'Employee',
    'InventoryStock',
    'Order',
    'Player',
    'RestaurantMembership',
  ]),
  unknownFamily: 'RETAIN',
  externalClerkEffect: 'NONE',
});

export type WipeSaveCandidate = Readonly<{
  id: string;
  version: number;
  openingSnapshotHash: string;
}>;

export type WipePreview = Readonly<{
  restaurantId: string;
  environment: string;
  scopeVersion: typeof WIPE_SCOPE_VERSION;
  scopeHash: string;
  policyVersion: typeof WIPE_POLICY_VERSION;
  policyHash: string;
  manifest: Readonly<Record<string, CanonicalCommandValue>>;
  manifestHash: string;
  saves: readonly WipeSaveCandidate[];
}>;

export type WipeCommandExecution = Readonly<{
  commandId: string;
  aggregateVersion: number;
  result: Readonly<Record<string, CanonicalCommandValue>>;
}>;

export type WipeCommandInput = Readonly<{
  actorPlayerId: string;
  restaurantId: string;
  command: CommandEnvelope;
  requestFingerprint: string;
  correlationId: string;
  generatedBatchId: string;
  generatedAuditId: string;
  generatedCheckpointId: string;
}>;

export type WipeBatchStatusView = Readonly<{
  id: string;
  restaurantId: string;
  aggregateVersion: number;
  lifecyclePhase: 'FROZEN' | 'ISOLATED' | 'CLEARED' | 'VERIFIED' | null;
  requestedByPlayerId: string;
  approvedByPlayerId: string | null;
  scopeHash: string;
  policyVersion: string;
  policyHash: string;
  dryRunManifestHash: string;
  frozenAt: Date | null;
  isolatedAt: Date | null;
  clearEligibleAt: Date | null;
}>;

export interface WipeBatchRepository {
  readonly durability: 'durable' | 'test';
  findPlayerByClerkSubject(subject: string): Promise<PlayerRecord | undefined>;
  preview(actorPlayerId: string, restaurantId: string): Promise<WipePreview>;
  request(input: WipeCommandInput): Promise<WipeCommandExecution>;
  approve(input: WipeCommandInput): Promise<WipeCommandExecution>;
  freeze(input: WipeCommandInput): Promise<WipeCommandExecution>;
  isolate(input: WipeCommandInput): Promise<WipeCommandExecution>;
  resume(input: WipeCommandInput): Promise<WipeCommandExecution>;
  status(
    actorPlayerId: string,
    restaurantId: string,
    batchId: string,
  ): Promise<WipeBatchStatusView>;
  assertSaveMutationAllowed(
    actorPlayerId: string,
    restaurantId: string,
    saveId: string,
  ): Promise<void>;
}

export class WipeBatchService {
  private readonly randomId: () => string;

  constructor(
    private readonly options: Readonly<{
      jwtVerifier: JwtVerifier;
      repository: WipeBatchRepository;
      randomId?: () => string;
    }>,
  ) {
    this.randomId = options.randomId ?? randomUUID;
  }

  isDurable(): boolean {
    return this.options.repository.durability === 'durable';
  }

  async dryRun(token: string, restaurantId: string, envelope: unknown) {
    const actor = await this.authenticate(token);
    const command = wipeCommand(envelope, 'WIPE_DRY_RUN', restaurantId, []);
    if (command.expectedVersion !== 0) versionConflict(0, command.expectedVersion);
    const preview = await this.options.repository.preview(actor.id, restaurantId);
    return commandResponse(command, {
      commandId: command.commandId,
      aggregateVersion: 0,
      result: previewResult(preview),
    });
  }

  async request(token: string, restaurantId: string, envelope: unknown, correlationId: string) {
    return this.execute(
      token,
      restaurantId,
      undefined,
      envelope,
      'WIPE_REQUEST',
      ['reason', 'dryRunManifestHash'],
      correlationId,
      (input) => this.options.repository.request(input),
    );
  }

  async approve(
    token: string,
    restaurantId: string,
    batchId: string,
    envelope: unknown,
    correlationId: string,
  ) {
    return this.execute(
      token,
      restaurantId,
      batchId,
      envelope,
      'WIPE_APPROVE',
      [],
      correlationId,
      (input) => this.options.repository.approve(input),
    );
  }

  async freeze(
    token: string,
    restaurantId: string,
    batchId: string,
    envelope: unknown,
    correlationId: string,
  ) {
    return this.execute(
      token,
      restaurantId,
      batchId,
      envelope,
      'WIPE_FREEZE',
      [],
      correlationId,
      (input) => this.options.repository.freeze(input),
    );
  }

  async isolate(
    token: string,
    restaurantId: string,
    batchId: string,
    envelope: unknown,
    correlationId: string,
  ) {
    return this.execute(
      token,
      restaurantId,
      batchId,
      envelope,
      'WIPE_ISOLATE',
      [],
      correlationId,
      (input) => this.options.repository.isolate(input),
    );
  }

  async resume(
    token: string,
    restaurantId: string,
    batchId: string,
    envelope: unknown,
    correlationId: string,
  ) {
    return this.execute(
      token,
      restaurantId,
      batchId,
      envelope,
      'WIPE_RESUME',
      [],
      correlationId,
      (input) => this.options.repository.resume(input),
    );
  }

  async status(token: string, restaurantId: string, batchId: string) {
    const actor = await this.authenticate(token);
    validateIdentifier(restaurantId);
    validateIdentifier(batchId);
    const status = await this.options.repository.status(actor.id, restaurantId, batchId);
    return Object.freeze({
      ...status,
      frozenAt: status.frozenAt?.toISOString() ?? null,
      isolatedAt: status.isolatedAt?.toISOString() ?? null,
      clearEligibleAt: status.clearEligibleAt?.toISOString() ?? null,
    });
  }

  assertSaveMutationAllowed(actorPlayerId: string, restaurantId: string, saveId: string) {
    validateIdentifier(actorPlayerId);
    validateIdentifier(restaurantId);
    validateIdentifier(saveId);
    return this.options.repository.assertSaveMutationAllowed(actorPlayerId, restaurantId, saveId);
  }

  private async execute(
    token: string,
    restaurantId: string,
    batchId: string | undefined,
    envelope: unknown,
    commandType: string,
    payloadKeys: readonly string[],
    correlationId: string,
    operation: (input: WipeCommandInput) => Promise<WipeCommandExecution>,
  ) {
    const actor = await this.authenticate(token);
    validateIdentifier(restaurantId);
    const aggregateId = batchId ?? restaurantId;
    if (batchId) validateIdentifier(batchId);
    const command = wipeCommand(envelope, commandType, aggregateId, payloadKeys);
    if (commandType === 'WIPE_REQUEST') {
      if (command.expectedVersion !== 0) versionConflict(0, command.expectedVersion);
      boundedString(command.payload.reason, 500);
      digest(command.payload.dryRunManifestHash);
    }
    const execution = await operation({
      actorPlayerId: actor.id,
      restaurantId,
      command,
      requestFingerprint: hashCommandRequest(command, {
        actorId: actor.id,
        tenantId: restaurantId,
        saveId: aggregateId,
      }),
      correlationId: boundedString(correlationId, 500),
      generatedBatchId: this.randomId(),
      generatedAuditId: this.randomId(),
      generatedCheckpointId: this.randomId(),
    });
    return commandResponse(command, execution);
  }

  private async authenticate(token: string): Promise<PlayerRecord> {
    if (!token || token.includes(' ') || token.length > 16_384) {
      throw new CommandError(401, 'WIPE_AUTHENTICATION_REQUIRED');
    }
    try {
      const identity = await this.options.jwtVerifier.verify(token);
      const player = await this.options.repository.findPlayerByClerkSubject(identity.subject);
      if (!player) throw new CommandError(403, 'WIPE_SCOPE_FORBIDDEN');
      return player;
    } catch (error) {
      if (error instanceof JwtVerificationError) {
        throw new CommandError(401, 'WIPE_AUTHENTICATION_REQUIRED');
      }
      throw error;
    }
  }
}

export function buildWipePreview(
  restaurantId: string,
  candidates: readonly WipeSaveCandidate[],
  environment: string,
): WipePreview {
  validateIdentifier(restaurantId);
  boundedString(environment, 100);
  const saves = Object.freeze(
    [...candidates]
      .map((entry) =>
        Object.freeze({ ...entry, openingSnapshotHash: digest(entry.openingSnapshotHash) }),
      )
      .sort((left, right) => left.id.localeCompare(right.id)),
  );
  const policyHash = sha256(canonicalJson(POLICY));
  const scope = Object.freeze({
    version: WIPE_SCOPE_VERSION,
    restaurantId,
    environment,
    saves: saves.map(({ id, version }) => ({ id, version })),
  });
  const scopeHash = sha256(canonicalJson(scope));
  const manifest = Object.freeze({
    version: 'd05-wipe-manifest/v1',
    scopeHash,
    policyHash,
    saveCount: saves.length,
    saves: saves.map(({ id, version, openingSnapshotHash }) => ({
      id,
      version,
      openingSnapshotHash,
    })),
  }) as Readonly<Record<string, CanonicalCommandValue>>;
  return Object.freeze({
    restaurantId,
    environment,
    scopeVersion: WIPE_SCOPE_VERSION,
    scopeHash,
    policyVersion: WIPE_POLICY_VERSION,
    policyHash,
    manifest,
    manifestHash: sha256(canonicalJson(manifest)),
    saves,
  });
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new CommandError(422, 'WIPE_REQUEST_INVALID');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value !== 'object') throw new CommandError(422, 'WIPE_REQUEST_INVALID');
  return `{${Object.entries(value as Readonly<Record<string, unknown>>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
    .join(',')}}`;
}

export const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

function wipeCommand(
  input: unknown,
  type: string,
  aggregateId: string,
  payloadKeys: readonly string[],
) {
  validateIdentifier(aggregateId);
  const command = parseCommandEnvelope(input);
  if (command.commandType !== type) throw new CommandError(422, 'COMMAND_TARGET_MISMATCH');
  if (command.aggregateId !== aggregateId) throw new CommandError(422, 'COMMAND_SCOPE_MISMATCH');
  const keys = Object.keys(command.payload);
  if (keys.length !== payloadKeys.length || keys.some((key) => !payloadKeys.includes(key))) {
    throw new CommandError(422, 'WIPE_REQUEST_INVALID');
  }
  return command;
}

function commandResponse(command: CommandEnvelope, execution: WipeCommandExecution) {
  return Object.freeze({
    commandId: execution.commandId,
    idempotencyKey: command.idempotencyKey,
    commandType: command.commandType,
    aggregateId: command.aggregateId,
    aggregateVersion: execution.aggregateVersion,
    result: execution.result,
  });
}

function previewResult(preview: WipePreview): Readonly<Record<string, CanonicalCommandValue>> {
  return Object.freeze({
    environment: preview.environment,
    scopeVersion: preview.scopeVersion,
    scopeHash: preview.scopeHash,
    policyVersion: preview.policyVersion,
    policyHash: preview.policyHash,
    manifest: preview.manifest,
    manifestHash: preview.manifestHash,
  });
}

function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new CommandError(422, 'WIPE_REQUEST_INVALID');
  }
  return value;
}

function boundedString(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value || value.length > maximum) {
    throw new CommandError(422, 'WIPE_REQUEST_INVALID');
  }
  return value;
}

function validateIdentifier(value: string): void {
  if (!value || value.length > 200 || [...value].some((entry) => entry.charCodeAt(0) <= 31)) {
    throw new CommandError(422, 'WIPE_REQUEST_INVALID');
  }
}

function versionConflict(actualVersion: number, expectedVersion: number): never {
  throw new CommandError(409, 'EXPECTED_VERSION_CONFLICT', { actualVersion, expectedVersion });
}

export const wipePreviewResult = previewResult;
