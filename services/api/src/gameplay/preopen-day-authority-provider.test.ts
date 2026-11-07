import assert from 'node:assert/strict';
import test from 'node:test';

import { MVP_FIRST_DAY_CATALOG_VERSIONS } from '../domains/inventory-procurement/mvp-first-day-catalog.js';
import {
  calculateOpeningSnapshotHash,
  createOpeningSnapshot,
  type OpeningSnapshot,
} from '../domains/opening-scenario/snapshot.js';
import { MVP_OPENING_VERSIONS } from '../domains/opening-scenario/registry.js';
import {
  MVP_FIRST_DAY_MARKET_SEED_VERSION,
  provideCanonicalFirstDayPreopenArtifacts,
  type CanonicalFirstDayPreopenAuthorityInput,
} from './preopen-day-authority-provider.js';
import { parseConfigurePreopenDayIntent } from './preopen-day-contract.js';
import { createPreopenDayPlan } from './preopen-day-plan.js';

const COMMAND_ID = '11111111-1111-4111-8111-111111111111';

function openingSnapshot(
  scenario: 'DEFAULT_SMALL_SHOP' | 'EMPTY_PREMISES' = 'DEFAULT_SMALL_SHOP',
): OpeningSnapshot {
  return createOpeningSnapshot(
    { scenario, operatingMode: 'STRATEGY', currency: 'TWD' },
    MVP_OPENING_VERSIONS,
  );
}

function authority(
  scenario: 'DEFAULT_SMALL_SHOP' | 'EMPTY_PREMISES' = 'DEFAULT_SMALL_SHOP',
): CanonicalFirstDayPreopenAuthorityInput {
  const snapshot = openingSnapshot(scenario);
  const noStorage = scenario === 'EMPTY_PREMISES';
  const capacity = noStorage ? 0 : 305;
  const bundleKind = noStorage ? 'NONE' : 'BASIC';
  return {
    command: {
      commandId: COMMAND_ID,
      preopenSnapshotId: 'preopen-snapshot-1',
      businessDay: 1,
      currentLayoutRevision: 0,
    },
    save: {
      id: 'save-1',
      scenario,
      operatingMode: 'STRATEGY',
      servicePeriodPlan: 'TWO_PERIODS',
      demandSeed: 'server-demand-seed-1',
      simulationRuleVersion: snapshot.simulationRuleVersion,
      settlementCurrency: 'TWD',
      openingSnapshot: snapshot,
      openingSnapshotHash: snapshot.openingSnapshotHash,
    },
    marketSeedAuthority: {
      saveId: 'save-1',
      seed: 'independent-market-seed-1',
      seedVersion: MVP_FIRST_DAY_MARKET_SEED_VERSION,
    },
    inventoryPoolAuthorities: [
      {
        saveId: 'save-1',
        pool: 'DURABLE',
        revision: 1,
        capacityPoints: capacity,
        storageBundleVersion: 'mvp-storage/v1',
        storageBundleKind: bundleKind,
      },
      {
        saveId: 'save-1',
        pool: 'PERISHABLE',
        revision: 1,
        capacityPoints: capacity,
        storageBundleVersion: 'mvp-storage/v1',
        storageBundleKind: bundleKind,
      },
    ],
    spotPurchaseIdFactory: {
      create: ({ commandId, preopenSnapshotId, saveId, ingredientId }) => ({
        transactionId: `${commandId}:${preopenSnapshotId}:${saveId}:inventory:${ingredientId}`,
        purchaseId: `${commandId}:${preopenSnapshotId}:${saveId}:purchase:${ingredientId}`,
      }),
    },
  };
}

function configureIntent() {
  return parseConfigurePreopenDayIntent({
    menuChoice: {
      themeId: 'bistro',
      recipeVersionIds: [
        'bistro-chicken-rice-v1',
        'bistro-greens-rice-v1',
        'bistro-herb-chicken-v1',
      ],
      priceModifierPercentByRecipe: {
        'bistro-chicken-rice-v1': 0,
        'bistro-greens-rice-v1': -1,
        'bistro-herb-chicken-v1': 1,
      },
      enabledSubstitutionIds: ['bistro-chicken-rice-greens-v1'],
    },
    floorPlan: {
      width: 10,
      height: 9,
      servicePoint: { x: 0, y: 0 },
      fixtures: [
        { fixtureId: 'walkway-1', kind: 'WALKWAY', x: 1, y: 0 },
        { fixtureId: 'seat-1', kind: 'SEAT', x: 2, y: 0 },
        { fixtureId: 'waiting-1', kind: 'WAITING_ZONE', x: 1, y: 1 },
      ],
    },
    spotPurchaseDeltas: [{ ingredientId: 'bistro-rice', quantityPoints: 2 }],
  });
}

test('provider resolves the canonical MVP catalog and composes a redacted first-day plan', () => {
  const artifacts = provideCanonicalFirstDayPreopenArtifacts(authority());
  assert.deepEqual(
    new Set(artifacts.e01.ingredientCatalog.map((ingredient) => ingredient.revision)),
    new Set([MVP_FIRST_DAY_CATALOG_VERSIONS.ingredientCatalog]),
  );
  assert.deepEqual(
    new Set(artifacts.e01.recipeCatalog.map((recipe) => recipe.catalogRevision)),
    new Set([MVP_FIRST_DAY_CATALOG_VERSIONS.recipeCatalog]),
  );
  assert.equal(artifacts.e01.openingInventory.capacity.DURABLE, 305);
  assert.equal(artifacts.e01.openingInventory.stocks.length, 0);
  assert.equal(
    artifacts.e01.cashAvailable.minorUnits,
    authority().save.openingSnapshot.settlementCash.amount.minorUnits,
  );

  const plan = createPreopenDayPlan(configureIntent(), artifacts);
  assert.equal(plan.privateEnvelope.inventoryProcurement.market.marketSeed, 'independent-market-seed-1');
  const visible = JSON.stringify(plan.publicProjection);
  for (const hidden of [
    'independent-market-seed-1',
    'server-demand-seed-1',
    'openingStocks',
    'accountingEvidence',
    'hiddenPatienceTicks',
    'arrivalTick',
    'recipePreferenceOrder',
  ]) {
    assert.equal(visible.includes(hidden), false, `${hidden} must stay private`);
  }
});

test('EMPTY authority preserves an uninstalled zero-capacity storage bundle', () => {
  const artifacts = provideCanonicalFirstDayPreopenArtifacts(authority('EMPTY_PREMISES'));
  assert.deepEqual(artifacts.e01.openingInventory.capacity, { DURABLE: 0, PERISHABLE: 0 });
  assert.deepEqual(artifacts.e01.openingInventory.stocks, []);
});

test('provider rejects unknown or mismatched opening snapshot and currency authority', () => {
  const base = authority();
  assert.throws(
    () =>
      provideCanonicalFirstDayPreopenArtifacts({
        ...base,
        save: { ...base.save, settlementCurrency: 'USD' },
      }),
    /opening snapshot does not match/,
  );

  const unsupportedPayload = {
    ...base.save.openingSnapshot,
    simulationRuleVersion: 'unknown-rules/v9',
  };
  const unsupported = {
    ...unsupportedPayload,
    openingSnapshotHash: calculateOpeningSnapshotHash(unsupportedPayload),
  } as OpeningSnapshot;
  assert.throws(
    () =>
      provideCanonicalFirstDayPreopenArtifacts({
        ...base,
        save: {
          ...base.save,
          simulationRuleVersion: unsupported.simulationRuleVersion,
          openingSnapshot: unsupported,
          openingSnapshotHash: unsupported.openingSnapshotHash,
        },
      }),
    /unknown simulation rule version/,
  );
});

test('provider rejects market seed aliasing, unknown seed versions, and cross-save authority', () => {
  const base = authority();
  for (const marketSeedAuthority of [
    { ...base.marketSeedAuthority, seed: base.save.demandSeed },
    { ...base.marketSeedAuthority, seedVersion: 'market-seed/v2' },
    { ...base.marketSeedAuthority, saveId: 'save-2' },
  ]) {
    assert.throws(() =>
      provideCanonicalFirstDayPreopenArtifacts({ ...base, marketSeedAuthority }),
    );
  }
});

test('provider requires exactly one shared DURABLE and PERISHABLE bundle authority', () => {
  const base = authority();
  const durable = base.inventoryPoolAuthorities[0]!;
  const perishable = base.inventoryPoolAuthorities[1]!;
  for (const inventoryPoolAuthorities of [
    [durable],
    [durable, { ...perishable, pool: 'DURABLE' as const }],
    [durable, { ...perishable, revision: 2 }],
    [durable, { ...perishable, storageBundleVersion: 'mvp-storage/v2' }],
    [durable, { ...perishable, capacityPoints: -1 }],
    [durable, { ...perishable, capacityPoints: 304 }],
    [
      { ...durable, capacityPoints: 120 },
      { ...perishable, capacityPoints: 120 },
    ],
    [
      { ...durable, storageBundleKind: 'VERSIONED_UPGRADE' as const },
      { ...perishable, storageBundleKind: 'VERSIONED_UPGRADE' as const },
    ],
    [durable, { ...perishable, saveId: 'save-2' }],
  ] as const) {
    assert.throws(() =>
      provideCanonicalFirstDayPreopenArtifacts({ ...base, inventoryPoolAuthorities }),
    );
  }
});

test('EMPTY first day rejects a forged installed bundle or nonzero capacity', () => {
  const base = authority('EMPTY_PREMISES');
  const durable = base.inventoryPoolAuthorities[0]!;
  const perishable = base.inventoryPoolAuthorities[1]!;
  for (const inventoryPoolAuthorities of [
    [
      { ...durable, capacityPoints: 280 },
      { ...perishable, capacityPoints: 280 },
    ],
    [
      { ...durable, storageBundleKind: 'BASIC' as const, capacityPoints: 280 },
      { ...perishable, storageBundleKind: 'BASIC' as const, capacityPoints: 280 },
    ],
    [
      { ...durable, storageBundleKind: 'VERSIONED_UPGRADE' as const, capacityPoints: 5 },
      { ...perishable, storageBundleKind: 'VERSIONED_UPGRADE' as const, capacityPoints: 5 },
    ],
  ] as const) {
    assert.throws(
      () =>
        provideCanonicalFirstDayPreopenArtifacts({
          ...base,
          inventoryPoolAuthorities,
        }),
      /canonical initial storage bundle/,
    );
  }
});

test('provider input cannot inject an alternative catalog', () => {
  const base = authority();
  assert.throws(
    () =>
      provideCanonicalFirstDayPreopenArtifacts({
        ...base,
        recipeCatalog: [{ id: 'forged' }],
      } as never),
    /unknown or missing authority fields/,
  );
});

test('provider rejects an injected demand builder and resolves only the persisted save rule', () => {
  const base = authority();
  assert.throws(
    () =>
      provideCanonicalFirstDayPreopenArtifacts({
        ...base,
        demandBuilder: { create: () => ({}) },
      } as never),
    /unknown or missing authority fields/,
  );

  const artifacts = provideCanonicalFirstDayPreopenArtifacts(base);
  const plan = createPreopenDayPlan(configureIntent(), artifacts);
  assert.equal(plan.privateEnvelope.demandSchedule.demandSeed, base.save.demandSeed);
  assert.ok([-5, 0, 5].includes(plan.privateEnvelope.demandSchedule.weather.demandModifierPercent));
});

test('provider snapshots command and save identity before returning ID closures', () => {
  const input = authority();
  const artifacts = provideCanonicalFirstDayPreopenArtifacts(input);
  const mutable = input as unknown as {
    command: { commandId: string; preopenSnapshotId: string };
    save: { id: string };
    spotPurchaseIdFactory: {
      create: CanonicalFirstDayPreopenAuthorityInput['spotPurchaseIdFactory']['create'];
    };
  };
  mutable.command.commandId = 'forged-command';
  mutable.command.preopenSnapshotId = 'forged-preopen';
  mutable.save.id = 'forged-save';
  mutable.spotPurchaseIdFactory.create = () => ({
    transactionId: 'forged-transaction',
    purchaseId: 'forged-purchase',
  });

  const ids = artifacts.e01.spotPurchaseIdsForIngredient('bistro-rice');
  assert.match(ids.transactionId, new RegExp(COMMAND_ID));
  assert.match(ids.transactionId, /preopen-snapshot-1/);
  assert.match(ids.transactionId, /save-1/);
  assert.equal(ids.transactionId.includes('forged'), false);
  assert.equal(ids.purchaseId.includes('forged'), false);
});

test('direct composer rejects canonical substitution and market revision contradictions', () => {
  const artifacts = provideCanonicalFirstDayPreopenArtifacts(authority());
  assert.throws(
    () =>
      createPreopenDayPlan(configureIntent(), {
        ...artifacts,
        e01: {
          ...artifacts.e01,
          substitutionCatalog: artifacts.e01.substitutionCatalog.map((entry, index) =>
            index === 0 ? { ...entry, catalogRevision: 'forged-substitutions/v2' } : entry,
          ),
        },
      }),
    /substitution catalog entries must match/,
  );
  assert.throws(
    () =>
      createPreopenDayPlan(configureIntent(), {
        ...artifacts,
        e01: {
          ...artifacts.e01,
          marketSnapshot: {
            ...artifacts.e01.marketSnapshot,
            catalogRevision: 'forged-ingredients/v2',
          },
        },
      }),
    /market snapshot must match/,
  );
});
