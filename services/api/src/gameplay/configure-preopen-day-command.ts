import { createHash } from 'node:crypto';

import { CommandError, type CanonicalCommandValue } from '../commands/command-contract.js';
import type { CommandHandler, LedgerTransactionalEffect } from '../commands/command-dispatcher.js';
import { provideCanonicalFirstDayPreopenArtifacts } from './preopen-day-authority-provider.js';
import { parseConfigurePreopenDayIntent } from './preopen-day-contract.js';
import {
  createPreopenDayPlan,
  serializeCanonicalPreopenDayPayload,
  type PreopenDayPrivateEnvelope,
} from './preopen-day-plan.js';
import { PrismaConfigurePreopenDayRepository } from './prisma-configure-preopen-day-repository.js';

export const CONFIGURE_PREOPEN_DAY = 'CONFIGURE_PREOPEN_DAY' as const;
export const PREOPEN_DAY_CONFIGURED_EVENT_TYPE = 'gameplay.preopen-day.configured' as const;
export const PREOPEN_DAY_CONFIGURED_EVENT_VERSION = 1 as const;

export function createConfigurePreopenDayCommandHandler(): CommandHandler {
  return Object.freeze({
    commandType: CONFIGURE_PREOPEN_DAY,
    async execute({ context, command, currentVersion, persistence }) {
      if (command.commandType !== CONFIGURE_PREOPEN_DAY || command.aggregateId !== context.saveId) {
        throw new CommandError(422, 'PREOPEN_COMMAND_SCOPE_INVALID');
      }
      let intent;
      try {
        intent = parseConfigurePreopenDayIntent(command.payload);
      } catch {
        throw new CommandError(422, 'PREOPEN_CONFIGURATION_INVALID');
      }

      const repository = new PrismaConfigurePreopenDayRepository(persistence);
      const authority = await repository.loadFirstDayAuthority({
        restaurantId: context.tenantId,
        saveId: context.saveId,
        membershipId: context.membershipId,
        actorId: context.actorId,
      });
      const preopenSnapshotId = `preopen:${command.commandId}`;
      const businessDayId = `business-day:${command.commandId}`;

      let artifacts;
      try {
        artifacts = provideCanonicalFirstDayPreopenArtifacts({
          command: {
            commandId: command.commandId,
            preopenSnapshotId,
            businessDay: 1,
            currentLayoutRevision: 0,
          },
          save: authority.save,
          marketSeedAuthority: authority.marketSeedAuthority,
          inventoryPoolAuthorities: authority.inventoryPoolAuthorities,
          spotPurchaseIdFactory: {
            create: ({ commandId, preopenSnapshotId: snapshotId, saveId, ingredientId }) => ({
              transactionId: privateIdentity(
                'spot-transaction',
                commandId,
                snapshotId,
                saveId,
                ingredientId,
              ),
              purchaseId: privateIdentity(
                'spot-purchase',
                commandId,
                snapshotId,
                saveId,
                ingredientId,
              ),
            }),
          },
        });
      } catch (error) {
        if (error instanceof CommandError) throw error;
        throw new CommandError(503, 'PREOPEN_AUTHORITY_INVALID');
      }

      let plan;
      try {
        plan = createPreopenDayPlan(intent, artifacts);
      } catch {
        throw new CommandError(422, 'PREOPEN_CONFIGURATION_INVALID');
      }
      const independentlyComputedHash = createHash('sha256')
        .update(serializeCanonicalPreopenDayPayload(plan.privateEnvelope))
        .digest('hex');
      if (independentlyComputedHash !== plan.privateEnvelope.preopenSnapshotHash) {
        throw new CommandError(503, 'PREOPEN_SNAPSHOT_HASH_INVALID');
      }
      let procurementLedger: LedgerTransactionalEffect | undefined;
      try {
        procurementLedger = createPreopenProcurementLedgerEffect(
          plan.privateEnvelope,
          command.commandId,
        );
      } catch {
        throw new CommandError(503, 'PREOPEN_SNAPSHOT_ACCOUNTING_INVALID');
      }

      await repository.createFirstDayPreopen({
        businessDayId,
        restaurantId: context.tenantId,
        saveId: context.saveId,
        commandId: command.commandId,
        servicePeriodPlan: authority.save.servicePeriodPlan,
        simulationRuleVersion: authority.save.simulationRuleVersion,
        privateEnvelope: plan.privateEnvelope,
      });

      const aggregateVersion = currentVersion + 1;
      return Object.freeze({
        aggregateVersion,
        result: canonicalValue({
          competitiveSave: { id: context.saveId, version: aggregateVersion },
          preopenDaySnapshot: plan.publicProjection,
        }),
        effects: Object.freeze({
          ...(procurementLedger === undefined ? {} : { ledger: procurementLedger }),
          outbox: Object.freeze([
            Object.freeze({
              kind: 'outbox.event/v1' as const,
              eventId: command.commandId,
              eventSequence: 0,
              eventType: PREOPEN_DAY_CONFIGURED_EVENT_TYPE,
              eventVersion: PREOPEN_DAY_CONFIGURED_EVENT_VERSION,
              payload: Object.freeze({
                schemaVersion: 'gameplay.preopen-day.configured/v1',
                businessDay: 1,
                preopenSnapshotId,
                preopenSnapshotHash: plan.privateEnvelope.preopenSnapshotHash,
                snapshotSchemaVersion: plan.privateEnvelope.envelopeVersion,
                simulationRuleVersion: authority.save.simulationRuleVersion,
              }),
            }),
          ]),
        }),
      });
    },
  });
}

const maximumPostgresBigInt = 9_223_372_036_854_775_807n;
const canonicalNonNegativeInteger = /^(?:0|[1-9]\d*)$/;

/**
 * Derives the one PREOPEN cash movement exclusively from the already-hashed
 * private snapshot. The D03 ledger does not permit zero-value postings, so a
 * canonical configuration with no spot-purchased opening stock deliberately
 * returns no ledger effect instead of manufacturing empty ledger history.
 */
export function createPreopenProcurementLedgerEffect(
  privateEnvelope: PreopenDayPrivateEnvelope,
  commandId: string,
): LedgerTransactionalEffect | undefined {
  const openingCashEntries = privateEnvelope.accountingEvidence.entries.filter(
    (entry) => entry.kind === 'OPENING_CASH',
  );
  const openingCash = openingCashEntries[0];
  if (
    privateEnvelope.accountingEvidence.accountingVersion !== privateEnvelope.versions.accounting ||
    privateEnvelope.accountingEvidence.entries.length !== 1 ||
    openingCashEntries.length !== 1 ||
    openingCash === undefined ||
    openingCash.referenceId !==
      `opening-cash:${privateEnvelope.openingSnapshot.openingSnapshotHash}` ||
    !/^[A-Z]{3}$/.test(openingCash.currency) ||
    !canonicalNonNegativeInteger.test(openingCash.amountMinorUnits)
  ) {
    throw new Error('private pre-open opening cash evidence is not canonical');
  }

  const openingCashMinor = BigInt(openingCash.amountMinorUnits);
  const ingredientIds = new Set<string>();
  let procurementMinor = 0n;
  for (const stock of privateEnvelope.inventoryProcurement.openingStocks) {
    if (
      !stock.ingredientId ||
      ingredientIds.has(stock.ingredientId) ||
      !Number.isSafeInteger(stock.onHandPoints) ||
      stock.onHandPoints <= 0 ||
      stock.reservedPoints !== 0 ||
      stock.costPool.currency !== openingCash.currency ||
      !canonicalNonNegativeInteger.test(stock.costPool.minorUnits)
    ) {
      throw new Error('private pre-open opening stock is not canonical');
    }
    ingredientIds.add(stock.ingredientId);
    const quote = privateEnvelope.inventoryProcurement.market.quotes.find(
      (candidate) => candidate.ingredientId === stock.ingredientId,
    );
    if (
      quote === undefined ||
      quote.unitPrice.currency !== openingCash.currency ||
      !canonicalNonNegativeInteger.test(quote.unitPrice.minorUnits)
    ) {
      throw new Error('private pre-open stock has no canonical market quote');
    }
    const stockCost = BigInt(stock.costPool.minorUnits);
    const expectedCost = BigInt(quote.unitPrice.minorUnits) * BigInt(stock.onHandPoints);
    if (stockCost <= 0n || stockCost !== expectedCost) {
      throw new Error('private pre-open stock cost does not match its locked spot quote');
    }
    procurementMinor += stockCost;
  }
  if (procurementMinor === 0n) return undefined;
  if (procurementMinor > openingCashMinor || procurementMinor > maximumPostgresBigInt) {
    throw new Error('private pre-open procurement cannot be funded or persisted');
  }

  return Object.freeze({
    kind: 'ledger.posting/v1' as const,
    transactionId: commandId,
    eventId: commandId,
    currency: openingCash.currency,
    reason: `MVP Day 1 pre-open procurement from ${privateEnvelope.preopenSnapshotHash}`,
    lines: Object.freeze([
      Object.freeze({
        accountCode: 'ASSET:INVENTORY',
        direction: 'DEBIT' as const,
        amountMinor: procurementMinor.toString(),
      }),
      Object.freeze({
        accountCode: 'CASH:SETTLEMENT',
        direction: 'CREDIT' as const,
        amountMinor: procurementMinor.toString(),
      }),
    ]),
  });
}

function privateIdentity(
  kind: 'spot-transaction' | 'spot-purchase',
  commandId: string,
  preopenSnapshotId: string,
  saveId: string,
  ingredientId: string,
): string {
  const digest = createHash('sha256')
    .update(
      `${kind}\u0000${commandId}\u0000${preopenSnapshotId}\u0000${saveId}\u0000${ingredientId}`,
    )
    .digest('hex');
  return `${kind}:${digest}`;
}

function canonicalValue(value: unknown): CanonicalCommandValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return Object.freeze(value.map(canonicalValue));
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.some(([, nested]) => nested === undefined)) {
      throw new CommandError(503, 'PREOPEN_PUBLIC_PROJECTION_INVALID');
    }
    return Object.freeze(
      Object.fromEntries(entries.map(([key, nested]) => [key, canonicalValue(nested)])),
    );
  }
  throw new CommandError(503, 'PREOPEN_PUBLIC_PROJECTION_INVALID');
}
