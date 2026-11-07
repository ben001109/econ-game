import {
  assertCatalogContract,
  type CatalogSubstitution,
  type IngredientCatalogItem,
  type RecipeVersion,
} from './catalog-menu.js';
import { createMoneyFromDisplayInteger, type CurrencyMetadata } from '../money/money.js';
import { MVP_OPENING_VERSIONS, resolveOpeningRegistry } from '../opening-scenario/registry.js';
import { deepFreeze } from './shared.js';

/**
 * The only E03 catalog available to the first-day MVP.  The version selection
 * is stored by a future trusted bootstrap provider; this module deliberately
 * has no "latest" resolver or client-selected default.
 */
export const MVP_FIRST_DAY_CATALOG_VERSIONS = deepFreeze({
  catalog: 'mvp-first-day-catalog/v1',
  ingredientCatalog: 'mvp-first-day-ingredients/v1',
  recipeCatalog: 'mvp-first-day-recipes/v1',
  substitutionCatalog: 'mvp-first-day-substitutions/v1',
});

export type MvpFirstDayCatalogVersionSelection = Readonly<{
  catalog: string;
  ingredientCatalog: string;
  recipeCatalog: string;
  substitutionCatalog: string;
}>;

/**
 * Currency is selected by a trusted registry key, never by caller-supplied
 * metadata.  The metadata version is explicit so a future registry revision
 * cannot silently change replay or settlement semantics.
 */
export type MvpFirstDayCurrencySelection = Readonly<{
  code: string;
  metadataVersion: string;
}>;

export const MVP_FIRST_DAY_CURRENCY_METADATA_VERSION =
  MVP_OPENING_VERSIONS.currencyMetadataVersion;

export type MvpFirstDayCatalog = Readonly<{
  versions: MvpFirstDayCatalogVersionSelection;
  currency: CurrencyMetadata;
  ingredientCatalog: readonly IngredientCatalogItem[];
  recipeCatalog: readonly RecipeVersion[];
  substitutionCatalog: readonly CatalogSubstitution[];
}>;

type IngredientDefinition = Readonly<{
  id: string;
  kind: IngredientCatalogItem['kind'];
  pool: IngredientCatalogItem['pool'];
  referenceDisplayPrice: string;
}>;

const BISTRO_THEME_ID = 'bistro';

const INGREDIENT_DEFINITIONS = deepFreeze([
  { id: 'bistro-rice', kind: 'COMMON', pool: 'DURABLE', referenceDisplayPrice: '30' },
  { id: 'bistro-sauce', kind: 'COMMON', pool: 'DURABLE', referenceDisplayPrice: '10' },
  { id: 'bistro-chicken', kind: 'COMMON', pool: 'PERISHABLE', referenceDisplayPrice: '50' },
  { id: 'bistro-greens', kind: 'COMMON', pool: 'PERISHABLE', referenceDisplayPrice: '20' },
  { id: 'bistro-herbs', kind: 'COMMON', pool: 'PERISHABLE', referenceDisplayPrice: '15' },
  { id: 'bistro-truffle', kind: 'RARE', pool: 'DURABLE', referenceDisplayPrice: '100' },
] satisfies readonly IngredientDefinition[]);

type RecipeDefinition = Readonly<{
  id: string;
  recipeId: string;
  baseQuality: number;
  ingredientIds: readonly string[];
}>;

const RECIPE_DEFINITIONS = deepFreeze([
  {
    id: 'bistro-chicken-rice-v1',
    recipeId: 'bistro-chicken-rice',
    baseQuality: 76,
    ingredientIds: ['bistro-rice', 'bistro-sauce', 'bistro-chicken'],
  },
  {
    id: 'bistro-greens-rice-v1',
    recipeId: 'bistro-greens-rice',
    baseQuality: 78,
    ingredientIds: ['bistro-rice', 'bistro-sauce', 'bistro-greens'],
  },
  {
    id: 'bistro-herb-chicken-v1',
    recipeId: 'bistro-herb-chicken',
    baseQuality: 81,
    ingredientIds: ['bistro-chicken', 'bistro-greens', 'bistro-herbs'],
  },
  {
    id: 'bistro-sauce-chicken-v1',
    recipeId: 'bistro-sauce-chicken',
    baseQuality: 83,
    ingredientIds: ['bistro-rice', 'bistro-chicken', 'bistro-herbs'],
  },
  {
    id: 'bistro-greens-herbs-v1',
    recipeId: 'bistro-greens-herbs',
    baseQuality: 86,
    ingredientIds: ['bistro-rice', 'bistro-greens', 'bistro-herbs'],
  },
  {
    id: 'bistro-truffle-rice-v1',
    recipeId: 'bistro-truffle-rice',
    baseQuality: 89,
    ingredientIds: ['bistro-rice', 'bistro-sauce', 'bistro-truffle'],
  },
] satisfies readonly RecipeDefinition[]);

type SubstitutionDefinition = Readonly<{
  id: string;
  recipeVersionId: string;
  priority: number;
  qualityDelta: number;
  ingredientIds: readonly string[];
}>;

const SUBSTITUTION_DEFINITIONS = deepFreeze([
  {
    id: 'bistro-chicken-rice-greens-v1',
    recipeVersionId: 'bistro-chicken-rice-v1',
    priority: 10,
    qualityDelta: -3,
    ingredientIds: ['bistro-rice', 'bistro-sauce', 'bistro-greens'],
  },
  {
    id: 'bistro-chicken-rice-herbs-v1',
    recipeVersionId: 'bistro-chicken-rice-v1',
    priority: 20,
    qualityDelta: -6,
    ingredientIds: ['bistro-rice', 'bistro-greens', 'bistro-herbs'],
  },
] satisfies readonly SubstitutionDefinition[]);

function snapshotPlainDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
  errorMessage: string,
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`${errorMessage}; plain data object is required`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actualKeys = Object.keys(descriptors).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpectedKeys.length ||
    actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
  ) {
    throw new Error(errorMessage);
  }
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (!descriptor || !('value' in descriptor)) {
      throw new Error(`${errorMessage}; accessor properties are not allowed`);
    }
  }
  return Object.fromEntries(expectedKeys.map((key) => [key, descriptors[key]!.value]));
}

function snapshotVersionSelection(
  selection: MvpFirstDayCatalogVersionSelection,
): MvpFirstDayCatalogVersionSelection {
  const snapshot = snapshotPlainDataRecord(
    selection,
    ['catalog', 'ingredientCatalog', 'recipeCatalog', 'substitutionCatalog'],
    'first-day catalog version selection must contain exactly four version keys',
  );
  return {
    catalog: snapshot.catalog as string,
    ingredientCatalog: snapshot.ingredientCatalog as string,
    recipeCatalog: snapshot.recipeCatalog as string,
    substitutionCatalog: snapshot.substitutionCatalog as string,
  };
}

function resolveSupportedCurrency(selection: MvpFirstDayCurrencySelection): CurrencyMetadata {
  const snapshot = snapshotPlainDataRecord(
    selection,
    ['code', 'metadataVersion'],
    'first-day currency selection must contain exactly code and metadataVersion',
  );
  const code = snapshot.code;
  const metadataVersion = snapshot.metadataVersion;
  if (typeof code !== 'string' || typeof metadataVersion !== 'string') {
    throw new Error('first-day currency selection values must be strings');
  }
  if (metadataVersion !== MVP_FIRST_DAY_CURRENCY_METADATA_VERSION) {
    throw new Error('unknown currency metadata version; replay cannot fall back to latest');
  }
  // Resolve from the immutable E01 server registry.  Never consume caller
  // supplied currency metadata after validation (or construct money from it).
  return resolveOpeningRegistry(MVP_OPENING_VERSIONS, code).currency;
}

function assertKnownVersions(selection: MvpFirstDayCatalogVersionSelection): void {
  if (
    selection.catalog !== MVP_FIRST_DAY_CATALOG_VERSIONS.catalog ||
    selection.ingredientCatalog !== MVP_FIRST_DAY_CATALOG_VERSIONS.ingredientCatalog ||
    selection.recipeCatalog !== MVP_FIRST_DAY_CATALOG_VERSIONS.recipeCatalog ||
    selection.substitutionCatalog !== MVP_FIRST_DAY_CATALOG_VERSIONS.substitutionCatalog
  ) {
    throw new Error('unknown first-day catalog revision; replay cannot fall back to latest');
  }
}

/**
 * Resolves one explicit, server-authoritative first-day catalog.  All monetary
 * values are constructed with the supplied server currency metadata so this
 * registry cannot silently choose a settlement currency on behalf of a client.
 */
export function resolveMvpFirstDayCatalog(
  selection: MvpFirstDayCatalogVersionSelection,
  currencySelection: MvpFirstDayCurrencySelection,
): MvpFirstDayCatalog {
  if (selection === null || typeof selection !== 'object') {
    throw new Error('first-day catalog version selection is required');
  }
  const canonicalSelection = snapshotVersionSelection(selection);
  assertKnownVersions(canonicalSelection);
  const currency = resolveSupportedCurrency(currencySelection);

  const ingredientCatalog = INGREDIENT_DEFINITIONS.map((definition) => ({
    id: definition.id,
    revision: canonicalSelection.ingredientCatalog,
    kind: definition.kind,
    pool: definition.pool,
    referenceUnitPrice: createMoneyFromDisplayInteger(currency, definition.referenceDisplayPrice),
    unlockedThemeIds: [BISTRO_THEME_ID],
  }));
  const recipeCatalog = RECIPE_DEFINITIONS.map((definition) => ({
    id: definition.id,
    recipeId: definition.recipeId,
    version: 1,
    catalogRevision: canonicalSelection.recipeCatalog,
    themeId: BISTRO_THEME_ID,
    baseQuality: definition.baseQuality,
    ingredients: definition.ingredientIds.map((ingredientId) => ({ ingredientId, quantityPoints: 1 })),
  }));
  const substitutionCatalog = SUBSTITUTION_DEFINITIONS.map((definition) => ({
    id: definition.id,
    catalogRevision: canonicalSelection.substitutionCatalog,
    recipeVersionId: definition.recipeVersionId,
    priority: definition.priority,
    qualityDelta: definition.qualityDelta,
    ingredients: definition.ingredientIds.map((ingredientId) => ({ ingredientId, quantityPoints: 1 })),
  }));

  assertCatalogContract(recipeCatalog, ingredientCatalog, substitutionCatalog);
  return deepFreeze({
    versions: {
      catalog: canonicalSelection.catalog,
      ingredientCatalog: canonicalSelection.ingredientCatalog,
      recipeCatalog: canonicalSelection.recipeCatalog,
      substitutionCatalog: canonicalSelection.substitutionCatalog,
    },
    currency: { code: currency.code, minorUnitExponent: currency.minorUnitExponent },
    ingredientCatalog,
    recipeCatalog,
    substitutionCatalog,
  });
}
