import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertCatalogContract,
  createMenuSelection,
  MENU_SIZE_BY_DIFFICULTY,
} from './catalog-menu.js';
import {
  MVP_FIRST_DAY_CURRENCY_METADATA_VERSION,
  MVP_FIRST_DAY_CATALOG_VERSIONS,
  type MvpFirstDayCurrencySelection,
  resolveMvpFirstDayCatalog,
} from './mvp-first-day-catalog.js';
import { createMarketSnapshot } from './procurement.js';
function currency(code: string): MvpFirstDayCurrencySelection {
  return { code, metadataVersion: MVP_FIRST_DAY_CURRENCY_METADATA_VERSION };
}

const TWD = currency('TWD');
const USD = currency('USD');

function selection() {
  return { ...MVP_FIRST_DAY_CATALOG_VERSIONS };
}

function selectMenu(difficulty: keyof typeof MENU_SIZE_BY_DIFFICULTY) {
  const catalog = resolveMvpFirstDayCatalog(selection(), TWD);
  const recipeVersionIds = catalog.recipeCatalog
    .slice(0, MENU_SIZE_BY_DIFFICULTY[difficulty])
    .map((recipe) => recipe.id);
  return createMenuSelection({
    businessDay: 2,
    phase: 'PRE_OPEN',
    difficulty,
    themeId: 'bistro',
    recipeVersionIds,
    priceModifierPercentByRecipe: Object.fromEntries(recipeVersionIds.map((id) => [id, 0])),
    enabledSubstitutionIds: [],
    recipeCatalog: catalog.recipeCatalog,
    ingredientCatalog: catalog.ingredientCatalog,
    substitutionCatalog: catalog.substitutionCatalog,
  });
}

test('resolves the immutable first-day catalog from explicit supported server currency metadata', () => {
  const twdCatalog = resolveMvpFirstDayCatalog(selection(), TWD);
  const usdCatalog = resolveMvpFirstDayCatalog(selection(), USD);

  assert.deepEqual(twdCatalog.versions, usdCatalog.versions);
  assert.deepEqual(
    twdCatalog.recipeCatalog.map(({ id, recipeId, themeId, baseQuality, ingredients }) => ({
      id,
      recipeId,
      themeId,
      baseQuality,
      ingredients,
    })),
    usdCatalog.recipeCatalog.map(({ id, recipeId, themeId, baseQuality, ingredients }) => ({
      id,
      recipeId,
      themeId,
      baseQuality,
      ingredients,
    })),
  );
  assert.ok(
    twdCatalog.ingredientCatalog.every(
      (ingredient) => ingredient.referenceUnitPrice.currency === 'TWD',
    ),
  );
  assert.ok(
    usdCatalog.ingredientCatalog.every(
      (ingredient) => ingredient.referenceUnitPrice.currency === 'USD',
    ),
  );
  assert.equal(twdCatalog.ingredientCatalog[0]?.referenceUnitPrice.minorUnits, '30');
  assert.equal(usdCatalog.ingredientCatalog[0]?.referenceUnitPrice.minorUnits, '3000');
  assert.ok(Object.isFrozen(twdCatalog));
  assert.ok(Object.isFrozen(twdCatalog.ingredientCatalog));
  assert.ok(Object.isFrozen(twdCatalog.ingredientCatalog[0]!));
});

test('first-day bistro catalog has six controlled main-meal cards and satisfies E03 catalog invariants', () => {
  const catalog = resolveMvpFirstDayCatalog(selection(), TWD);

  assert.equal(catalog.recipeCatalog.length, 6);
  assert.ok(catalog.recipeCatalog.every((recipe) => recipe.themeId === 'bistro'));
  assert.doesNotThrow(() =>
    assertCatalogContract(
      catalog.recipeCatalog,
      catalog.ingredientCatalog,
      catalog.substitutionCatalog,
    ),
  );
  assert.deepEqual(
    catalog.substitutionCatalog.map((substitution) => substitution.priority),
    [10, 20],
  );
});

test('the existing menu function selects 2, 3, or 4 first-day catalog recipes by difficulty', () => {
  assert.equal(selectMenu('GUIDED').items.length, 2);
  assert.equal(selectMenu('STANDARD').items.length, 3);
  assert.equal(selectMenu('CHALLENGE').items.length, 4);
});

test('first-day market quotes remain equal to the catalog reference prices', () => {
  const catalog = resolveMvpFirstDayCatalog(selection(), TWD);
  const market = createMarketSnapshot({
    saveId: 'save-1',
    businessDay: 1,
    marketSeed: 'server-owned-market-seed',
    catalogRevision: catalog.versions.ingredientCatalog,
    simulationRuleVersion: 'mvp-e01-v1',
    ingredientCatalog: catalog.ingredientCatalog,
  });

  assert.ok(market.quotes.every((quote) => quote.priceModifierBps === 0));
  assert.ok(
    market.quotes.every(
      (quote) =>
        quote.unitPrice.currency === quote.referenceUnitPrice.currency &&
        quote.unitPrice.minorUnits === quote.referenceUnitPrice.minorUnits,
    ),
  );
});

test('exact resolver rejects unknown revisions, unsupported currency metadata, and malformed input', () => {
  assert.throws(
    () =>
      resolveMvpFirstDayCatalog({ ...selection(), recipeCatalog: 'mvp-first-day-recipes/v2' }, TWD),
    /unknown first-day catalog revision/,
  );
  assert.throws(
    () => resolveMvpFirstDayCatalog(selection(), currency('JPY')),
    /settlement currency is not supported/,
  );
  assert.throws(
    () =>
      resolveMvpFirstDayCatalog(selection(), { code: 'USD', metadataVersion: 'iso-4217-mvp/v2' }),
    /unknown currency metadata version/,
  );
  assert.throws(
    () => resolveMvpFirstDayCatalog({ catalog: 'mvp-first-day-catalog/v1' } as never, TWD),
    /exactly four version keys/,
  );
  assert.throws(
    () => resolveMvpFirstDayCatalog(null as never, TWD),
    /version selection is required/,
  );
});

test('resolver rejects mutable accessor inputs at both authority boundaries', () => {
  const hostileCurrency = {} as { code: string; metadataVersion: string };
  Object.defineProperties(hostileCurrency, {
    code: {
      enumerable: true,
      get: (() => {
        let reads = 0;
        return () => (reads++ === 0 ? 'TWD' : 'USD');
      })(),
    },
    metadataVersion: {
      enumerable: true,
      value: MVP_FIRST_DAY_CURRENCY_METADATA_VERSION,
    },
  });
  assert.throws(
    () => resolveMvpFirstDayCatalog(selection(), hostileCurrency),
    /accessor properties are not allowed/,
  );

  const hostileVersions = selection() as Record<string, string>;
  Object.defineProperty(hostileVersions, 'catalog', {
    enumerable: true,
    get: (() => {
      let reads = 0;
      return () => (reads++ === 0 ? MVP_FIRST_DAY_CATALOG_VERSIONS.catalog : 'evil/v2');
    })(),
  });
  assert.throws(
    () => resolveMvpFirstDayCatalog(hostileVersions as ReturnType<typeof selection>, TWD),
    /accessor properties are not allowed/,
  );
});
