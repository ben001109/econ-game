import { createHash } from 'node:crypto';

import type { MenuSelection } from './catalog-menu.js';
import type { InventoryState } from './inventory.js';
import type { MarketSnapshot, SupplierContract } from './procurement.js';
import { deepFreeze } from './shared.js';

export type InventoryProcurementOpeningSnapshotPayload = Readonly<{
  snapshotSchemaVersion: string;
  simulationRuleVersion: string;
  catalogRevisions: Readonly<{
    ingredientCatalog: string;
    recipeCatalog: string;
    substitutionCatalog: string;
  }>;
  servicePeriodPlan: 'TWO_PERIOD' | 'THREE_PERIOD';
  operatingMode: 'STRATEGY' | 'LIGHTWEIGHT_REALTIME';
  menu: MenuSelection;
  market: MarketSnapshot;
  capacity: InventoryState['capacity'];
  openingStocks: InventoryState['stocks'];
  openingReservations: InventoryState['orderReservations'];
  outstandingContracts: readonly SupplierContract[];
  reservedUndelivered: InventoryState['reservedUndelivered'];
}>;

export type InventoryProcurementOpeningSnapshot = Readonly<
  InventoryProcurementOpeningSnapshotPayload & { snapshotHash: string }
>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

export function createInventoryProcurementOpeningSnapshot(
  payload: InventoryProcurementOpeningSnapshotPayload,
): InventoryProcurementOpeningSnapshot {
  if (
    !payload.snapshotSchemaVersion ||
    !payload.simulationRuleVersion ||
    !payload.catalogRevisions.ingredientCatalog ||
    !payload.catalogRevisions.recipeCatalog ||
    !payload.catalogRevisions.substitutionCatalog
  ) {
    throw new Error('opening snapshot requires immutable schema, rule, and catalog revisions');
  }
  if (payload.menu.businessDay !== payload.market.businessDay) {
    throw new Error('menu and market snapshot must represent the same business day');
  }
  if (payload.market.simulationRuleVersion !== payload.simulationRuleVersion) {
    throw new Error('market and opening snapshot must use the same simulation rule version');
  }
  if (payload.market.catalogRevision !== payload.catalogRevisions.ingredientCatalog) {
    throw new Error('market and opening snapshot must use the same ingredient catalog revision');
  }
  if (payload.openingReservations.length !== 0) {
    throw new Error('OpenDay snapshot cannot retain order ingredient reservations');
  }
  if (payload.openingStocks.some((stock) => stock.reservedPoints !== 0)) {
    throw new Error('OpenDay opening stock cannot retain reserved order ingredients');
  }
  for (const pool of ['DURABLE', 'PERISHABLE'] as const) {
    const onHand = payload.openingStocks
      .filter((stock) => stock.pool === pool)
      .reduce((sum, stock) => sum + stock.onHandPoints, 0);
    const reservedUndelivered = payload.reservedUndelivered
      .filter((reservation) => reservation.pool === pool)
      .reduce((sum, reservation) => sum + reservation.quantityPoints, 0);
    if (onHand + reservedUndelivered > payload.capacity[pool]) {
      throw new Error('OpenDay snapshot inventory occupancy exceeds storage capacity');
    }
  }
  for (const contract of payload.outstandingContracts) {
    if (contract.status !== 'ACTIVE') {
      throw new Error('OpenDay outstanding contracts must be active');
    }
    const pendingQuantity = contract.obligations
      .filter((obligation) => obligation.status === 'PENDING')
      .reduce((sum, obligation) => sum + obligation.quantityPoints, 0);
    const reserved = payload.reservedUndelivered.find(
      (reservation) => reservation.contractId === contract.id,
    );
    if (
      !reserved ||
      reserved.ingredientId !== contract.ingredientId ||
      reserved.quantityPoints !== pendingQuantity
    ) {
      throw new Error('OpenDay contract obligations must reconcile to reservedUndelivered');
    }
  }
  if (
    payload.reservedUndelivered.some(
      (reservation) =>
        !payload.outstandingContracts.some((contract) => contract.id === reservation.contractId),
    )
  ) {
    throw new Error('OpenDay reservedUndelivered must belong to an outstanding contract');
  }
  const canonicalPayload = JSON.stringify(canonicalize(payload));
  return deepFreeze({
    ...payload,
    snapshotHash: createHash('sha256').update(canonicalPayload).digest('hex'),
  });
}
