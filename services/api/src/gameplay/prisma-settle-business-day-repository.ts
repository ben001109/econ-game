import { createHash } from 'node:crypto';

import { CommandError } from '../commands/command-contract.js';
import type { DurableCommandPersistence } from '../commands/command-dispatcher.js';
import type { DayEndResult, RiskTransitionEvent } from '../domains/day-end/day-end.js';
import type { DayEndWasteResult } from '../domains/inventory-procurement/inventory.js';
import type {
  AdvanceServicePeriodInputSnapshot,
  AdvanceServicePeriodResultSnapshot,
} from './advance-service-period.js';
import type { ComposedDayEvidence } from './day-evidence-composer.js';
import type {
  FirstDayOpenAuthority,
  OpenInventoryPoolAuthority,
} from './prisma-open-business-day-repository.js';
import type {
  PersistedAdvanceExecution,
  PersistedInventoryAudit,
  PersistedInventoryStock,
} from './prisma-advance-service-period-repository.js';

type Row = Readonly<Record<string, unknown>>;

export type FirstDaySettlementAuthority = Readonly<{
  restaurantId: string;
  openAuthority: FirstDayOpenAuthority;
  executions: readonly PersistedAdvanceExecution[];
  inventoryStocks: readonly PersistedInventoryStock[];
  inventoryAudits: readonly PersistedInventoryAudit[];
}>;

export type SettlementScope = Readonly<{
  restaurantId: string;
  saveId: string;
  membershipId: string;
  actorId: string;
}>;

export type PersistFirstDaySettlementInput = Readonly<{
  restaurantId: string;
  saveId: string;
  businessDayId: string;
  commandId: string;
  simulationRuleVersion: string;
  authority: FirstDaySettlementAuthority;
  waste: DayEndWasteResult;
  dayEndResult: DayEndResult;
  evidence: ComposedDayEvidence;
  dayEndSnapshotId: string;
}>;

/** Transaction-bound SETTLE adapter. D03 owns idempotency, save lock, ledger and outbox. */
export class PrismaSettleBusinessDayRepository {
  constructor(private readonly persistence: DurableCommandPersistence) {}

  async loadFirstDaySettlementAuthority(
    scope: SettlementScope,
  ): Promise<FirstDaySettlementAuthority> {
    const rows = await this.persistence.mutate<readonly Row[]>(
      `/* settle-business-day:scope */
       SELECT save."id" AS "saveId", save."openingScenario", save."operatingMode",
              save."servicePeriodPlan" AS "saveServicePeriodPlan", save."demandSeed",
              save."simulationRuleVersion" AS "saveSimulationRuleVersion",
              save."openingSnapshot", save."openingSnapshotHash",
              membership."role"::text AS "membershipRole",
              day."id" AS "businessDayId", day."status"::text AS "businessDayStatus",
              day."servicePeriodPlan" AS "businessDayServicePeriodPlan",
              day."simulationRuleVersion" AS "businessDaySimulationRuleVersion",
              day."openedByCommandId", day."settledByCommandId", day."settledAt",
              day."consumedPreopenSnapshotId", day."openSnapshotHash",
              (day."openSnapshot" = snapshot."payload") AS "openSnapshotMatches",
              snapshot."id" AS "preopenSnapshotId", snapshot."revision" AS "preopenRevision",
              snapshot."commandId" AS "preopenCommandId",
              snapshot."snapshotSchemaVersion" AS "preopenSnapshotSchemaVersion",
              snapshot."simulationRuleVersion" AS "preopenSimulationRuleVersion",
              snapshot."payload" AS "preopenPayload", snapshot."snapshotHash" AS "preopenSnapshotHash"
       FROM "CompetitiveSave" save
       JOIN "RestaurantMembership" membership
         ON membership."id" = $3 AND membership."playerId" = $4
        AND membership."restaurantId" = save."restaurantId"
        AND membership."revokedAt" IS NULL AND membership."role" IN ('OWNER','MANAGER')
       JOIN "BusinessDay" day
         ON day."restaurantId" = save."restaurantId" AND day."saveId" = save."id"
        AND day."businessDay" = 1
       JOIN "PreopenDaySnapshot" snapshot
         ON snapshot."restaurantId" = day."restaurantId" AND snapshot."saveId" = day."saveId"
        AND snapshot."businessDay" = day."businessDay" AND snapshot."revision" = 1
       WHERE save."id" = $1 AND save."restaurantId" = $2 AND save."retiredAt" IS NULL
       FOR UPDATE OF day
       FOR SHARE OF save, membership, snapshot`,
      scope.saveId,
      scope.restaurantId,
      scope.membershipId,
      scope.actorId,
    );
    if (rows.length !== 1) throw new CommandError(403, 'SETTLEMENT_SCOPE_FORBIDDEN');
    const row = rows[0]!;
    if (row.businessDayStatus !== 'SERVICE_COMPLETE') {
      throw new CommandError(409, 'BUSINESS_DAY_NOT_SERVICE_COMPLETE');
    }
    if (row.settledByCommandId !== null || row.settledAt !== null) {
      throw new CommandError(409, 'BUSINESS_DAY_ALREADY_SETTLED');
    }

    const poolRows = await this.persistence.mutate<readonly Row[]>(
      `/* settle-business-day:inventory-pools */
       SELECT pool."saveId", pool."pool"::text AS "pool", pool."revision",
              pool."capacityPoints", pool."storageBundleVersion", pool."storageBundleKind"
       FROM "InventoryPoolState" pool
       WHERE pool."restaurantId" = $1 AND pool."saveId" = $2
       ORDER BY pool."pool" FOR SHARE OF pool`,
      scope.restaurantId,
      scope.saveId,
    );
    const executionRows = await this.persistence.mutate<readonly Row[]>(
      `/* settle-business-day:executions */
       SELECT execution."id", execution."ordinal", execution."periodKey", execution."commandId",
              execution."simulationRuleVersion", execution."inputSnapshot", execution."inputHash",
              execution."resultSnapshot", execution."resultHash"
       FROM "ServicePeriodExecution" execution
       WHERE execution."restaurantId" = $1 AND execution."saveId" = $2
         AND execution."businessDay" = 1
       ORDER BY execution."ordinal" FOR SHARE OF execution`,
      scope.restaurantId,
      scope.saveId,
    );
    const stockRows = await this.persistence.mutate<readonly Row[]>(
      `/* settle-business-day:inventory-stocks */
       SELECT stock."id", stock."inventoryItemId", item."stableKey" AS "ingredientId",
              CASE WHEN item."perishable" THEN 'PERISHABLE' ELSE 'DURABLE' END AS "pool",
              stock."version", stock."onHand", stock."reservedUndelivered", stock."costPoolMinor"
       FROM "InventoryStock" stock
       JOIN "InventoryItem" item
         ON item."restaurantId" = stock."restaurantId" AND item."id" = stock."inventoryItemId"
       WHERE stock."restaurantId" = $1 AND stock."saveId" = $2
       ORDER BY item."stableKey" FOR UPDATE OF stock FOR SHARE OF item`,
      scope.restaurantId,
      scope.saveId,
    );
    const auditRows = await this.persistence.mutate<readonly Row[]>(
      `/* settle-business-day:inventory-audits */
       SELECT transaction."commandId", transaction."commandSequence",
              item."stableKey" AS "ingredientId", transaction."metadata"
       FROM "InventoryTransaction" transaction
       JOIN "InventoryStock" stock
         ON stock."restaurantId" = transaction."restaurantId"
        AND stock."saveId" = transaction."saveId" AND stock."id" = transaction."stockId"
       JOIN "InventoryItem" item
         ON item."restaurantId" = stock."restaurantId" AND item."id" = stock."inventoryItemId"
       WHERE transaction."restaurantId" = $1 AND transaction."saveId" = $2
       ORDER BY transaction."occurredAt", transaction."commandId", transaction."commandSequence"
       FOR SHARE OF transaction`,
      scope.restaurantId,
      scope.saveId,
    );
    const riskRows = await this.persistence.mutate<readonly Row[]>(
      `/* settle-business-day:latest-risk */
       SELECT "version","businessDay","status"::text AS "status","reason","precondition","postcondition"
       FROM "RiskState" WHERE "restaurantId" = $1 AND "saveId" = $2
       ORDER BY "version" DESC LIMIT 1 FOR UPDATE`,
      scope.restaurantId,
      scope.saveId,
    );
    const reputationRows = await this.persistence.mutate<readonly Row[]>(
      `/* settle-business-day:reputation-history */
       SELECT "businessDay","dimension"::text AS "dimension","version","score","reason"
       FROM "ReputationDimensionHistory"
       WHERE "restaurantId" = $1 AND "saveId" = $2
       ORDER BY "businessDay","dimension","version" FOR SHARE`,
      scope.restaurantId,
      scope.saveId,
    );
    const evidenceRows = await this.persistence.mutate<readonly Row[]>(
      `/* settle-business-day:existing-evidence */
       SELECT
         (SELECT count(*) FROM "ReplayEvent" event
          WHERE event."restaurantId" = $1 AND event."saveId" = $2 AND event."businessDay" = 1) AS "replayCount",
         (SELECT count(*) FROM "DayEndSnapshot" snapshot
          WHERE snapshot."restaurantId" = $1 AND snapshot."saveId" = $2 AND snapshot."businessDay" = 1) AS "dayEndCount"`,
      scope.restaurantId,
      scope.saveId,
    );

    try {
      if (
        row.openSnapshotMatches !== true ||
        row.consumedPreopenSnapshotId !== row.preopenSnapshotId ||
        row.openSnapshotHash !== row.preopenSnapshotHash ||
        row.openedByCommandId === null
      ) {
        throw new Error('OPEN evidence no longer matches its immutable pre-open snapshot');
      }
      if (riskRows.length !== 0 || reputationRows.length !== 0) {
        throw new CommandError(409, 'SETTLEMENT_HISTORY_CONFLICT');
      }
      const evidenceCounts = evidenceRows[0];
      if (
        evidenceRows.length !== 1 ||
        databaseInteger(evidenceCounts?.replayCount, 'existing replay count') !== 0 ||
        databaseInteger(evidenceCounts?.dayEndCount, 'existing day-end count') !== 0
      ) {
        throw new CommandError(409, 'SETTLEMENT_EVIDENCE_CONFLICT');
      }
      const saveId = stringValue(row.saveId, 'save id');
      const rule = stringValue(row.saveSimulationRuleVersion, 'save rule');
      const plan = periodPlan(row.saveServicePeriodPlan);
      if (
        row.businessDayServicePeriodPlan !== plan ||
        row.businessDaySimulationRuleVersion !== rule ||
        row.preopenSimulationRuleVersion !== rule
      ) {
        throw new Error('save, BusinessDay, and pre-open rule authority differ');
      }
      if (poolRows.length !== 2) throw new Error('SETTLE requires exactly two inventory pools');
      const pools = Object.freeze(poolRows.map(parsePool));
      if (
        new Set(pools.map((pool) => pool.pool)).size !== 2 ||
        pools.some((pool) => pool.saveId !== saveId)
      ) {
        throw new Error('inventory pools are duplicated or cross-save');
      }
      const executions = Object.freeze(executionRows.map(parseExecution));
      const expectedCount = plan === 'TWO_PERIODS' ? 2 : 3;
      if (executions.length !== expectedCount) {
        throw new Error('SETTLE requires the complete service period plan');
      }
      return Object.freeze({
        restaurantId: scope.restaurantId,
        openAuthority: Object.freeze({
          save: Object.freeze({
            id: saveId,
            scenario: scenario(row.openingScenario),
            operatingMode: operatingMode(row.operatingMode),
            servicePeriodPlan: plan,
            demandSeed: stringValue(row.demandSeed, 'demand seed'),
            simulationRuleVersion: rule,
            openingSnapshot: jsonObject(
              row.openingSnapshot,
              'opening snapshot',
            ) as FirstDayOpenAuthority['save']['openingSnapshot'],
            openingSnapshotHash: hash(row.openingSnapshotHash, 'opening snapshot hash'),
          }),
          businessDay: Object.freeze({
            id: stringValue(row.businessDayId, 'business day id'),
            status: 'SERVICE_COMPLETE',
            servicePeriodPlan: plan,
            simulationRuleVersion: rule,
          }),
          preopenSnapshot: Object.freeze({
            id: stringValue(row.preopenSnapshotId, 'pre-open snapshot id'),
            revision: one(row.preopenRevision),
            commandId: stringValue(row.preopenCommandId, 'pre-open command id'),
            snapshotSchemaVersion: stringValue(row.preopenSnapshotSchemaVersion, 'pre-open schema'),
            simulationRuleVersion: rule,
            payload: jsonObject(row.preopenPayload, 'pre-open payload'),
            snapshotHash: hash(row.preopenSnapshotHash, 'pre-open snapshot hash'),
          }),
          inventoryPoolAuthorities: pools,
        }),
        executions,
        inventoryStocks: Object.freeze(stockRows.map(parseStock)),
        inventoryAudits: Object.freeze(auditRows.map(parseAudit)),
      });
    } catch (error) {
      if (error instanceof CommandError) throw error;
      throw new CommandError(503, 'SETTLEMENT_AUTHORITY_INVALID');
    }
  }

  async persistFirstDaySettlement(input: PersistFirstDaySettlementInput): Promise<void> {
    await this.applyPerishableWaste(input);
    await this.insertReplayEvents(input);
    await this.insertDayEndSnapshot(input);
    await this.insertRiskState(input);
    await this.insertReputationHistory(input);
    const transitioned = await this.persistence.mutate<readonly Row[]>(
      `/* settle-business-day:transition-day */
       UPDATE "BusinessDay"
       SET "status" = 'SETTLED', "settledByCommandId" = $4, "settledAt" = CURRENT_TIMESTAMP
       WHERE "restaurantId" = $1 AND "saveId" = $2 AND "id" = $3
         AND "businessDay" = 1 AND "status" = 'SERVICE_COMPLETE'
         AND "simulationRuleVersion" = $5 AND "settledByCommandId" IS NULL AND "settledAt" IS NULL
       RETURNING "id","status"::text AS "status","settledByCommandId"`,
      input.restaurantId,
      input.saveId,
      input.businessDayId,
      input.commandId,
      input.simulationRuleVersion,
    );
    if (
      transitioned.length !== 1 ||
      transitioned[0]?.id !== input.businessDayId ||
      transitioned[0]?.status !== 'SETTLED' ||
      transitioned[0]?.settledByCommandId !== input.commandId
    ) {
      throw new CommandError(409, 'BUSINESS_DAY_NOT_SERVICE_COMPLETE');
    }
  }

  private async applyPerishableWaste(input: PersistFirstDaySettlementInput): Promise<void> {
    const before = input.authority.executions.at(-1)!.resultSnapshot.inventoryState;
    const domainTransactions = input.waste.inventory.transactions.slice(before.transactions.length);
    if (domainTransactions.length !== input.waste.wasted.length) {
      throw new CommandError(503, 'SETTLEMENT_WASTE_AUTHORITY_INVALID');
    }
    for (const [commandSequence, transaction] of domainTransactions.entries()) {
      if (transaction.type !== 'PERISHABLE_WASTE') {
        throw new CommandError(503, 'SETTLEMENT_WASTE_AUTHORITY_INVALID');
      }
      const prior = input.authority.inventoryStocks.find(
        (stock) => stock.ingredientId === transaction.ingredientId,
      );
      const final = input.waste.inventory.stocks.find(
        (stock) => stock.ingredientId === transaction.ingredientId,
      );
      if (
        !prior ||
        !final ||
        prior.pool !== 'PERISHABLE' ||
        final.onHandPoints !== 0 ||
        final.costPool.minorUnits !== '0' ||
        prior.onHandPoints !== transaction.quantityPoints ||
        prior.costPoolMinor !== transaction.amount.minorUnits
      ) {
        throw new CommandError(503, 'SETTLEMENT_WASTE_AUTHORITY_INVALID');
      }
      const updated = await this.persistence.mutate<readonly Row[]>(
        `/* settle-business-day:waste-stock */
         UPDATE "InventoryStock"
         SET "version" = "version" + 1, "onHand" = 0, "costPoolMinor" = 0
         WHERE "restaurantId" = $1 AND "saveId" = $2 AND "id" = $3
           AND "version" = $4 AND "onHand" = $5 AND "reservedUndelivered" = $6
           AND "costPoolMinor" = $7
         RETURNING "version","onHand","reservedUndelivered","costPoolMinor"`,
        input.restaurantId,
        input.saveId,
        prior.id,
        prior.version,
        prior.onHandPoints,
        prior.reservedUndeliveredPoints,
        prior.costPoolMinor,
      );
      const row = updated[0];
      if (
        updated.length !== 1 ||
        databaseInteger(row?.version, 'waste stock version') !== prior.version + 1 ||
        databaseInteger(row?.onHand, 'waste stock on hand') !== 0 ||
        databaseInteger(row?.reservedUndelivered, 'waste stock reserved') !==
          prior.reservedUndeliveredPoints ||
        databaseBigintString(row?.costPoolMinor, 'waste stock cost') !== '0'
      ) {
        throw new CommandError(409, 'SETTLEMENT_INVENTORY_STALE');
      }
      const transactionId = privateId(
        'inventory-transaction',
        input.commandId,
        String(commandSequence),
        transaction.transactionId,
        transaction.ingredientId,
      );
      const auditId = privateId('inventory-audit', input.commandId, String(commandSequence));
      const inserted = await this.persistence.mutate<readonly Row[]>(
        `/* settle-business-day:insert-waste-audit */
         INSERT INTO "InventoryTransaction" (
           "id","restaurantId","saveId","stockId","transactionId","commandId","commandSequence",
           "ledgerTransactionId","stockVersion","kind","quantityDelta","onHandAfter","reservedAfter",
           "amountMinor","costPoolMinorAfter","referenceId","reason","metadata"
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,$8,'WASTE',$9,0,$10,$11,0,$12,'PERISHABLE_WASTE',$13::jsonb)
         ON CONFLICT DO NOTHING RETURNING "id","transactionId"`,
        auditId,
        input.restaurantId,
        input.saveId,
        prior.id,
        transactionId,
        input.commandId,
        commandSequence,
        prior.version + 1,
        -transaction.quantityPoints,
        prior.reservedUndeliveredPoints,
        transaction.amount.minorUnits,
        transaction.referenceId,
        JSON.stringify({
          schemaVersion: 'gameplay.day-end-inventory-audit/v1',
          domainSequence: transaction.sequence,
          domainTransactionId: transaction.transactionId,
          domainType: transaction.type,
          ingredientId: transaction.ingredientId,
          quantityPoints: transaction.quantityPoints,
        }),
      );
      if (
        inserted.length !== 1 ||
        inserted[0]?.id !== auditId ||
        inserted[0]?.transactionId !== transactionId
      ) {
        throw new CommandError(409, 'SETTLEMENT_INVENTORY_TRANSACTION_CONFLICT');
      }
    }
    for (const expected of input.waste.inventory.stocks) {
      const prior = input.authority.inventoryStocks.find(
        (stock) => stock.ingredientId === expected.ingredientId,
      );
      if (!prior) throw new CommandError(503, 'SETTLEMENT_FINAL_INVENTORY_MISMATCH');
      const rows = await this.persistence.mutate<readonly Row[]>(
        `/* settle-business-day:verify-final-stock */
         SELECT "version","onHand","reservedUndelivered","costPoolMinor"
         FROM "InventoryStock" WHERE "restaurantId" = $1 AND "saveId" = $2 AND "id" = $3
         FOR UPDATE`,
        input.restaurantId,
        input.saveId,
        prior.id,
      );
      const row = rows[0];
      const wasWasted = input.waste.wasted.some(
        (entry) => entry.ingredientId === expected.ingredientId,
      );
      if (
        rows.length !== 1 ||
        databaseInteger(row?.version, 'final stock version') !==
          prior.version + (wasWasted ? 1 : 0) ||
        databaseInteger(row?.onHand, 'final stock on hand') !== expected.onHandPoints ||
        databaseInteger(row?.reservedUndelivered, 'final stock reserved') !==
          prior.reservedUndeliveredPoints ||
        databaseBigintString(row?.costPoolMinor, 'final stock cost') !==
          expected.costPool.minorUnits
      ) {
        throw new CommandError(503, 'SETTLEMENT_FINAL_INVENTORY_MISMATCH');
      }
    }
  }

  private async insertReplayEvents(input: PersistFirstDaySettlementInput): Promise<void> {
    for (const event of input.evidence.replayEvents) {
      const rowId = privateId('replay-event-row', event.eventId);
      const inserted = await this.persistence.mutate<readonly Row[]>(
        `/* settle-business-day:insert-replay-event */
         INSERT INTO "ReplayEvent" (
           "id","restaurantId","saveId","eventId","businessDay","servicePeriodExecutionId",
           "sequence","eventType","simulationRuleVersion","payload","eventHash"
         ) VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8,$9::jsonb,$10)
         ON CONFLICT DO NOTHING RETURNING "id","eventId","sequence","eventHash"`,
        rowId,
        input.restaurantId,
        input.saveId,
        event.eventId,
        event.servicePeriodExecutionId ?? null,
        event.sequence,
        event.eventType,
        event.simulationRuleVersion,
        JSON.stringify(event.payload),
        event.eventHash,
      );
      if (
        inserted.length !== 1 ||
        inserted[0]?.id !== rowId ||
        inserted[0]?.eventId !== event.eventId ||
        databaseInteger(inserted[0]?.sequence, 'replay sequence') !== event.sequence ||
        inserted[0]?.eventHash !== event.eventHash
      ) {
        throw new CommandError(409, 'SETTLEMENT_REPLAY_CONFLICT');
      }
    }
  }

  private async insertDayEndSnapshot(input: PersistFirstDaySettlementInput): Promise<void> {
    const snapshot = input.dayEndResult.snapshot;
    const risk = snapshot.riskPenaltyCalculation;
    const inserted = await this.persistence.mutate<readonly Row[]>(
      `/* settle-business-day:insert-day-end */
       INSERT INTO "DayEndSnapshot" (
         "id","restaurantId","saveId","businessDay","currency",
         "grossRevenueMinor","cogsMinor","wasteLossMinor","payrollMinor","opexMinor","taxMinor",
         "debtDueMinor","riskPenaltyMinor","dailyNetMinor","resolutionComparisonShortfallMinor",
         "shortfallMinor","cashAfterMinor","riskPenaltyRuleVersion","riskPenaltyBaseMinor",
         "riskPenaltyRateBps","riskPenaltyRateDenominator","riskPenaltyRoundingMode",
         "riskPenaltyMinimumPositiveMinor","riskPenaltyAccruedTotalMinor",
         "reputationPrice","reputationSpeed","reputationQuality","reputationFairness","reputationVibe",
         "riskStatus","riskTags","highRiskRevenueEnabled","leaderboardEligible",
         "eventHash","snapshotHash","finalResourceVersions","fixedFieldSnapshot"
       ) VALUES (
         $1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,
         $24,$25,$26,$27,$28,$29,$30::jsonb,$31,$32,$33,$34,$35::jsonb,$36::jsonb
       ) ON CONFLICT DO NOTHING RETURNING "id","eventHash","snapshotHash"`,
      input.dayEndSnapshotId,
      input.restaurantId,
      input.saveId,
      snapshot.grossRevenue.currency,
      snapshot.grossRevenue.minorUnits,
      snapshot.cogs.minorUnits,
      snapshot.wasteLoss.minorUnits,
      snapshot.payroll.minorUnits,
      snapshot.opex.minorUnits,
      snapshot.tax.minorUnits,
      snapshot.debtDue.minorUnits,
      snapshot.riskPenalty.minorUnits,
      snapshot.dailyNet.minorUnits,
      snapshot.resolutionComparisonShortfall.minorUnits,
      snapshot.shortfall.minorUnits,
      snapshot.cashAfter.minorUnits,
      risk.version,
      risk.base.minorUnits,
      risk.rate,
      risk.denominator,
      risk.rounding,
      risk.minimum.minorUnits,
      risk.accruedTotal.minorUnits,
      snapshot.reputation.price,
      snapshot.reputation.speed,
      snapshot.reputation.quality,
      snapshot.reputation.fairness,
      snapshot.reputation.vibe,
      snapshot.riskState.state,
      JSON.stringify(snapshot.riskTags),
      snapshot.highRiskRevenueEnabled,
      snapshot.leaderboardEligible,
      input.evidence.dayEnd.eventHash,
      input.evidence.dayEnd.snapshotHash,
      JSON.stringify(input.evidence.dayEnd.finalResourceVersions),
      JSON.stringify(input.evidence.dayEnd.fixedFieldSnapshot),
    );
    if (
      inserted.length !== 1 ||
      inserted[0]?.id !== input.dayEndSnapshotId ||
      inserted[0]?.eventHash !== input.evidence.dayEnd.eventHash ||
      inserted[0]?.snapshotHash !== input.evidence.dayEnd.snapshotHash
    ) {
      throw new CommandError(409, 'SETTLEMENT_DAY_END_CONFLICT');
    }
  }

  private async insertRiskState(input: PersistFirstDaySettlementInput): Promise<void> {
    const snapshot = input.dayEndResult.snapshot;
    const transition = input.dayEndResult.events.find(
      (event): event is RiskTransitionEvent => event.type === 'RISK_STATE_TRANSITION',
    );
    const precondition =
      transition?.precondition ??
      Object.freeze({
        state: 'NORMAL',
        consecutiveDelinquentDays: 0,
        consecutiveResolutionDays: 0,
        shortfall: snapshot.shortfall.minorUnits,
        delinquencyBaselineShortfall: null,
        resolutionComparisonShortfall: snapshot.resolutionComparisonShortfall.minorUnits,
        repaymentRatio: 1,
        minimumReputation: Math.min(...Object.values(snapshot.reputation)),
        rehabExitApproved: false,
      });
    const postcondition =
      transition?.postcondition ??
      Object.freeze({
        state: snapshot.riskState.state,
        consecutiveDelinquentDays: snapshot.riskState.consecutiveDelinquentDays,
        consecutiveResolutionDays: snapshot.riskState.consecutiveResolutionDays,
        highRiskRevenueEnabled: snapshot.highRiskRevenueEnabled,
        leaderboardEligible: snapshot.leaderboardEligible,
      });
    const id = privateId('risk-state', input.saveId, '1');
    const inserted = await this.persistence.mutate<readonly Row[]>(
      `/* settle-business-day:insert-risk-state */
       INSERT INTO "RiskState" (
         "id","restaurantId","saveId","version","businessDay","status","reason","precondition","postcondition"
       ) VALUES ($1,$2,$3,1,1,$4,$5,$6::jsonb,$7::jsonb)
       ON CONFLICT DO NOTHING RETURNING "id","version","status"::text AS "status"`,
      id,
      input.restaurantId,
      input.saveId,
      snapshot.riskState.state,
      transition?.reason ?? 'DAY_END_NO_STATE_CHANGE',
      JSON.stringify(precondition),
      JSON.stringify(postcondition),
    );
    if (
      inserted.length !== 1 ||
      inserted[0]?.id !== id ||
      databaseInteger(inserted[0]?.version, 'risk version') !== 1 ||
      inserted[0]?.status !== snapshot.riskState.state
    ) {
      throw new CommandError(409, 'SETTLEMENT_RISK_CONFLICT');
    }
  }

  private async insertReputationHistory(input: PersistFirstDaySettlementInput): Promise<void> {
    const values = Object.entries(input.dayEndResult.snapshot.reputation) as readonly (readonly [
      'price' | 'speed' | 'quality' | 'fairness' | 'vibe',
      number,
    ])[];
    for (const [dimension, score] of values) {
      const databaseDimension = dimension.toUpperCase();
      const id = privateId('reputation-history', input.saveId, '1', databaseDimension);
      const inserted = await this.persistence.mutate<readonly Row[]>(
        `/* settle-business-day:insert-reputation-history */
         INSERT INTO "ReputationDimensionHistory" (
           "id","restaurantId","saveId","businessDay","dimension","version","score","reason"
         ) VALUES ($1,$2,$3,1,$4,1,$5,'DAY_END_SERVICE_RESULT')
         ON CONFLICT DO NOTHING RETURNING "id","dimension"::text AS "dimension","version","score"`,
        id,
        input.restaurantId,
        input.saveId,
        databaseDimension,
        score,
      );
      if (
        inserted.length !== 1 ||
        inserted[0]?.id !== id ||
        inserted[0]?.dimension !== databaseDimension ||
        databaseInteger(inserted[0]?.version, 'reputation version') !== 1 ||
        databaseReputationScore(inserted[0]?.score, 'reputation score') !== score
      ) {
        throw new CommandError(409, 'SETTLEMENT_REPUTATION_CONFLICT');
      }
    }
  }
}

function parsePool(row: Row): OpenInventoryPoolAuthority {
  const pool = row.pool;
  const kind = row.storageBundleKind;
  if (pool !== 'DURABLE' && pool !== 'PERISHABLE') throw new Error('unknown inventory pool');
  if (kind !== 'NONE' && kind !== 'BASIC' && kind !== 'AGED' && kind !== 'VERSIONED_UPGRADE') {
    throw new Error('unknown storage bundle kind');
  }
  return Object.freeze({
    saveId: stringValue(row.saveId, 'pool save id'),
    pool,
    revision: positive(row.revision, 'pool revision'),
    capacityPoints: databaseInteger(row.capacityPoints, 'pool capacity'),
    storageBundleVersion: stringValue(row.storageBundleVersion, 'bundle version'),
    storageBundleKind: kind,
  });
}

function parseExecution(row: Row): PersistedAdvanceExecution {
  return Object.freeze({
    id: stringValue(row.id, 'execution id'),
    ordinal: positive(row.ordinal, 'execution ordinal'),
    periodKey: periodKey(row.periodKey),
    commandId: stringValue(row.commandId, 'execution command id'),
    simulationRuleVersion: stringValue(row.simulationRuleVersion, 'execution rule'),
    inputSnapshot: jsonObject(
      row.inputSnapshot,
      'execution input',
    ) as AdvanceServicePeriodInputSnapshot,
    inputHash: hash(row.inputHash, 'execution input hash'),
    resultSnapshot: jsonObject(
      row.resultSnapshot,
      'execution result',
    ) as AdvanceServicePeriodResultSnapshot,
    resultHash: hash(row.resultHash, 'execution result hash'),
  });
}

function parseStock(row: Row): PersistedInventoryStock {
  const pool = row.pool;
  if (pool !== 'DURABLE' && pool !== 'PERISHABLE') throw new Error('unknown stock pool');
  return Object.freeze({
    id: stringValue(row.id, 'stock id'),
    inventoryItemId: stringValue(row.inventoryItemId, 'item id'),
    ingredientId: stringValue(row.ingredientId, 'ingredient id'),
    pool,
    version: positive(row.version, 'stock version'),
    onHandPoints: databaseInteger(row.onHand, 'on hand'),
    reservedUndeliveredPoints: databaseInteger(row.reservedUndelivered, 'reserved undelivered'),
    costPoolMinor: databaseBigintString(row.costPoolMinor, 'cost pool'),
  });
}

function parseAudit(row: Row): PersistedInventoryAudit {
  return Object.freeze({
    commandId: stringValue(row.commandId, 'audit command id'),
    commandSequence: databaseInteger(row.commandSequence, 'audit command sequence'),
    ingredientId: stringValue(row.ingredientId, 'audit ingredient id'),
    metadata: jsonObject(row.metadata, 'audit metadata'),
  });
}

function privateId(kind: string, ...parts: readonly string[]): string {
  return `${kind}:${createHash('sha256').update(parts.join('\u0000')).digest('hex')}`;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new Error(`${name} is required`);
  return value;
}

function databaseBigintString(value: unknown, name: string): string {
  const text =
    typeof value === 'bigint'
      ? value.toString()
      : typeof value === 'number' && Number.isSafeInteger(value)
        ? String(value)
        : value;
  if (typeof text !== 'string' || !/^-?\d+$/.test(text)) {
    throw new Error(`${name} must be an integer`);
  }
  return text;
}

function databaseInteger(value: unknown, name: string): number {
  const text = databaseBigintString(value, name);
  const parsed = BigInt(text);
  if (parsed < 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${name} is outside the non-negative safe integer range`);
  }
  return Number(parsed);
}

function databaseReputationScore(value: unknown, name: string): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new Error(`${name} must be a 0..100 score with at most six decimals`);
  }
  return parsed;
}

function positive(value: unknown, name: string): number {
  const parsed = databaseInteger(value, name);
  if (parsed < 1) throw new Error(`${name} must be positive`);
  return parsed;
}

function one(value: unknown): 1 {
  if (databaseInteger(value, 'pre-open revision') !== 1) {
    throw new Error('pre-open revision must be one');
  }
  return 1;
}

function hash(value: unknown, name: string): string {
  const text = stringValue(value, name);
  if (!/^[a-f0-9]{64}$/.test(text)) throw new Error(`${name} is invalid`);
  return text;
}

function jsonObject(value: unknown, name: string): Readonly<Record<string, unknown>> {
  let parsed = value;
  if (typeof parsed === 'string') parsed = JSON.parse(parsed) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${name} must be an object`);
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function periodPlan(value: unknown): 'TWO_PERIODS' | 'THREE_PERIODS' {
  if (value !== 'TWO_PERIODS' && value !== 'THREE_PERIODS') throw new Error('unknown period plan');
  return value;
}

function periodKey(value: unknown): 'LUNCH' | 'OFF_PEAK' | 'DINNER' {
  if (value !== 'LUNCH' && value !== 'OFF_PEAK' && value !== 'DINNER') {
    throw new Error('unknown period key');
  }
  return value;
}

function scenario(value: unknown): FirstDayOpenAuthority['save']['scenario'] {
  if (value !== 'EMPTY_PREMISES' && value !== 'DEFAULT_SMALL_SHOP' && value !== 'TROUBLED_SHOP') {
    throw new Error('unknown scenario');
  }
  return value;
}

function operatingMode(value: unknown): FirstDayOpenAuthority['save']['operatingMode'] {
  if (value !== 'STRATEGY' && value !== 'LIGHTWEIGHT_REALTIME') {
    throw new Error('unknown operating mode');
  }
  return value;
}
