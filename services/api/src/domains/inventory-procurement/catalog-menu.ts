import {
  assertNonNegativeSafeInteger,
  assertPositiveSafeInteger,
  assertSameCurrency,
  compareStableKey,
  deepFreeze,
  moneyFromMinorUnits,
  moneyMinorUnits,
  roundHalfUpRatio,
  stableBucket,
} from './shared.js';
import type { Money } from '../money/money.js';

export type InventoryPool = 'DURABLE' | 'PERISHABLE';
export type IngredientKind = 'COMMON' | 'RARE';
export type MenuDifficulty = 'GUIDED' | 'STANDARD' | 'CHALLENGE';
export type CustomerCohort = 'PRICE_SENSITIVE' | 'TIME_SENSITIVE' | 'EXPERIENCE_ORIENTED';

export const MENU_SIZE_BY_DIFFICULTY: Readonly<Record<MenuDifficulty, number>> = Object.freeze({
  GUIDED: 2,
  STANDARD: 3,
  CHALLENGE: 4,
});

const ELASTICITY_TENTHS: Readonly<Record<CustomerCohort, number>> = Object.freeze({
  PRICE_SENSITIVE: 15,
  TIME_SENSITIVE: 5,
  EXPERIENCE_ORIENTED: 10,
});

export type IngredientCatalogItem = Readonly<{
  id: string;
  revision: string;
  kind: IngredientKind;
  pool: InventoryPool;
  referenceUnitPrice: Money;
  unlockedThemeIds: readonly string[];
}>;

export type RecipeIngredient = Readonly<{
  ingredientId: string;
  quantityPoints: number;
}>;

export type RecipeVersion = Readonly<{
  id: string;
  recipeId: string;
  version: number;
  catalogRevision: string;
  themeId: string;
  baseQuality: number;
  ingredients: readonly RecipeIngredient[];
}>;

export type CatalogSubstitution = Readonly<{
  id: string;
  catalogRevision: string;
  recipeVersionId: string;
  priority: number;
  qualityDelta: number;
  ingredients: readonly RecipeIngredient[];
}>;

export type MenuItemSelection = Readonly<{
  recipeVersionId: string;
  priceModifierPercent: number;
  basePrice: Money;
  salePrice: Money;
  enabledSubstitutionIds: readonly string[];
}>;

export type MenuSelection = Readonly<{
  businessDay: number;
  difficulty: MenuDifficulty;
  themeId: string;
  lockedFrom: 'OPENING_START';
  lockedUntil: 'DAY_END';
  items: readonly MenuItemSelection[];
}>;

export type CreateMenuSelectionInput = Readonly<{
  businessDay: number;
  phase: 'PRE_OPEN';
  difficulty: MenuDifficulty;
  themeId: string;
  recipeVersionIds: readonly string[];
  priceModifierPercentByRecipe: Readonly<Record<string, number>>;
  enabledSubstitutionIds: readonly string[];
  recipeCatalog: readonly RecipeVersion[];
  ingredientCatalog: readonly IngredientCatalogItem[];
  substitutionCatalog: readonly CatalogSubstitution[];
}>;

function assertUniqueIds(ids: readonly string[], name: string): void {
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${name} must not contain duplicates`);
  }
}

function validateIngredientList(
  ingredients: readonly RecipeIngredient[],
  ingredientById: ReadonlyMap<string, IngredientCatalogItem>,
  name: string,
): void {
  assertUniqueIds(
    ingredients.map((ingredient) => ingredient.ingredientId),
    `${name} ingredient ids`,
  );
  let commonCount = 0;
  let rareCount = 0;
  for (const ingredient of ingredients) {
    assertPositiveSafeInteger(ingredient.quantityPoints, `${name} ingredient quantity`);
    const definition = ingredientById.get(ingredient.ingredientId);
    if (!definition) throw new Error(`${name} references an unknown ingredient`);
    if (definition.kind === 'COMMON') commonCount += 1;
    else rareCount += 1;
  }
  if (commonCount < 2 || commonCount > 3 || rareCount > 1) {
    throw new Error(`${name} must use 2-3 common ingredients and at most one rare ingredient`);
  }
  const totalPoints = ingredients.reduce((sum, ingredient) => sum + ingredient.quantityPoints, 0);
  if (totalPoints !== 3) {
    throw new Error(`${name} must consume exactly three ingredient points per main dish`);
  }
}

export function assertCatalogContract(
  recipes: readonly RecipeVersion[],
  ingredients: readonly IngredientCatalogItem[],
  substitutions: readonly CatalogSubstitution[],
): void {
  assertUniqueIds(
    recipes.map((recipe) => recipe.id),
    'recipe version ids',
  );
  assertUniqueIds(
    ingredients.map((ingredient) => ingredient.id),
    'ingredient ids',
  );
  assertUniqueIds(
    substitutions.map((substitution) => substitution.id),
    'substitution ids',
  );
  const ingredientById = new Map(ingredients.map((ingredient) => [ingredient.id, ingredient]));
  const recipeById = new Map(recipes.map((recipe) => [recipe.id, recipe]));
  const themeRecipeIds = new Map<string, Set<string>>();

  for (const ingredient of ingredients) {
    if (!ingredient.id || !ingredient.revision) {
      throw new Error('ingredient catalog entries require stable id and revision');
    }
    if (moneyMinorUnits(ingredient.referenceUnitPrice, 'ingredient reference price') === 0n) {
      throw new Error('ingredient reference price must be positive');
    }
    if (ingredient.unlockedThemeIds.length === 0) {
      throw new Error('every ingredient must be available to at least one controlled theme');
    }
    assertUniqueIds(ingredient.unlockedThemeIds, 'ingredient unlocked themes');
  }
  for (const recipe of recipes) {
    if (!recipe.id || !recipe.recipeId || !recipe.catalogRevision || !recipe.themeId) {
      throw new Error('recipe versions require stable identities, revision, and theme');
    }
    assertPositiveSafeInteger(recipe.version, 'recipe version');
    if (
      !Number.isInteger(recipe.baseQuality) ||
      recipe.baseQuality < 75 ||
      recipe.baseQuality > 90
    ) {
      throw new Error('recipe base quality must be an integer from 75 through 90');
    }
    validateIngredientList(recipe.ingredients, ingredientById, `recipe ${recipe.id}`);
    for (const ingredient of recipe.ingredients) {
      if (!ingredientById.get(ingredient.ingredientId)?.unlockedThemeIds.includes(recipe.themeId)) {
        throw new Error('recipe ingredient must be unlocked for the recipe theme');
      }
    }
    const recipeIds = themeRecipeIds.get(recipe.themeId) ?? new Set<string>();
    recipeIds.add(recipe.recipeId);
    themeRecipeIds.set(recipe.themeId, recipeIds);
  }
  for (const recipeIds of themeRecipeIds.values()) {
    if (recipeIds.size < 6) {
      throw new Error('each represented controlled theme must provide at least six recipe cards');
    }
  }
  for (const substitution of substitutions) {
    if (!substitution.id || !substitution.catalogRevision) {
      throw new Error('substitutions require stable id and catalog revision');
    }
    const recipe = recipeById.get(substitution.recipeVersionId);
    if (!recipe) throw new Error('substitution references an unknown recipe version');
    assertNonNegativeSafeInteger(substitution.priority, 'substitution priority');
    if (
      !Number.isInteger(substitution.qualityDelta) ||
      substitution.qualityDelta < -10 ||
      substitution.qualityDelta > 0
    ) {
      throw new Error('substitution quality delta must be an integer from -10 through 0');
    }
    validateIngredientList(
      substitution.ingredients,
      ingredientById,
      `substitution ${substitution.id}`,
    );
    for (const ingredient of substitution.ingredients) {
      if (!ingredientById.get(ingredient.ingredientId)?.unlockedThemeIds.includes(recipe.themeId)) {
        throw new Error('substitution ingredient must be unlocked for the recipe theme');
      }
    }
  }
}

export function calculateRecipeReferenceCost(
  recipe: RecipeVersion,
  ingredientCatalog: readonly IngredientCatalogItem[],
): Money {
  const ingredientById = new Map(
    ingredientCatalog.map((ingredient) => [ingredient.id, ingredient]),
  );
  let currency: string | undefined;
  let cost = 0n;
  for (const requirement of recipe.ingredients) {
    assertPositiveSafeInteger(requirement.quantityPoints, 'recipe ingredient quantity');
    const ingredient = ingredientById.get(requirement.ingredientId);
    if (!ingredient) throw new Error('recipe references an unknown ingredient');
    currency ??= ingredient.referenceUnitPrice.currency;
    if (ingredient.referenceUnitPrice.currency !== currency) {
      throw new Error('recipe ingredients must use one settlement currency');
    }
    cost += moneyMinorUnits(ingredient.referenceUnitPrice) * BigInt(requirement.quantityPoints);
  }
  if (!currency) throw new Error('recipe must contain ingredients');
  return moneyFromMinorUnits(currency, cost);
}

export function calculateRecipeBasePrice(referenceCost: Money): Money {
  return moneyFromMinorUnits(
    referenceCost.currency,
    roundHalfUpRatio(moneyMinorUnits(referenceCost) * 100n, 30n),
  );
}

export function calculateSalePrice(basePrice: Money, priceModifierPercent: number): Money {
  if (!Number.isInteger(priceModifierPercent) || Math.abs(priceModifierPercent) > 10) {
    throw new Error('price modifier must be a whole-percent step from -10 through 10');
  }
  return moneyFromMinorUnits(
    basePrice.currency,
    roundHalfUpRatio(moneyMinorUnits(basePrice) * BigInt(100 + priceModifierPercent), 100n),
  );
}

export function calculateConversionRateBps(
  cohort: CustomerCohort,
  priceModifierPercent: number,
  maximumAbsoluteAdjustmentBps = 10_000,
): number {
  if (!Number.isInteger(priceModifierPercent) || Math.abs(priceModifierPercent) > 10) {
    throw new Error('price modifier must be a whole-percent step from -10 through 10');
  }
  assertNonNegativeSafeInteger(maximumAbsoluteAdjustmentBps, 'maximum conversion adjustment');
  if (maximumAbsoluteAdjustmentBps > 10_000) {
    throw new Error('maximum conversion adjustment cannot exceed 10000 basis points');
  }
  const elasticityTenths = ELASTICITY_TENTHS[cohort];
  if (elasticityTenths === undefined) throw new Error('unknown customer cohort');
  const formulaAdjustmentBps = -priceModifierPercent * elasticityTenths * 10;
  const boundedAdjustment = Math.max(
    -maximumAbsoluteAdjustmentBps,
    Math.min(maximumAbsoluteAdjustmentBps, formulaAdjustmentBps),
  );
  return 10_000 + boundedAdjustment;
}

export type DeterministicCandidateSelectionInput = Readonly<{
  demandSeed: string;
  businessDay: number;
  candidateIds: readonly string[];
  baselineCandidateCount: number;
  cohort: CustomerCohort;
  priceModifierPercent: number;
}>;

export function selectDeterministicConversions(
  input: DeterministicCandidateSelectionInput,
): Readonly<{
  rateBps: number;
  targetCount: number;
  convertedCandidateIds: readonly string[];
}> {
  assertPositiveSafeInteger(input.businessDay, 'business day');
  assertNonNegativeSafeInteger(input.baselineCandidateCount, 'baseline candidate count');
  assertUniqueIds(input.candidateIds, 'demand candidate ids');
  if (input.baselineCandidateCount > input.candidateIds.length) {
    throw new Error('candidate list must contain the full baseline candidate count');
  }
  const rateBps = calculateConversionRateBps(
    input.cohort,
    input.priceModifierPercent,
    input.businessDay === 1 ? 1000 : 10_000,
  );
  const targetCount = Math.min(
    input.candidateIds.length,
    Number(roundHalfUpRatio(BigInt(input.baselineCandidateCount) * BigInt(rateBps), 10_000n)),
  );
  const convertedCandidateIds = [...input.candidateIds]
    .sort((left, right) => {
      const bucketDifference =
        stableBucket(input.demandSeed, left, 2 ** 32) -
        stableBucket(input.demandSeed, right, 2 ** 32);
      return bucketDifference || compareStableKey(left, right);
    })
    .slice(0, targetCount);
  return deepFreeze({ rateBps, targetCount, convertedCandidateIds });
}

export function createMenuSelection(input: CreateMenuSelectionInput): MenuSelection {
  assertPositiveSafeInteger(input.businessDay, 'business day');
  if (input.phase !== 'PRE_OPEN') {
    throw new Error('menu, substitutions, and prices can only be set before opening');
  }
  assertCatalogContract(input.recipeCatalog, input.ingredientCatalog, input.substitutionCatalog);
  if (input.businessDay === 1 && input.difficulty !== 'STANDARD') {
    throw new Error('the first business day must use the standard three-recipe menu');
  }
  const expectedSize = MENU_SIZE_BY_DIFFICULTY[input.difficulty];
  if (input.recipeVersionIds.length !== expectedSize) {
    throw new Error(`difficulty ${input.difficulty} requires exactly ${expectedSize} recipes`);
  }
  assertUniqueIds(input.recipeVersionIds, 'active recipe version ids');
  assertUniqueIds(input.enabledSubstitutionIds, 'enabled substitution ids');

  const recipeById = new Map(input.recipeCatalog.map((recipe) => [recipe.id, recipe]));
  const substitutionById = new Map(
    input.substitutionCatalog.map((substitution) => [substitution.id, substitution]),
  );
  const items = input.recipeVersionIds.map((recipeVersionId) => {
    const recipe = recipeById.get(recipeVersionId);
    if (!recipe || recipe.themeId !== input.themeId) {
      throw new Error(
        'active recipes must be controlled versions from the selected unlocked theme',
      );
    }
    const modifier = input.priceModifierPercentByRecipe[recipeVersionId];
    if (modifier === undefined) throw new Error('every active recipe requires a price modifier');
    const basePrice = calculateRecipeBasePrice(
      calculateRecipeReferenceCost(recipe, input.ingredientCatalog),
    );
    const enabledSubstitutionIds = input.enabledSubstitutionIds
      .filter((substitutionId) => {
        const substitution = substitutionById.get(substitutionId);
        if (!substitution) throw new Error('enabled substitution is not in the controlled catalog');
        return substitution.recipeVersionId === recipeVersionId;
      })
      .sort((left, right) => {
        const priorityDifference =
          substitutionById.get(left)!.priority - substitutionById.get(right)!.priority;
        return priorityDifference || compareStableKey(left, right);
      });
    return {
      recipeVersionId,
      priceModifierPercent: modifier,
      basePrice,
      salePrice: calculateSalePrice(basePrice, modifier),
      enabledSubstitutionIds,
    };
  });
  for (const substitutionId of input.enabledSubstitutionIds) {
    const substitution = substitutionById.get(substitutionId);
    if (!substitution || !input.recipeVersionIds.includes(substitution.recipeVersionId)) {
      throw new Error('enabled substitutions must belong to an active recipe');
    }
  }
  const modifierKeys = Object.keys(input.priceModifierPercentByRecipe);
  if (
    modifierKeys.length !== input.recipeVersionIds.length ||
    modifierKeys.some((id) => !input.recipeVersionIds.includes(id))
  ) {
    throw new Error('price modifiers must match the active recipes exactly');
  }
  return deepFreeze({
    businessDay: input.businessDay,
    difficulty: input.difficulty,
    themeId: input.themeId,
    lockedFrom: 'OPENING_START',
    lockedUntil: 'DAY_END',
    items,
  });
}

export function assertMenuPricesShareCurrency(menu: MenuSelection): string {
  if (menu.items.length === 0) throw new Error('menu cannot be empty');
  const first = menu.items[0]!.salePrice;
  for (const item of menu.items) {
    assertSameCurrency(first, item.basePrice);
    assertSameCurrency(first, item.salePrice);
  }
  return first.currency;
}
