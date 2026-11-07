import type {
  ConfigurePreopenDayIntent,
  PreopenConfigurationChoices,
} from '@econ-game/sdk';

import { GameplayMachineError, type WebGameplayState } from './gameplay-machine.js';
import { WebGameplayRuntime } from './gameplay-runtime.js';

const DRAFT_SCHEMA_VERSION = 'web-preopen-configuration-draft/v1' as const;
const MAX_FIXTURES = 256;
const MAX_PURCHASES = 128;
const MAX_PURCHASE_QUANTITY_POINTS = 100_000;

type MenuDraft = Readonly<{
  recipeVersionIds: readonly string[];
  priceModifierPercentByRecipe: Readonly<Record<string, number>>;
  enabledSubstitutionIds: readonly string[];
}>;

type PurchaseDraft = Readonly<{
  /** The API contract calls this field ingredientId; it is the locked quote's unique locator. */
  quoteIngredientId: string;
  quantityPoints: number;
}>;

export type PreopenFixtureSelection = Readonly<{
  kind: 'SEAT' | 'WALKWAY' | 'WAITING_ZONE';
  x: number;
  y: number;
}>;

type LayoutDraft = Readonly<{
  servicePoint: Readonly<{ x: number; y: number }>;
  fixtures: readonly PreopenFixtureSelection[];
}>;

type ConfigurationDraft = Readonly<{
  menu?: MenuDraft;
  purchases: readonly PurchaseDraft[];
  layout?: LayoutDraft;
}>;

type ChoicesPin = Readonly<{
  saveId: string;
  expectedVersion: number;
  businessDay: 1;
  scenario: string;
  operatingMode: string;
  servicePeriodPlan: string;
  servicePeriods: string;
  preopenSchema: string;
  openingCatalog: string;
  simulationRule: string;
  currencyMetadata: string;
  catalog: string;
  ingredientCatalog: string;
  recipeCatalog: string;
  substitutionCatalog: string;
  floorSpace: string;
}>;

type StoredDraft = Readonly<{
  schemaVersion: typeof DRAFT_SCHEMA_VERSION;
  pin: ChoicesPin;
  draft: ConfigurationDraft;
}>;

export type PreopenConfigurationDraftStore = Readonly<{
  read: () => unknown | undefined;
  write: (draft: StoredDraft) => void;
  clear: () => void;
}>;

export type PreopenConfigurationState =
  | Readonly<{ tag: 'idle' }>
  | Readonly<{
      tag: 'ready';
      choices: PreopenConfigurationChoices;
      draft: ConfigurationDraft;
    }>
  | Readonly<{
      tag: 'reconsider';
      code: 'CONFIGURATION_VERSION_CHANGED' | 'CONFIGURATION_STATE_CHANGED';
    }>
  | Readonly<{
      tag: 'unavailable';
      code:
        | 'PREOPEN_EQUIPMENT_INSTALLATION_REQUIRED'
        | 'PREOPEN_CONFIGURATION_CHOICES_UNAVAILABLE'
        | 'PREOPEN_CONFIGURATION_CHOICES_INVALID';
    }>;

/**
 * Pure Web form controller for CONFIGURE_PREOPEN_DAY. It turns selections from
 * a validated server choices document into the deliberately small command
 * intent; it never receives client-controlled authority or catalog metadata.
 */
export class WebPreopenConfigurationRuntime {
  private currentState: PreopenConfigurationState = Object.freeze({ tag: 'idle' });

  constructor(
    private readonly gameplay: WebGameplayRuntime,
    private readonly drafts: PreopenConfigurationDraftStore = noDraftStore,
  ) {}

  get state(): PreopenConfigurationState {
    return this.currentState;
  }

  /** Load choices only from a current CONFIGURE_REQUIRED projection. */
  async load(): Promise<PreopenConfigurationState> {
    if (this.gameplay.state.tag !== 'configure') {
      this.currentState = Object.freeze({
        tag: 'reconsider',
        code: 'CONFIGURATION_STATE_CHANGED',
      });
      return this.currentState;
    }
    try {
      const choices = await this.gameplay.getPreopenConfigurationChoices();
      if (choices.save.scenario === 'EMPTY_PREMISES') {
        this.drafts.clear();
        this.currentState = Object.freeze({
          tag: 'unavailable',
          code: 'PREOPEN_EQUIPMENT_INSTALLATION_REQUIRED',
        });
        return this.currentState;
      }
      const draft = this.loadCompatibleDraft(choices) ?? emptyDraft;
      this.currentState = Object.freeze({ tag: 'ready', choices, draft });
      this.persist();
      return this.currentState;
    } catch (error) {
      this.drafts.clear();
      this.currentState = Object.freeze({
        tag: 'unavailable',
        code: unavailableCode(error),
      });
      return this.currentState;
    }
  }

  setMenu(selection: MenuDraft): PreopenConfigurationState {
    const ready = this.requireReady();
    const menu = normalizeMenu(selection, ready.choices);
    this.currentState = Object.freeze({
      tag: 'ready',
      choices: ready.choices,
      draft: Object.freeze({ ...ready.draft, menu }),
    });
    this.persist();
    return this.currentState;
  }

  /** Zero is accepted in the form but omitted from the command intent. */
  setPurchases(selections: readonly PurchaseDraft[]): PreopenConfigurationState {
    const ready = this.requireReady();
    const purchases = normalizePurchases(selections, ready.choices);
    this.currentState = Object.freeze({
      tag: 'ready',
      choices: ready.choices,
      draft: Object.freeze({ ...ready.draft, purchases }),
    });
    this.persist();
    return this.currentState;
  }

  /** Fixture IDs are generated from the locked kind and grid location, not supplied by the UI. */
  setLayout(layout: LayoutDraft): PreopenConfigurationState {
    const ready = this.requireReady();
    const normalized = normalizeLayout(layout, ready.choices);
    this.currentState = Object.freeze({
      tag: 'ready',
      choices: ready.choices,
      draft: Object.freeze({ ...ready.draft, layout: normalized }),
    });
    this.persist();
    return this.currentState;
  }

  /**
   * Dispatches exactly one CONFIGURE request through the existing gameplay
   * runtime. A changed version causes an explicit reload/reconsideration and
   * never auto-resubmits the old form.
   */
  async submit(command: Readonly<{ commandId: string; idempotencyKey: string }>): Promise<WebGameplayState> {
    const ready = this.requireReady();
    assertClientRequestIds(command);
    const intent = buildConfigureIntent(ready.choices, ready.draft);
    const current = this.gameplay.state;
    if (
      current.tag !== 'configure' ||
      current.projection.save.id !== ready.choices.save.id ||
      current.projection.expectedVersion !== ready.choices.save.expectedVersion
    ) {
      return this.reconsider();
    }

    const result = await this.gameplay.configure(
      Object.freeze({
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        expectedVersion: ready.choices.save.expectedVersion,
        payload: intent,
      }),
    );

    if (
      result.tag === 'configure' ||
      (result.tag === 'failure' && result.status === 409) ||
      this.gameplay.state.tag === 'configure' &&
        this.gameplay.state.projection.expectedVersion !== ready.choices.save.expectedVersion
    ) {
      return this.reconsider();
    }
    if (result.tag !== 'failure') {
      this.drafts.clear();
      this.currentState = Object.freeze({ tag: 'idle' });
    }
    return result;
  }

  private reconsider(): WebGameplayState {
    this.drafts.clear();
    this.currentState = Object.freeze({
      tag: 'reconsider',
      code: 'CONFIGURATION_VERSION_CHANGED',
    });
    return this.gameplay.state;
  }

  private requireReady(): Extract<PreopenConfigurationState, { tag: 'ready' }> {
    if (this.currentState.tag !== 'ready') {
      throw new GameplayMachineError('PREOPEN_CONFIGURATION_NOT_READY');
    }
    return this.currentState;
  }

  private loadCompatibleDraft(choices: PreopenConfigurationChoices): ConfigurationDraft | undefined {
    const stored = decodeStoredDraft(this.drafts.read());
    if (!stored || !samePin(stored.pin, choices)) {
      if (stored) this.drafts.clear();
      return undefined;
    }
    try {
      const menu = stored.draft.menu ? normalizeMenu(stored.draft.menu, choices) : undefined;
      const purchases = normalizePurchases(stored.draft.purchases, choices);
      const layout = stored.draft.layout ? normalizeLayout(stored.draft.layout, choices) : undefined;
      return Object.freeze({ ...(menu ? { menu } : {}), purchases, ...(layout ? { layout } : {}) });
    } catch {
      this.drafts.clear();
      return undefined;
    }
  }

  private persist(): void {
    const state = this.currentState;
    if (state.tag !== 'ready') return;
    this.drafts.write(
      Object.freeze({
        schemaVersion: DRAFT_SCHEMA_VERSION,
        pin: pinChoices(state.choices),
        draft: state.draft,
      }),
    );
  }
}

export function buildConfigureIntent(
  choices: PreopenConfigurationChoices,
  draft: ConfigurationDraft,
): ConfigurePreopenDayIntent {
  const menu = draft.menu ? normalizeMenu(draft.menu, choices) : undefined;
  const layout = draft.layout ? normalizeLayout(draft.layout, choices) : undefined;
  if (!menu || !layout) throw new GameplayMachineError('PREOPEN_CONFIGURATION_INCOMPLETE');
  const purchases = normalizePurchases(draft.purchases, choices);
  return Object.freeze({
    menuChoice: Object.freeze({
      themeId: choices.menu.themeId,
      recipeVersionIds: Object.freeze([...menu.recipeVersionIds]),
      priceModifierPercentByRecipe: Object.freeze({ ...menu.priceModifierPercentByRecipe }),
      enabledSubstitutionIds: Object.freeze([...menu.enabledSubstitutionIds]),
    }),
    floorPlan: Object.freeze({
      width: choices.floor.width,
      height: choices.floor.height,
      servicePoint: Object.freeze({ ...layout.servicePoint }),
      fixtures: Object.freeze(
        layout.fixtures
          .map((fixture) =>
            Object.freeze({
              fixtureId: fixtureIdFor(fixture),
              kind: fixture.kind,
              x: fixture.x,
              y: fixture.y,
            }),
          )
          .sort((left, right) => compareAscii(left.fixtureId, right.fixtureId)),
      ),
    }),
    spotPurchaseDeltas: Object.freeze(
      purchases
        .filter((purchase) => purchase.quantityPoints > 0)
        .map((purchase) =>
          Object.freeze({
            ingredientId: purchase.quoteIngredientId,
            quantityPoints: purchase.quantityPoints,
          }),
        )
        .sort((left, right) => compareAscii(left.ingredientId, right.ingredientId)),
    ),
  });
}

const emptyDraft: ConfigurationDraft = Object.freeze({ purchases: Object.freeze([]) });

const noDraftStore: PreopenConfigurationDraftStore = Object.freeze({
  read: () => undefined,
  write: () => undefined,
  clear: () => undefined,
});

function normalizeMenu(selection: MenuDraft, choices: PreopenConfigurationChoices): MenuDraft {
  if (!isPlainRecord(selection) || !exactKeys(selection, ['enabledSubstitutionIds', 'priceModifierPercentByRecipe', 'recipeVersionIds'])) {
    throw new GameplayMachineError('PREOPEN_MENU_SELECTION_INVALID');
  }
  if (!Array.isArray(selection.recipeVersionIds) || selection.recipeVersionIds.length !== choices.menu.requiredRecipeCount) {
    throw new GameplayMachineError('PREOPEN_MENU_RECIPE_COUNT_INVALID');
  }
  const cards = new Map(choices.menu.recipeCards.map((card) => [card.recipeVersionId, card]));
  const recipeVersionIds = selection.recipeVersionIds.map(assertIdentifier);
  if (new Set(recipeVersionIds).size !== recipeVersionIds.length || recipeVersionIds.some((id) => !cards.has(id))) {
    throw new GameplayMachineError('PREOPEN_MENU_RECIPE_INVALID');
  }
  if (!isPlainRecord(selection.priceModifierPercentByRecipe)) {
    throw new GameplayMachineError('PREOPEN_MENU_PRICE_INVALID');
  }
  const modifiers: Record<string, number> = {};
  if (!sameIdentifiers(Object.keys(selection.priceModifierPercentByRecipe), recipeVersionIds)) {
    throw new GameplayMachineError('PREOPEN_MENU_PRICE_INVALID');
  }
  for (const recipeVersionId of recipeVersionIds) {
    const modifier = selection.priceModifierPercentByRecipe[recipeVersionId];
    if (
      typeof modifier !== 'number' ||
      !Number.isSafeInteger(modifier) ||
      !cards.get(recipeVersionId)?.priceOptions.some((option) => option.modifierPercent === modifier)
    ) {
      throw new GameplayMachineError('PREOPEN_MENU_PRICE_INVALID');
    }
    modifiers[recipeVersionId] = modifier;
  }
  if (!Array.isArray(selection.enabledSubstitutionIds)) {
    throw new GameplayMachineError('PREOPEN_MENU_SUBSTITUTION_INVALID');
  }
  const substitutions = selection.enabledSubstitutionIds.map(assertIdentifier);
  if (new Set(substitutions).size !== substitutions.length) {
    throw new GameplayMachineError('PREOPEN_MENU_SUBSTITUTION_INVALID');
  }
  const allowed = new Set(
    recipeVersionIds.flatMap((recipeVersionId) => cards.get(recipeVersionId)?.substitutionIds ?? []),
  );
  if (substitutions.some((id) => !allowed.has(id))) {
    throw new GameplayMachineError('PREOPEN_MENU_SUBSTITUTION_INVALID');
  }
  return Object.freeze({
    recipeVersionIds: Object.freeze([...recipeVersionIds]),
    priceModifierPercentByRecipe: Object.freeze(Object.fromEntries(Object.entries(modifiers).sort(([a], [b]) => compareAscii(a, b)))),
    enabledSubstitutionIds: Object.freeze([...substitutions].sort(compareAscii)),
  });
}

function normalizePurchases(
  selections: readonly PurchaseDraft[],
  choices: PreopenConfigurationChoices,
): readonly PurchaseDraft[] {
  if (!Array.isArray(selections) || selections.length > MAX_PURCHASES) {
    throw new GameplayMachineError('PREOPEN_PURCHASE_INVALID');
  }
  const quotes = new Map(choices.procurement.lockedDay1Quotes.map((quote) => [quote.ingredientId, quote]));
  const seen = new Set<string>();
  const totals: Record<'DURABLE' | 'PERISHABLE', number> = { DURABLE: 0, PERISHABLE: 0 };
  let totalCost = 0n;
  const purchases = selections.map((selection) => {
    if (!isPlainRecord(selection) || !exactKeys(selection, ['quantityPoints', 'quoteIngredientId'])) {
      throw new GameplayMachineError('PREOPEN_PURCHASE_INVALID');
    }
    const quoteIngredientId = assertIdentifier(selection.quoteIngredientId);
    const quantityPoints = selection.quantityPoints;
    const quote = quotes.get(quoteIngredientId);
    if (
      !quote ||
      seen.has(quoteIngredientId) ||
      !nonNegativeInteger(quantityPoints) ||
      quantityPoints > MAX_PURCHASE_QUANTITY_POINTS
    ) {
      throw new GameplayMachineError('PREOPEN_PURCHASE_INVALID');
    }
    seen.add(quoteIngredientId);
    totals[quote.pool] += quantityPoints;
    totalCost += BigInt(quote.unitPrice.minorUnits) * BigInt(quantityPoints);
    return Object.freeze({ quoteIngredientId, quantityPoints });
  });
  if (
    totals.DURABLE > choices.procurement.poolCapacities.DURABLE ||
    totals.PERISHABLE > choices.procurement.poolCapacities.PERISHABLE ||
    totalCost > BigInt(choices.procurement.spendLimit.minorUnits)
  ) {
    throw new GameplayMachineError('PREOPEN_PURCHASE_CAPACITY_INVALID');
  }
  return Object.freeze([...purchases].sort((left, right) => compareAscii(left.quoteIngredientId, right.quoteIngredientId)));
}

function normalizeLayout(layout: LayoutDraft, choices: PreopenConfigurationChoices): LayoutDraft {
  if (!isPlainRecord(layout) || !exactKeys(layout, ['fixtures', 'servicePoint']) || !Array.isArray(layout.fixtures)) {
    throw new GameplayMachineError('PREOPEN_LAYOUT_INVALID');
  }
  const servicePoint = normalizePoint(layout.servicePoint, choices);
  if (layout.fixtures.length > MAX_FIXTURES || layout.fixtures.length > choices.floor.usableFloorCells - 1) {
    throw new GameplayMachineError('PREOPEN_LAYOUT_INVALID');
  }
  const usedCells = new Set<string>([pointKey(servicePoint)]);
  let seats = 0;
  let waiting = 0;
  const fixtures = layout.fixtures.map((fixture) => {
    if (!isPlainRecord(fixture) || !exactKeys(fixture, ['kind', 'x', 'y'])) {
      throw new GameplayMachineError('PREOPEN_LAYOUT_INVALID');
    }
    if (!choices.floor.allowedFixtureKinds.includes(fixture.kind as PreopenFixtureSelection['kind'])) {
      throw new GameplayMachineError('PREOPEN_LAYOUT_FIXTURE_INVALID');
    }
    const point = normalizePoint(fixture, choices);
    const key = pointKey(point);
    if (usedCells.has(key)) throw new GameplayMachineError('PREOPEN_LAYOUT_OVERLAP');
    usedCells.add(key);
    if (fixture.kind === 'SEAT') seats += 1;
    if (fixture.kind === 'WAITING_ZONE') waiting += 1;
    return Object.freeze({ kind: fixture.kind as PreopenFixtureSelection['kind'], ...point });
  });
  if (seats > choices.floor.maxSeats || waiting > choices.floor.maxWaitingGroups) {
    throw new GameplayMachineError('PREOPEN_LAYOUT_CAPACITY_INVALID');
  }
  const walkways = new Set(fixtures.filter((fixture) => fixture.kind === 'WALKWAY').map(pointKey));
  const reachable = reachableWalkways(servicePoint, walkways);
  if (
    fixtures.some(
      (fixture) =>
        fixture.kind !== 'WALKWAY' &&
        !adjacent(fixture).some((point) => reachable.has(pointKey(point))),
    )
  ) {
    throw new GameplayMachineError('PREOPEN_LAYOUT_WALKWAY_INVALID');
  }
  return Object.freeze({
    servicePoint,
    fixtures: Object.freeze([...fixtures].sort((left, right) => compareAscii(fixtureIdFor(left), fixtureIdFor(right)))),
  });
}

function normalizePoint(
  value: unknown,
  choices: PreopenConfigurationChoices,
): Readonly<{ x: number; y: number }> {
  if (!isPlainRecord(value) || !Object.hasOwn(value, 'x') || !Object.hasOwn(value, 'y')) {
    throw new GameplayMachineError('PREOPEN_LAYOUT_GRID_INVALID');
  }
  const x = value.x;
  const y = value.y;
  if (!nonNegativeInteger(x) || !nonNegativeInteger(y) || x >= choices.floor.width || y >= choices.floor.height) {
    throw new GameplayMachineError('PREOPEN_LAYOUT_GRID_INVALID');
  }
  return Object.freeze({ x, y });
}

function reachableWalkways(
  servicePoint: Readonly<{ x: number; y: number }>,
  walkways: ReadonlySet<string>,
): ReadonlySet<string> {
  const reachable = new Set<string>([pointKey(servicePoint)]);
  const queue = [servicePoint];
  for (let index = 0; index < queue.length; index += 1) {
    for (const point of adjacent(queue[index]!)) {
      const key = pointKey(point);
      if (walkways.has(key) && !reachable.has(key)) {
        reachable.add(key);
        queue.push(point);
      }
    }
  }
  return reachable;
}

function adjacent(point: Readonly<{ x: number; y: number }>): readonly Readonly<{ x: number; y: number }>[] {
  return Object.freeze([
    Object.freeze({ x: point.x - 1, y: point.y }),
    Object.freeze({ x: point.x + 1, y: point.y }),
    Object.freeze({ x: point.x, y: point.y - 1 }),
    Object.freeze({ x: point.x, y: point.y + 1 }),
  ]);
}

function fixtureIdFor(fixture: PreopenFixtureSelection): string {
  return `fixture:${fixture.kind}:${fixture.x}:${fixture.y}`;
}

function pointKey(point: Readonly<{ x: number; y: number }>): string {
  return `${point.x},${point.y}`;
}

function pinChoices(choices: PreopenConfigurationChoices): ChoicesPin {
  return Object.freeze({
    saveId: choices.save.id,
    expectedVersion: choices.save.expectedVersion,
    businessDay: choices.businessDay,
    scenario: choices.save.scenario,
    operatingMode: choices.save.operatingMode,
    servicePeriodPlan: choices.save.servicePeriodPlan,
    servicePeriods: choices.save.servicePeriods.join(','),
    preopenSchema: choices.versions.preopenSchema,
    openingCatalog: choices.versions.openingCatalog,
    simulationRule: choices.versions.simulationRule,
    currencyMetadata: choices.versions.currencyMetadata,
    catalog: choices.versions.catalog,
    ingredientCatalog: choices.versions.ingredientCatalog,
    recipeCatalog: choices.versions.recipeCatalog,
    substitutionCatalog: choices.versions.substitutionCatalog,
    floorSpace: choices.versions.floorSpace,
  });
}

function samePin(pin: ChoicesPin, choices: PreopenConfigurationChoices): boolean {
  const expected = pinChoices(choices);
  return Object.entries(expected).every(([key, value]) => pin[key as keyof ChoicesPin] === value);
}

function decodeStoredDraft(value: unknown): StoredDraft | undefined {
  if (!isPlainRecord(value) || !exactKeys(value, ['draft', 'pin', 'schemaVersion']) || value.schemaVersion !== DRAFT_SCHEMA_VERSION || !isPlainRecord(value.pin) || !isPlainRecord(value.draft)) {
    return undefined;
  }
  const pin = value.pin;
  const pinKeys = ['businessDay', 'catalog', 'currencyMetadata', 'expectedVersion', 'floorSpace', 'ingredientCatalog', 'openingCatalog', 'operatingMode', 'preopenSchema', 'recipeCatalog', 'saveId', 'scenario', 'servicePeriodPlan', 'servicePeriods', 'simulationRule', 'substitutionCatalog'];
  if (!exactKeys(pin, pinKeys) || pin.businessDay !== 1 || !nonEmptyString(pin.saveId) || !nonNegativeInteger(pin.expectedVersion) || pinKeys.filter((key) => !['businessDay', 'expectedVersion', 'saveId'].includes(key)).some((key) => !nonEmptyString(pin[key]))) {
    return undefined;
  }
  const draft = value.draft;
  if (!exactKeys(draft, Object.hasOwn(draft, 'menu') && Object.hasOwn(draft, 'layout') ? ['layout', 'menu', 'purchases'] : Object.hasOwn(draft, 'menu') ? ['menu', 'purchases'] : Object.hasOwn(draft, 'layout') ? ['layout', 'purchases'] : ['purchases']) || !Array.isArray(draft.purchases)) {
    return undefined;
  }
  return Object.freeze({ schemaVersion: DRAFT_SCHEMA_VERSION, pin: pin as ChoicesPin, draft: draft as ConfigurationDraft });
}

function unavailableCode(error: unknown): Extract<PreopenConfigurationState, { tag: 'unavailable' }>['code'] {
  const code = errorCode(error);
  if (code === 'PREOPEN_EQUIPMENT_INSTALLATION_REQUIRED') return code;
  if (code === 'GAMEPLAY_RESPONSE_INVALID' || error instanceof TypeError) return 'PREOPEN_CONFIGURATION_CHOICES_INVALID';
  return 'PREOPEN_CONFIGURATION_CHOICES_UNAVAILABLE';
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
  return descriptor && 'value' in descriptor && typeof descriptor.value === 'string'
    ? descriptor.value
    : undefined;
}

function assertClientRequestIds(value: Readonly<{ commandId: string; idempotencyKey: string }>): void {
  if (!nonEmptyString(value.commandId) || !nonEmptyString(value.idempotencyKey)) {
    throw new GameplayMachineError('PREOPEN_CONFIGURATION_COMMAND_ID_INVALID');
  }
}

function assertIdentifier(value: unknown): string {
  if (!nonEmptyString(value)) throw new GameplayMachineError('PREOPEN_CONFIGURATION_IDENTIFIER_INVALID');
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareAscii);
  const sortedExpected = [...expected].sort(compareAscii);
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function sameIdentifiers(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && [...actual].sort(compareAscii).every((id, index) => id === [...expected].sort(compareAscii)[index]);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && value.trim() === value;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
