/**
 * Request-only contract for the pre-open boundary.  It deliberately contains
 * no actor, save, day, catalog, rules, cash, seed, forecast, or snapshot
 * authority; those values are supplied by the server-side factory.
 */
export const PREOPEN_DAY_ENVELOPE_VERSION = 'p0-preopen-day/v1' as const;

export type GridPointIntent = Readonly<{ x: number; y: number }>;
export type FloorFixtureIntent = Readonly<
  GridPointIntent & { fixtureId: string; kind: 'SEAT' | 'WALKWAY' | 'WAITING_ZONE' }
>;
export type ConfigurePreopenDayIntent = Readonly<{
  menuChoice: Readonly<{
    themeId: string;
    recipeVersionIds: readonly string[];
    priceModifierPercentByRecipe: Readonly<Record<string, number>>;
    enabledSubstitutionIds: readonly string[];
  }>;
  floorPlan: Readonly<{
    width: number;
    height: number;
    servicePoint: GridPointIntent;
    fixtures: readonly FloorFixtureIntent[];
  }>;
  spotPurchaseDeltas: readonly Readonly<{ ingredientId: string; quantityPoints: number }>[];
}>;

export type OpenBusinessDayIntent = Readonly<{
  preopenSnapshotId: string;
  preopenSnapshotHash: string;
}>;

/** This can be consumed by a future command catalog without assigning policy there. */
export type PreopenDayIntentByCommand = Readonly<{
  CONFIGURE_PREOPEN_DAY: ConfigurePreopenDayIntent;
  OPEN_BUSINESS_DAY: OpenBusinessDayIntent;
}>;

const limits = Object.freeze({
  idLength: 128,
  recipeCount: 16,
  substitutionCount: 64,
  fixtureCount: 256,
  purchaseCount: 128,
  dimension: 64,
  coordinate: 63,
  quantityPoints: 100_000,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  name: string,
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${name} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${name} has unknown or missing fields`);
  }
  return value;
}

function stringId(value: unknown, name: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > limits.idLength ||
    value.trim() !== value
  ) {
    throw new Error(`${name} must be a bounded non-empty identifier`);
  }
  return value;
}

function integer(value: unknown, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${name} must be an integer from ${min} through ${max}`);
  }
  return value as number;
}

function point(value: unknown, name: string): GridPointIntent {
  const record = exactRecord(value, ['x', 'y'], name);
  return Object.freeze({
    x: integer(record.x, `${name}.x`, 0, limits.coordinate),
    y: integer(record.y, `${name}.y`, 0, limits.coordinate),
  });
}

function boundedArray(value: unknown, name: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum)
    throw new Error(`${name} exceeds its resource limit`);
  return value;
}

function unique(ids: readonly string[], name: string): void {
  if (new Set(ids).size !== ids.length) throw new Error(`${name} must not contain duplicates`);
}

export function parseConfigurePreopenDayIntent(value: unknown): ConfigurePreopenDayIntent {
  const root = exactRecord(
    value,
    ['floorPlan', 'menuChoice', 'spotPurchaseDeltas'],
    'configure pre-open intent',
  );
  const menu = exactRecord(
    root.menuChoice,
    ['enabledSubstitutionIds', 'priceModifierPercentByRecipe', 'recipeVersionIds', 'themeId'],
    'menuChoice',
  );
  const recipeVersionIds = boundedArray(
    menu.recipeVersionIds,
    'recipeVersionIds',
    limits.recipeCount,
  ).map((recipe, index) => stringId(recipe, `recipeVersionIds[${index}]`));
  if (recipeVersionIds.length === 0) throw new Error('recipeVersionIds must not be empty');
  unique(recipeVersionIds, 'recipeVersionIds');
  const substitutions = boundedArray(
    menu.enabledSubstitutionIds,
    'enabledSubstitutionIds',
    limits.substitutionCount,
  ).map((substitution, index) => stringId(substitution, `enabledSubstitutionIds[${index}]`));
  unique(substitutions, 'enabledSubstitutionIds');
  const rawPriceModifiers = menu.priceModifierPercentByRecipe;
  if (!isRecord(rawPriceModifiers)) {
    throw new Error('priceModifierPercentByRecipe must be an object');
  }
  const priceKeys = Object.keys(rawPriceModifiers);
  if (
    priceKeys.length !== recipeVersionIds.length ||
    priceKeys.some((id) => !recipeVersionIds.includes(id))
  ) {
    throw new Error('priceModifierPercentByRecipe must match recipeVersionIds exactly');
  }
  const priceModifierPercentByRecipe = Object.freeze(
    Object.fromEntries(
      [...recipeVersionIds]
        .sort()
        .map((id) => [id, integer(rawPriceModifiers[id], `price for ${id}`, -10, 10)]),
    ),
  );
  const floor = exactRecord(
    root.floorPlan,
    ['fixtures', 'height', 'servicePoint', 'width'],
    'floorPlan',
  );
  const width = integer(floor.width, 'floorPlan.width', 1, limits.dimension);
  const height = integer(floor.height, 'floorPlan.height', 1, limits.dimension);
  const servicePoint = point(floor.servicePoint, 'floorPlan.servicePoint');
  if (servicePoint.x >= width || servicePoint.y >= height)
    throw new Error('servicePoint must be inside floorPlan');
  const fixtures = boundedArray(floor.fixtures, 'fixtures', limits.fixtureCount).map(
    (fixture, index) => {
      const record = exactRecord(fixture, ['fixtureId', 'kind', 'x', 'y'], `fixtures[${index}]`);
      const kind = record.kind;
      if (kind !== 'SEAT' && kind !== 'WALKWAY' && kind !== 'WAITING_ZONE') {
        throw new Error(`fixtures[${index}].kind is not permitted`);
      }
      const parsed: FloorFixtureIntent = {
        fixtureId: stringId(record.fixtureId, `fixtures[${index}].fixtureId`),
        kind,
        x: integer(record.x, `fixtures[${index}].x`, 0, limits.coordinate),
        y: integer(record.y, `fixtures[${index}].y`, 0, limits.coordinate),
      };
      if (parsed.x >= width || parsed.y >= height)
        throw new Error(`fixtures[${index}] must be inside floorPlan`);
      return Object.freeze(parsed);
    },
  );
  unique(
    fixtures.map((fixture) => fixture.fixtureId),
    'fixture IDs',
  );
  const occupied = new Set<string>();
  for (const fixture of fixtures) {
    const key = `${fixture.x},${fixture.y}`;
    if (key === `${servicePoint.x},${servicePoint.y}` || occupied.has(key)) {
      throw new Error('fixtures cannot overlap each other or servicePoint');
    }
    occupied.add(key);
  }
  const spotPurchaseDeltas = boundedArray(
    root.spotPurchaseDeltas,
    'spotPurchaseDeltas',
    limits.purchaseCount,
  ).map((purchase, index) => {
    const record = exactRecord(
      purchase,
      ['ingredientId', 'quantityPoints'],
      `spotPurchaseDeltas[${index}]`,
    );
    return Object.freeze({
      ingredientId: stringId(record.ingredientId, `spotPurchaseDeltas[${index}].ingredientId`),
      quantityPoints: integer(
        record.quantityPoints,
        `spotPurchaseDeltas[${index}].quantityPoints`,
        1,
        limits.quantityPoints,
      ),
    });
  });
  unique(
    spotPurchaseDeltas.map((purchase) => purchase.ingredientId),
    'spot purchase ingredient IDs',
  );
  return Object.freeze({
    menuChoice: Object.freeze({
      themeId: stringId(menu.themeId, 'menuChoice.themeId'),
      recipeVersionIds: Object.freeze(recipeVersionIds),
      priceModifierPercentByRecipe,
      enabledSubstitutionIds: Object.freeze(substitutions),
    }),
    floorPlan: Object.freeze({ width, height, servicePoint, fixtures: Object.freeze(fixtures) }),
    spotPurchaseDeltas: Object.freeze(spotPurchaseDeltas),
  });
}

export function parseOpenBusinessDayIntent(value: unknown): OpenBusinessDayIntent {
  const root = exactRecord(
    value,
    ['preopenSnapshotHash', 'preopenSnapshotId'],
    'open business day intent',
  );
  const preopenSnapshotHash = stringId(root.preopenSnapshotHash, 'preopenSnapshotHash');
  if (!/^[a-f0-9]{64}$/.test(preopenSnapshotHash)) {
    throw new Error('preopenSnapshotHash must be a SHA-256 hex digest');
  }
  return Object.freeze({
    preopenSnapshotId: stringId(root.preopenSnapshotId, 'preopenSnapshotId'),
    preopenSnapshotHash,
  });
}
