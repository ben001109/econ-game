import assert from 'node:assert/strict';
import test from 'node:test';

import { createApiComposition } from '../app-composition.js';
import { COMMAND_ENVELOPE_VERSION, CommandError } from '../commands/command-contract.js';
import {
  WipeBatchService,
  buildWipePreview,
  type WipeBatchRepository,
  type WipeBatchStatusView,
  type WipeCommandExecution,
  type WipeCommandInput,
} from './wipe-batch.js';

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

class FakeWipeRepository implements WipeBatchRepository {
  readonly durability = 'test' as const;
  readonly calls: string[] = [];
  previewValue = buildWipePreview(
    'tenant-1',
    [
      { id: 'save-b', version: 2, openingSnapshotHash: DIGEST_B },
      { id: 'save-a', version: 1, openingSnapshotHash: DIGEST_A },
    ],
    'fixture',
  );

  async findPlayerByClerkSubject(subject: string) {
    if (subject === 'owner-1' || subject === 'owner-2') {
      return { id: subject, clerkUserId: subject };
    }
    return undefined;
  }

  async preview(actorPlayerId: string, restaurantId: string) {
    this.calls.push(`preview:${actorPlayerId}:${restaurantId}`);
    if (restaurantId !== 'tenant-1') throw new CommandError(403, 'WIPE_SCOPE_FORBIDDEN');
    return this.previewValue;
  }

  request(input: WipeCommandInput) {
    this.calls.push('request');
    return result(input, 1, { batchId: 'batch-1' });
  }
  approve(input: WipeCommandInput) {
    this.calls.push(`approve:${input.actorPlayerId}`);
    if (input.actorPlayerId === 'owner-1') {
      return Promise.reject(new CommandError(409, 'WIPE_DISTINCT_APPROVER_REQUIRED'));
    }
    return result(input, 2, { batchId: 'batch-1', phase: 'APPROVED' });
  }
  freeze(input: WipeCommandInput) {
    this.calls.push('freeze');
    return result(input, 3, { batchId: 'batch-1', phase: 'FROZEN' });
  }
  isolate(input: WipeCommandInput) {
    this.calls.push('isolate');
    return result(input, 4, { batchId: 'batch-1', phase: 'ISOLATED' });
  }
  resume(input: WipeCommandInput) {
    this.calls.push('resume');
    return result(input, 4, { batchId: 'batch-1', phase: 'ISOLATED' });
  }
  async status(actorPlayerId: string, restaurantId: string, batchId: string) {
    if (restaurantId !== 'tenant-1' || batchId !== 'batch-1') {
      throw new CommandError(403, 'WIPE_SCOPE_FORBIDDEN');
    }
    return {
      id: batchId,
      restaurantId,
      aggregateVersion: 3,
      lifecyclePhase: 'FROZEN',
      requestedByPlayerId: 'owner-1',
      approvedByPlayerId: 'owner-2',
      scopeHash: DIGEST_A,
      policyVersion: 'policy-v1',
      policyHash: DIGEST_B,
      dryRunManifestHash: DIGEST_A,
      frozenAt: new Date('2030-01-01T00:00:00.000Z'),
      isolatedAt: null,
      clearEligibleAt: null,
    } satisfies WipeBatchStatusView;
  }
  async assertSaveMutationAllowed() {}
}

const verifier = {
  async verify(token: string) {
    return {
      subject: token,
      issuer: 'test',
      audience: ['api'],
      authorizedParty: 'test',
      expiresAt: 2_000_000_000,
    };
  },
};

function result(
  input: WipeCommandInput,
  aggregateVersion: number,
  value: Record<string, string>,
): Promise<WipeCommandExecution> {
  return Promise.resolve({
    commandId: input.command.commandId,
    aggregateVersion,
    result: value,
  });
}

let commandSequence = 0;
function command(
  commandType: string,
  aggregateId: string,
  expectedVersion: number,
  payload: Record<string, unknown> = {},
) {
  commandSequence += 1;
  return {
    schemaVersion: COMMAND_ENVELOPE_VERSION,
    commandId: `11111111-1111-4111-8111-${String(commandSequence).padStart(12, '0')}`,
    idempotencyKey: `wipe-key-${commandSequence}`,
    commandType,
    aggregateId,
    expectedVersion,
    payload,
  };
}

test('preview is byte-stable and independent of database input ordering', () => {
  const left = buildWipePreview(
    'tenant-1',
    [
      { id: 'save-b', version: 2, openingSnapshotHash: DIGEST_B },
      { id: 'save-a', version: 1, openingSnapshotHash: DIGEST_A },
    ],
    'fixture',
  );
  const right = buildWipePreview('tenant-1', [...left.saves].reverse(), 'fixture');
  assert.deepEqual(left, right);
  assert.deepEqual(
    left.saves.map(({ id }) => id),
    ['save-a', 'save-b'],
  );
  assert.equal(left.policyHash.length, 64);
  assert.equal(left.manifestHash.length, 64);
});

test('dry-run is authenticated, exact, non-mutating, and rejects client scope fields', async () => {
  const repository = new FakeWipeRepository();
  const service = new WipeBatchService({ jwtVerifier: verifier, repository });
  const response = await service.dryRun(
    'owner-1',
    'tenant-1',
    command('WIPE_DRY_RUN', 'tenant-1', 0),
  );
  assert.equal(response.aggregateVersion, 0);
  assert.equal(repository.calls.join(','), 'preview:owner-1:tenant-1');

  await assert.rejects(
    service.dryRun(
      'owner-1',
      'tenant-1',
      command('WIPE_DRY_RUN', 'tenant-1', 0, { saveId: 'client-save' }),
    ),
    (error: unknown) =>
      error instanceof CommandError && error.code === 'CLIENT_CONTEXT_FIELD_FORBIDDEN',
  );
});

test('routes fail closed, use D02 errors, and keep tenant/batch targets bound', async () => {
  const unavailable = createApiComposition();
  const unavailableResponse = await unavailable.inject({
    method: 'POST',
    url: '/closed-beta/tenants/tenant-1/wipe-batches/dry-run',
    headers: { authorization: 'Bearer owner-1' },
    payload: command('WIPE_DRY_RUN', 'tenant-1', 0),
  });
  assert.equal(unavailableResponse.statusCode, 503);
  assert.equal(unavailableResponse.json().error.version, 'd02-command-error/v1');
  await unavailable.close();

  const repository = new FakeWipeRepository();
  const app = createApiComposition({
    testOnlyWipeBatchService: new WipeBatchService({ jwtVerifier: verifier, repository }),
  });
  const mismatch = await app.inject({
    method: 'POST',
    url: '/closed-beta/tenants/tenant-1/wipe-batches/batch-1/freeze',
    headers: { authorization: 'Bearer owner-2' },
    payload: command('WIPE_FREEZE', 'other-batch', 2),
  });
  assert.equal(mismatch.statusCode, 422);
  assert.equal(mismatch.json().error.code, 'COMMAND_SCOPE_MISMATCH');

  const hidden = await app.inject({
    method: 'GET',
    url: '/closed-beta/tenants/tenant-2/wipe-batches/batch-1',
    headers: { authorization: 'Bearer owner-2' },
  });
  assert.equal(hidden.statusCode, 403);
  assert.equal(hidden.json().error.code, 'WIPE_SCOPE_FORBIDDEN');
  await app.close();
});

test('distinct approval and expected versions remain stable command errors', async () => {
  const repository = new FakeWipeRepository();
  const service = new WipeBatchService({ jwtVerifier: verifier, repository });
  await assert.rejects(
    service.approve(
      'owner-1',
      'tenant-1',
      'batch-1',
      command('WIPE_APPROVE', 'batch-1', 1),
      'correlation-1',
    ),
    (error: unknown) =>
      error instanceof CommandError && error.code === 'WIPE_DISTINCT_APPROVER_REQUIRED',
  );
  await assert.rejects(
    service.request(
      'owner-1',
      'tenant-1',
      command('WIPE_REQUEST', 'tenant-1', 1, {
        reason: 'closed beta complete',
        dryRunManifestHash: DIGEST_A,
      }),
      'correlation-2',
    ),
    (error: unknown) => error instanceof CommandError && error.code === 'EXPECTED_VERSION_CONFLICT',
  );
});
