import { createHash } from 'node:crypto';

import { createOpeningSnapshot } from '../domains/opening-scenario/snapshot.js';
import { MVP_OPENING_VERSIONS } from '../domains/opening-scenario/registry.js';
import {
  InitializeCompetitiveSaveError,
  type InitializeCompetitiveSaveIntent,
  type ServerBootstrapPlanFactory,
  type TrustedBootstrapContext,
} from './initialize-competitive-save.js';

const scenarios = new Set(['DEFAULT_SMALL_SHOP', 'TROUBLED_SHOP']);
const operatingModes = new Set(['STRATEGY', 'LIGHTWEIGHT_REALTIME']);
const servicePeriodPlans = new Set(['TWO_PERIODS', 'THREE_PERIODS']);

const storageByScenario = Object.freeze({
  EMPTY_PREMISES: Object.freeze({ kind: 'NONE', capacity: 0 }),
  DEFAULT_SMALL_SHOP: Object.freeze({ kind: 'BASIC', capacity: 305 }),
  TROUBLED_SHOP: Object.freeze({ kind: 'AGED', capacity: 255 }),
} as const);

/**
 * Production MVP bootstrap plan. Every identifier and seed is derived from the
 * trusted immutable command context with domain-separated hashes; client intent
 * can only select registered scenario/mode/currency/period-plan values.
 */
export const createMvpServerBootstrapPlan: ServerBootstrapPlanFactory = (context, intent) => {
  assertMvpBootstrapIntent(intent);
  const storage = storageByScenario[intent.scenario as keyof typeof storageByScenario];
  let openingSnapshot;
  try {
    openingSnapshot = createOpeningSnapshot(
      {
        scenario: intent.scenario,
        operatingMode: intent.operatingMode,
        currency: intent.settlementCurrency,
      },
      MVP_OPENING_VERSIONS,
    );
  } catch {
    throw invalidIntent();
  }
  const id = (kind: string) => deterministicUuid(kind, context);
  const seed = (kind: string) => domainHash(kind, context);
  return Object.freeze({
    epochId: id('epoch'),
    plan: Object.freeze({
      provisionedRestaurantId: id('restaurant'),
      restaurantName: `MVP Restaurant ${domainHash('display-name', context).slice(0, 8)}`,
      restaurantTimezone: 'UTC',
      ownerMembershipId: id('owner-membership'),
      saveId: id('competitive-save'),
      ownerAuditLogId: id('owner-audit'),
      mode: 'COMPETITIVE' as const,
      openingScenario: intent.scenario,
      operatingMode: intent.operatingMode,
      servicePeriodPlan: intent.servicePeriodPlan,
      difficultyGroup: 'STANDARD',
      demandSeed: seed('demand-seed'),
      simulationRuleVersion: openingSnapshot.simulationRuleVersion,
      openingSnapshot,
      openingSnapshotHash: openingSnapshot.openingSnapshotHash,
      marketSeedAuthority: Object.freeze({
        seed: seed('market-seed'),
        seedVersion: 'market-seed/v1',
      }),
      inventoryPoolAuthority: Object.freeze({
        revision: 1,
        storageBundleVersion: 'mvp-storage/v1',
        storageBundleKind: storage.kind,
        capacityPoints: Object.freeze({
          DURABLE: storage.capacity,
          PERISHABLE: storage.capacity,
        }),
      }),
    }),
  });
};

/**
 * Closed-beta production intentionally does not provision bare premises:
 * there is no durable equipment-install command in this milestone.  Keep this
 * assertion exported so the durable coordinator can reject the intent before
 * it opens a transaction or records a command receipt.
 */
export function assertMvpBootstrapIntent(intent: InitializeCompetitiveSaveIntent): void {
  if (
    !scenarios.has(intent.scenario) ||
    !operatingModes.has(intent.operatingMode) ||
    !servicePeriodPlans.has(intent.servicePeriodPlan) ||
    (intent.settlementCurrency !== 'TWD' && intent.settlementCurrency !== 'USD')
  ) {
    throw invalidIntent();
  }
}

function domainHash(kind: string, context: TrustedBootstrapContext): string {
  return createHash('sha256')
    .update(
      [
        'econ-game-mvp-bootstrap/v1',
        kind,
        context.actorPlayerId,
        context.authorityId,
        context.commandId,
        context.requestFingerprint,
        String(context.playerCommandVersion),
      ].join('\u0000'),
      'utf8',
    )
    .digest('hex');
}

function deterministicUuid(kind: string, context: TrustedBootstrapContext): string {
  const bytes = Buffer.from(domainHash(kind, context).slice(0, 32), 'hex');
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function invalidIntent(): InitializeCompetitiveSaveError {
  return new InitializeCompetitiveSaveError(422, 'INITIALIZE_COMPETITIVE_SAVE_INTENT_INVALID');
}
