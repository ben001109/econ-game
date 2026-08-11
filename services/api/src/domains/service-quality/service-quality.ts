export const K_WORK = 12;
export const F_WORK = 8;

export type WorkPool = 'KITCHEN' | 'FRONT';
export type ServiceState = 'CREATED' | 'PREPARING' | 'READY' | 'SERVED';
export type Ability = 'LOW' | 'MEDIUM' | 'HIGH';
export type Morale = 'LOW' | 'NORMAL' | 'HIGH';
export type WorkerKind = 'PLAYER' | 'NPC';
export type EquipmentCondition = 'BASIC' | 'AGED';
export type CustomerCohort = 'PRICE_SENSITIVE' | 'TIME_SENSITIVE' | 'EXPERIENCE_ORIENTED';
export type WorkerRole =
  | 'KITCHEN_STAFF'
  | 'OWNER_KITCHEN'
  | 'MANAGER_KITCHEN'
  | 'CASHIER'
  | 'MANAGER_FRONT'
  | 'OWNER_FRONT';

export const ROLE_BASE: Readonly<Record<WorkerRole, number>> = Object.freeze({
  KITCHEN_STAFF: 1,
  OWNER_KITCHEN: 0.7,
  MANAGER_KITCHEN: 0.55,
  CASHIER: 1,
  MANAGER_FRONT: 0.75,
  OWNER_FRONT: 0.65,
});

export const ABILITY_FACTOR: Readonly<Record<Ability, number>> = Object.freeze({
  LOW: 0.8,
  MEDIUM: 1,
  HIGH: 1.15,
});

export const MORALE_FACTOR: Readonly<Record<Morale, number>> = Object.freeze({
  LOW: 0.9,
  NORMAL: 1,
  HIGH: 1.1,
});

export const COHORT_PATIENCE_FACTOR: Readonly<Record<CustomerCohort, number>> = Object.freeze({
  PRICE_SENSITIVE: 1,
  TIME_SENSITIVE: 0.75,
  EXPERIENCE_ORIENTED: 1.25,
});

const rolePool: Readonly<Record<WorkerRole, WorkPool>> = Object.freeze({
  KITCHEN_STAFF: 'KITCHEN',
  OWNER_KITCHEN: 'KITCHEN',
  MANAGER_KITCHEN: 'KITCHEN',
  CASHIER: 'FRONT',
  MANAGER_FRONT: 'FRONT',
  OWNER_FRONT: 'FRONT',
});

export type WorkerSnapshot = Readonly<{
  id: string;
  role: WorkerRole;
  ability: Ability;
  morale: Morale;
  kind: WorkerKind;
  present: boolean;
}>;

export type EquipmentSnapshot = Readonly<{
  kitchen: EquipmentCondition;
  front: EquipmentCondition;
}>;

export type RecipeServiceSnapshot = Readonly<{
  id: string;
  baseQuality: number;
  substitutionQualityDelta: number;
  recommendedPrice: number;
  salePrice: number;
  portions: number;
}>;

export type CustomerArrival = Readonly<{
  groupId: string;
  arrivalTick: number;
  cohort: CustomerCohort;
  size: number;
  basePatienceTicks: number;
  recipePreferenceOrder: readonly string[];
}>;

export type ServiceTickInput = Readonly<{
  tick: number;
  admissionCapacity: number;
  demand: number;
  queueVisibility: number;
  periodWeight: number;
  authorizedPlayerWorkerIds?: readonly string[];
}>;

export type Reputation = Readonly<{
  price: number;
  speed: number;
  quality: number;
  fairness: number;
  vibe: number;
}>;

export type FairnessInput = Readonly<{
  fulfilledAuthorizedHours: number;
  scheduledAuthorizedHours: number;
}>;

export type ServiceDayInput = Readonly<{
  demandSeed: string;
  recipes: readonly RecipeServiceSnapshot[];
  arrivals: readonly CustomerArrival[];
  ticks: readonly ServiceTickInput[];
  workers: readonly WorkerSnapshot[];
  equipment: EquipmentSnapshot;
  kitchenExecutionQualityModifier: number;
  initialReputation?: Reputation;
  fairness?: FairnessInput;
}>;

export type ReplayEventType =
  | 'GROUP_ARRIVED'
  | 'WAITING_LEFT'
  | 'PREFERRED_SOLD_OUT'
  | 'RESELECTED_ONCE'
  | 'SOLD_OUT_LEFT'
  | 'ORDER_STATE_CHANGED'
  | 'WORK_CONTRIBUTION'
  | 'ORDER_SCORED'
  | 'REPUTATION_UPDATED'
  | 'FAIRNESS_UPDATED'
  | 'FLOW_RISK_HIGH';

export type ReplayEvent = Readonly<{
  sequence: number;
  tick: number;
  type: ReplayEventType;
  subjectId: string;
  details: Readonly<Record<string, string | number | boolean>>;
}>;

export type CompletedOrder = Readonly<{
  id: string;
  groupId: string;
  recipeId: string;
  state: ServiceState;
  createdSequence: number;
  arrivalTick: number;
  createdTick: number;
  servedTick?: number;
  kitchenWork: number;
  frontWork: number;
  patienceTicks: number;
  foodQuality?: number;
  serviceSpeed?: number;
  lowMoraleKitchenContributionApplied: boolean;
}>;

export type ServiceDayResult = Readonly<{
  demandSeed: string;
  orders: readonly CompletedOrder[];
  waitingGroupIds: readonly string[];
  departedGroupIds: readonly string[];
  remainingPortions: Readonly<Record<string, number>>;
  reputation: Reputation;
  flowRiskHigh: boolean;
  events: readonly ReplayEvent[];
}>;

type MutableOrder = {
  id: string;
  groupId: string;
  recipeId: string;
  state: ServiceState;
  createdSequence: number;
  arrivalTick: number;
  createdTick: number;
  servedTick?: number;
  kitchenWork: number;
  frontWork: number;
  patienceTicks: number;
  foodQuality?: number;
  serviceSpeed?: number;
  lowMoraleKitchenContributionApplied: boolean;
};

type WaitingGroup = CustomerArrival & { patienceTicks: number; seedOrder: number };

const DEFAULT_REPUTATION: Reputation = Object.freeze({
  price: 50,
  speed: 50,
  quality: 50,
  fairness: 50,
  vibe: 50,
});

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function freeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nestedValue of Object.values(value)) {
      freeze(nestedValue);
    }
    Object.freeze(value);
  }
  return value;
}

function assertFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be finite`);
  }
}

function stableSeedOrder(seed: string, id: string): number {
  let hash = 2_166_136_261;
  const value = `${seed}:${id}`;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function equipmentWorkFactor(condition: EquipmentCondition, pool: WorkPool): number {
  return condition === 'AGED' && pool === 'KITCHEN' ? 0.85 : 1;
}

function isWorkerActive(worker: WorkerSnapshot, authorizedPlayerIds: ReadonlySet<string>): boolean {
  return worker.present && (worker.kind === 'NPC' || authorizedPlayerIds.has(worker.id));
}

function calculateWorkerCapacity(
  worker: WorkerSnapshot,
  pool: WorkPool,
  equipment: EquipmentSnapshot,
  authorizedPlayerIds: ReadonlySet<string>,
): number {
  if (rolePool[worker.role] !== pool || !isWorkerActive(worker, authorizedPlayerIds)) {
    return 0;
  }
  const condition = pool === 'KITCHEN' ? equipment.kitchen : equipment.front;
  const moraleFactor = worker.kind === 'NPC' ? MORALE_FACTOR[worker.morale] : 1;
  return round(
    ROLE_BASE[worker.role] *
      ABILITY_FACTOR[worker.ability] *
      equipmentWorkFactor(condition, pool) *
      moraleFactor,
  );
}

export function calculateWorkCapacity(
  workers: readonly WorkerSnapshot[],
  pool: WorkPool,
  equipment: EquipmentSnapshot,
  authorizedPlayerWorkerIds: readonly string[] = [],
): number {
  const authorizedPlayerIds = new Set(authorizedPlayerWorkerIds);
  const capacity = workers.reduce(
    (sum, worker) => sum + calculateWorkerCapacity(worker, pool, equipment, authorizedPlayerIds),
    0,
  );

  return round(capacity);
}

export function calculateFoodQuality(
  input: Readonly<{
    recipeBaseQuality: number;
    substitutionQualityDelta: number;
    kitchenExecutionQualityModifier: number;
    equipmentCondition: EquipmentCondition;
    lowMoraleKitchenContribution: boolean;
  }>,
): number {
  const equipmentQualityModifier = input.equipmentCondition === 'AGED' ? -10 : 0;
  const lowMoraleQualityModifier = input.lowMoraleKitchenContribution ? -5 : 0;
  return clamp(
    round(
      input.recipeBaseQuality +
        input.substitutionQualityDelta +
        input.kitchenExecutionQualityModifier +
        equipmentQualityModifier +
        lowMoraleQualityModifier,
    ),
    0,
    100,
  );
}

export function calculateServiceSpeed(waitTicks: number, patienceTicks: number): number {
  assertFinite(waitTicks, 'wait ticks');
  assertFinite(patienceTicks, 'patience ticks');
  if (waitTicks < 0 || patienceTicks <= 0) {
    throw new Error('wait ticks must be non-negative and patience ticks must be positive');
  }
  if (waitTicks <= patienceTicks) {
    return 100;
  }
  return clamp(round(100 * (2 - waitTicks / patienceTicks)), 0, 100);
}

export function calculateQueueCongestion(
  input: Readonly<{
    queueLength: number;
    demand: number;
    queueVisibility: number;
    periodWeight: number;
  }>,
): number {
  for (const [name, value] of Object.entries(input)) {
    assertFinite(value, name);
    if (value < 0) {
      throw new Error(`${name} must be non-negative`);
    }
  }
  if (input.demand <= 0) {
    throw new Error('demand must be positive');
  }
  return round((input.queueLength / input.demand) * input.queueVisibility * input.periodWeight);
}

export function updateOrderReputation(
  reputation: Reputation,
  input: Readonly<{
    salePrice: number;
    recommendedPrice: number;
    serviceSpeed: number;
    foodQuality: number;
    queueCongestion: number;
  }>,
): Reputation {
  if (input.recommendedPrice <= 0) {
    throw new Error('recommended price must be positive');
  }
  const priceDelta = clamp(
    -(input.salePrice - input.recommendedPrice) / input.recommendedPrice / 0.1,
    -2,
    2,
  );
  const speedDelta = clamp((input.serviceSpeed - 75) / 25, -2, 2);
  const qualityDelta = clamp((input.foodQuality - 75) / 25, -2, 2);
  const vibeDelta = clamp((1 - input.queueCongestion) * 2, -2, 2);

  return freeze({
    price: clamp(round(reputation.price + 0.4 * priceDelta), 0, 100),
    speed: clamp(round(reputation.speed + 0.4 * speedDelta), 0, 100),
    quality: clamp(round(reputation.quality + 0.4 * qualityDelta), 0, 100),
    fairness: clamp(reputation.fairness, 0, 100),
    vibe: clamp(round(reputation.vibe + 0.4 * vibeDelta), 0, 100),
  });
}

export function updateFairnessReputation(
  reputation: Reputation,
  fairness: FairnessInput,
): Reputation {
  assertFinite(fairness.fulfilledAuthorizedHours, 'fulfilled authorized hours');
  assertFinite(fairness.scheduledAuthorizedHours, 'scheduled authorized hours');
  if (fairness.fulfilledAuthorizedHours < 0 || fairness.scheduledAuthorizedHours <= 0) {
    throw new Error('fairness hours must be non-negative with positive scheduled hours');
  }
  const delta = clamp(
    (fairness.fulfilledAuthorizedHours / fairness.scheduledAuthorizedHours - 0.8) * 5,
    -2,
    2,
  );
  return freeze({
    ...reputation,
    fairness: clamp(round(reputation.fairness + 0.4 * delta), 0, 100),
  });
}

function validateReputation(reputation: Reputation): void {
  for (const [dimension, score] of Object.entries(reputation)) {
    assertFinite(score, `${dimension} reputation`);
    if (score < 0 || score > 100) {
      throw new Error(`${dimension} reputation must be between 0 and 100`);
    }
  }
}

function validateInput(input: ServiceDayInput): void {
  if (input.demandSeed.trim().length === 0) {
    throw new Error('demand seed is required');
  }
  assertFinite(input.kitchenExecutionQualityModifier, 'kitchen execution quality modifier');

  const recipeIds = new Set<string>();
  for (const recipe of input.recipes) {
    if (recipe.id.length === 0 || recipeIds.has(recipe.id)) {
      throw new Error('recipe ids must be non-empty and unique');
    }
    recipeIds.add(recipe.id);
    if (recipe.baseQuality < 75 || recipe.baseQuality > 90) {
      throw new Error('recipe base quality must be between 75 and 90');
    }
    if (recipe.substitutionQualityDelta < -10 || recipe.substitutionQualityDelta > 0) {
      throw new Error('substitution quality delta must be between -10 and 0');
    }
    if (recipe.recommendedPrice <= 0 || recipe.salePrice < 0) {
      throw new Error('recipe prices must be non-negative with a positive recommended price');
    }
    if (!Number.isInteger(recipe.portions) || recipe.portions < 0) {
      throw new Error('recipe portions must be a non-negative integer');
    }
  }

  const tickNumbers = new Set<number>();
  for (const tick of input.ticks) {
    if (!Number.isInteger(tick.tick) || tick.tick < 0 || tickNumbers.has(tick.tick)) {
      throw new Error('tick numbers must be unique non-negative integers');
    }
    tickNumbers.add(tick.tick);
    if (!Number.isInteger(tick.admissionCapacity) || tick.admissionCapacity < 0) {
      throw new Error('admission capacity must be a non-negative integer');
    }
    calculateQueueCongestion({
      queueLength: 0,
      demand: tick.demand,
      queueVisibility: tick.queueVisibility,
      periodWeight: tick.periodWeight,
    });
  }

  const workerIds = new Set<string>();
  for (const worker of input.workers) {
    if (worker.id.length === 0 || workerIds.has(worker.id)) {
      throw new Error('worker ids must be non-empty and unique');
    }
    workerIds.add(worker.id);
  }

  const groupIds = new Set<string>();
  for (const arrival of input.arrivals) {
    if (arrival.groupId.length === 0 || groupIds.has(arrival.groupId)) {
      throw new Error('group ids must be non-empty and unique');
    }
    groupIds.add(arrival.groupId);
    if (!tickNumbers.has(arrival.arrivalTick)) {
      throw new Error('each arrival must reference a supplied tick');
    }
    if (!Number.isInteger(arrival.size) || arrival.size <= 0 || arrival.basePatienceTicks <= 0) {
      throw new Error('group size and base patience must be positive');
    }
    const preferences = new Set(arrival.recipePreferenceOrder);
    if (
      preferences.size !== arrival.recipePreferenceOrder.length ||
      arrival.recipePreferenceOrder.length === 0 ||
      arrival.recipePreferenceOrder.some((recipeId) => !recipeIds.has(recipeId))
    ) {
      throw new Error('recipe preference order must contain unique known recipe ids');
    }
  }

  validateReputation(input.initialReputation ?? DEFAULT_REPUTATION);
  if (input.fairness !== undefined) {
    updateFairnessReputation(input.initialReputation ?? DEFAULT_REPUTATION, input.fairness);
  }
}

function allocateWork(
  orders: MutableOrder[],
  state: ServiceState,
  workKey: 'kitchenWork' | 'frontWork',
  requirement: number,
  capacity: number,
  onCompleted: (order: MutableOrder) => void,
  onContribution?: (order: MutableOrder, contribution: number) => void,
): void {
  let remainingCapacity = capacity;
  const stableOrders = [...orders].sort(
    (left, right) =>
      left.createdSequence - right.createdSequence ||
      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  );
  for (const order of stableOrders) {
    if (order.state !== state || remainingCapacity <= 0) {
      continue;
    }
    const remainingWork = requirement - order[workKey];
    const contribution = Math.min(remainingWork, remainingCapacity);
    order[workKey] = round(order[workKey] + contribution);
    remainingCapacity = round(remainingCapacity - contribution);
    onContribution?.(order, contribution);
    if (order[workKey] >= requirement) {
      order[workKey] = requirement;
      onCompleted(order);
    }
  }
}

export function simulateServiceDay(input: ServiceDayInput): ServiceDayResult {
  validateInput(input);

  const recipes = new Map(input.recipes.map((recipe) => [recipe.id, recipe]));
  const remainingPortions = Object.fromEntries(
    input.recipes.map((recipe) => [recipe.id, recipe.portions]),
  );
  const ticks = [...input.ticks].sort((left, right) => left.tick - right.tick);
  const arrivalsByTick = new Map<number, CustomerArrival[]>();
  for (const arrival of input.arrivals) {
    const arrivals = arrivalsByTick.get(arrival.arrivalTick) ?? [];
    arrivals.push(arrival);
    arrivalsByTick.set(arrival.arrivalTick, arrivals);
  }

  const waiting: WaitingGroup[] = [];
  const departedGroupIds: string[] = [];
  const orders: MutableOrder[] = [];
  const events: ReplayEvent[] = [];
  let reputation: Reputation = freeze({ ...(input.initialReputation ?? DEFAULT_REPUTATION) });
  let highFlowStreak = 0;
  let flowRiskHigh = false;

  const emit = (
    tick: number,
    type: ReplayEventType,
    subjectId: string,
    details: Record<string, string | number | boolean> = {},
  ): void => {
    events.push(
      freeze({
        sequence: events.length,
        tick,
        type,
        subjectId,
        details: freeze(details),
      }) as ReplayEvent,
    );
  };

  for (const tickInput of ticks) {
    const arriving = [...(arrivalsByTick.get(tickInput.tick) ?? [])].sort((left, right) => {
      const leftOrder = stableSeedOrder(input.demandSeed, left.groupId);
      const rightOrder = stableSeedOrder(input.demandSeed, right.groupId);
      return leftOrder - rightOrder || left.groupId.localeCompare(right.groupId);
    });
    for (const arrival of arriving) {
      const patienceTicks = round(
        arrival.basePatienceTicks * COHORT_PATIENCE_FACTOR[arrival.cohort],
      );
      waiting.push({
        ...arrival,
        patienceTicks,
        seedOrder: stableSeedOrder(input.demandSeed, arrival.groupId),
      });
      emit(tickInput.tick, 'GROUP_ARRIVED', arrival.groupId, {
        cohort: arrival.cohort,
        patienceTicks,
      });
    }
    waiting.sort(
      (left, right) =>
        left.arrivalTick - right.arrivalTick ||
        left.seedOrder - right.seedOrder ||
        left.groupId.localeCompare(right.groupId),
    );

    for (let index = waiting.length - 1; index >= 0; index -= 1) {
      const group = waiting[index];
      if (tickInput.tick - group.arrivalTick > group.patienceTicks) {
        waiting.splice(index, 1);
        departedGroupIds.push(group.groupId);
        emit(tickInput.tick, 'WAITING_LEFT', group.groupId, {
          waitedTicks: tickInput.tick - group.arrivalTick,
          patienceTicks: group.patienceTicks,
        });
      }
    }

    const admitted = waiting.splice(0, tickInput.admissionCapacity);
    for (const group of admitted) {
      const preferredRecipeId = group.recipePreferenceOrder[0];
      let selectedRecipeId = preferredRecipeId;
      if ((remainingPortions[preferredRecipeId] ?? 0) < group.size) {
        emit(tickInput.tick, 'PREFERRED_SOLD_OUT', group.groupId, {
          recipeId: preferredRecipeId,
        });
        selectedRecipeId =
          group.recipePreferenceOrder
            .slice(1)
            .find((recipeId) => (remainingPortions[recipeId] ?? 0) >= group.size) ?? '';
        if (selectedRecipeId.length === 0) {
          departedGroupIds.push(group.groupId);
          emit(tickInput.tick, 'SOLD_OUT_LEFT', group.groupId, {
            attemptedAlternatives: group.recipePreferenceOrder.length - 1,
          });
          continue;
        }
        emit(tickInput.tick, 'RESELECTED_ONCE', group.groupId, {
          fromRecipeId: preferredRecipeId,
          toRecipeId: selectedRecipeId,
        });
      }

      remainingPortions[selectedRecipeId] -= group.size;
      const order: MutableOrder = {
        id: `order:${group.groupId}`,
        groupId: group.groupId,
        recipeId: selectedRecipeId,
        state: 'CREATED',
        createdSequence: orders.length,
        arrivalTick: group.arrivalTick,
        createdTick: tickInput.tick,
        kitchenWork: 0,
        frontWork: 0,
        patienceTicks: group.patienceTicks,
        lowMoraleKitchenContributionApplied: false,
      };
      orders.push(order);
      emit(tickInput.tick, 'ORDER_STATE_CHANGED', order.id, {
        from: 'NONE',
        to: 'CREATED',
      });
    }

    const readyAtTickStart = new Set(
      orders.filter((order) => order.state === 'READY').map((order) => order.id),
    );
    for (const order of orders) {
      if (order.state === 'CREATED') {
        order.state = 'PREPARING';
        emit(tickInput.tick, 'ORDER_STATE_CHANGED', order.id, {
          from: 'CREATED',
          to: 'PREPARING',
        });
      }
    }

    const authorizedPlayerIds = tickInput.authorizedPlayerWorkerIds ?? [];
    const authorizedPlayerIdSet = new Set(authorizedPlayerIds);
    const kitchenWorkers = input.workers
      .filter(
        (worker) =>
          rolePool[worker.role] === 'KITCHEN' && isWorkerActive(worker, authorizedPlayerIdSet),
      )
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    for (const worker of kitchenWorkers) {
      const workerCapacity = calculateWorkerCapacity(
        worker,
        'KITCHEN',
        input.equipment,
        authorizedPlayerIdSet,
      );
      allocateWork(
        orders,
        'PREPARING',
        'kitchenWork',
        K_WORK,
        workerCapacity,
        (order) => {
          order.state = 'READY';
          emit(tickInput.tick, 'ORDER_STATE_CHANGED', order.id, {
            from: 'PREPARING',
            to: 'READY',
          });
        },
        (order, units) => {
          // Stable worker-id order attributes capacity without adding NPC pathfinding or
          // player-speed mechanics. An order receives the low-morale penalty at most once.
          if (worker.kind === 'NPC' && worker.morale === 'LOW') {
            order.lowMoraleKitchenContributionApplied = true;
          }
          emit(tickInput.tick, 'WORK_CONTRIBUTION', order.id, {
            pool: 'KITCHEN',
            contributorKey: worker.id,
            orderId: order.id,
            units,
          });
        },
      );
    }

    const serveOrder = (order: MutableOrder): void => {
      order.state = 'SERVED';
      order.servedTick = tickInput.tick;
      const recipe = recipes.get(order.recipeId);
      if (recipe === undefined) {
        throw new Error('order references an unknown recipe');
      }
      order.foodQuality = calculateFoodQuality({
        recipeBaseQuality: recipe.baseQuality,
        substitutionQualityDelta: recipe.substitutionQualityDelta,
        kitchenExecutionQualityModifier: input.kitchenExecutionQualityModifier,
        equipmentCondition: input.equipment.kitchen,
        lowMoraleKitchenContribution: order.lowMoraleKitchenContributionApplied,
      });
      order.serviceSpeed = calculateServiceSpeed(
        tickInput.tick - order.arrivalTick + 1,
        order.patienceTicks,
      );
      const queueCongestion = calculateQueueCongestion({
        queueLength: waiting.length,
        demand: tickInput.demand,
        queueVisibility: tickInput.queueVisibility,
        periodWeight: tickInput.periodWeight,
      });
      emit(tickInput.tick, 'ORDER_STATE_CHANGED', order.id, {
        from: 'READY',
        to: 'SERVED',
      });
      emit(tickInput.tick, 'ORDER_SCORED', order.id, {
        foodQuality: order.foodQuality,
        serviceSpeed: order.serviceSpeed,
        waitTicks: tickInput.tick - order.arrivalTick + 1,
        lowMoraleKitchenContributionApplied: order.lowMoraleKitchenContributionApplied,
      });
      reputation = updateOrderReputation(reputation, {
        salePrice: recipe.salePrice,
        recommendedPrice: recipe.recommendedPrice,
        serviceSpeed: order.serviceSpeed,
        foodQuality: order.foodQuality,
        queueCongestion,
      });
      emit(tickInput.tick, 'REPUTATION_UPDATED', order.id, {
        price: reputation.price,
        speed: reputation.speed,
        quality: reputation.quality,
        fairness: reputation.fairness,
        vibe: reputation.vibe,
      });
    };
    const frontWorkers = input.workers
      .filter(
        (worker) =>
          rolePool[worker.role] === 'FRONT' && isWorkerActive(worker, authorizedPlayerIdSet),
      )
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    for (const worker of frontWorkers) {
      const workerCapacity = calculateWorkerCapacity(
        worker,
        'FRONT',
        input.equipment,
        authorizedPlayerIdSet,
      );
      allocateWork(
        orders.filter((order) => readyAtTickStart.has(order.id)),
        'READY',
        'frontWork',
        F_WORK,
        workerCapacity,
        serveOrder,
        (order, units) => {
          emit(tickInput.tick, 'WORK_CONTRIBUTION', order.id, {
            pool: 'FRONT',
            contributorKey: worker.id,
            orderId: order.id,
            units,
          });
        },
      );
    }

    const queueDemandRatio = round(waiting.length / tickInput.demand);
    highFlowStreak = queueDemandRatio > 1.2 ? highFlowStreak + 1 : 0;
    if (highFlowStreak >= 2 && !flowRiskHigh) {
      flowRiskHigh = true;
      emit(tickInput.tick, 'FLOW_RISK_HIGH', 'service-day', {
        queueLength: waiting.length,
        demand: tickInput.demand,
        queueDemandRatio,
        consecutiveTicks: highFlowStreak,
      });
    }
  }

  if (input.fairness !== undefined) {
    reputation = updateFairnessReputation(reputation, input.fairness);
    emit(ticks.at(-1)?.tick ?? 0, 'FAIRNESS_UPDATED', 'service-day', {
      fulfilledAuthorizedHours: input.fairness.fulfilledAuthorizedHours,
      scheduledAuthorizedHours: input.fairness.scheduledAuthorizedHours,
      fairness: reputation.fairness,
    });
  }

  return freeze({
    demandSeed: input.demandSeed,
    orders: orders.map((order) => freeze(order)),
    waitingGroupIds: waiting.map((group) => group.groupId),
    departedGroupIds,
    remainingPortions,
    reputation,
    flowRiskHigh,
    events,
  });
}
