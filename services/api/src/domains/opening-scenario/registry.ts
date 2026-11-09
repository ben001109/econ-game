import type { CurrencyMetadata } from '../money/money.js';
import { openingScenarioCatalog } from './catalog.js';

export type OpeningVersionSelection = Readonly<{
  snapshotSchemaVersion: string;
  openingCatalogVersion: string;
  currencyMetadataVersion: string;
  simulationRuleVersion: string;
}>;

export type ResolvedOpeningRegistry = Readonly<{
  versions: OpeningVersionSelection;
  currency: CurrencyMetadata;
}>;

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

export const MVP_OPENING_VERSIONS = deepFreeze({
  snapshotSchemaVersion: 'opening-snapshot/v1',
  openingCatalogVersion: 'mvp-e01-opening-v2',
  currencyMetadataVersion: 'iso-4217-mvp/v1',
  simulationRuleVersion: 'mvp-e01-v1',
} satisfies OpeningVersionSelection);

export const serverOpeningRegistry = deepFreeze({
  snapshotSchemas: {
    'opening-snapshot/v1': { canonicalSerialization: 'SORTED_KEYS_JSON_UTF8_SHA256' },
  },
  openingCatalogs: {
    'mvp-e01-opening-v2': openingScenarioCatalog,
  },
  currencyMetadata: {
    'iso-4217-mvp/v1': {
      TWD: { code: 'TWD', minorUnitExponent: 0 },
      USD: { code: 'USD', minorUnitExponent: 2 },
    },
  },
  simulationRules: {
    'mvp-e01-v1': { openingContract: 'E01-S-01' },
  },
});

function hasOwn(record: object, key: string): boolean {
  return Object.hasOwn(record, key);
}

function assertExactVersionKeys(selection: OpeningVersionSelection): void {
  const expected = [
    'currencyMetadataVersion',
    'openingCatalogVersion',
    'simulationRuleVersion',
    'snapshotSchemaVersion',
  ];
  const actual = Object.keys(selection as object).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(
      'server version selection must contain exactly the four registered version keys',
    );
  }
}

export function resolveOpeningRegistry(
  selection: OpeningVersionSelection,
  currencyCode: string,
): ResolvedOpeningRegistry {
  if (selection === null || typeof selection !== 'object') {
    throw new Error('server version selection is required');
  }
  assertExactVersionKeys(selection);

  if (!hasOwn(serverOpeningRegistry.snapshotSchemas, selection.snapshotSchemaVersion)) {
    throw new Error('unknown snapshot schema version; replay cannot fall back to latest');
  }
  if (!hasOwn(serverOpeningRegistry.openingCatalogs, selection.openingCatalogVersion)) {
    throw new Error('unknown opening catalog version; replay cannot fall back to latest');
  }
  if (!hasOwn(serverOpeningRegistry.currencyMetadata, selection.currencyMetadataVersion)) {
    throw new Error('unknown currency metadata version; replay cannot fall back to latest');
  }
  if (!hasOwn(serverOpeningRegistry.simulationRules, selection.simulationRuleVersion)) {
    throw new Error('unknown simulation rule version; replay cannot fall back to latest');
  }

  const currencyRegistry = serverOpeningRegistry.currencyMetadata[
    selection.currencyMetadataVersion as keyof typeof serverOpeningRegistry.currencyMetadata
  ] as Readonly<Record<string, CurrencyMetadata>>;
  if (!hasOwn(currencyRegistry, currencyCode)) {
    throw new Error('settlement currency is not supported by the selected server registry');
  }

  return deepFreeze({
    versions: {
      snapshotSchemaVersion: selection.snapshotSchemaVersion,
      openingCatalogVersion: selection.openingCatalogVersion,
      currencyMetadataVersion: selection.currencyMetadataVersion,
      simulationRuleVersion: selection.simulationRuleVersion,
    },
    currency: currencyRegistry[currencyCode]!,
  });
}
