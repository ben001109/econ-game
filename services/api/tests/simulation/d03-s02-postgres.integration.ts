import assert from 'node:assert/strict';

import {
  PostgresSimulationPlatform,
  SimulationJobError,
  type JsonObject,
  type SimulationDatabase,
} from '../../../worker/src/simulation-platform.js';

const databaseUrl = process.env.D03_S02_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('D03_S02_TEST_DATABASE_URL is required');

type IntegrationDatabase = SimulationDatabase &
  Readonly<{
    $disconnect(): Promise<void>;
    $executeRawUnsafe(query: string, ...values: readonly unknown[]): Promise<number>;
  }>;

const prismaModule = (await import('@prisma/client')) as unknown as Readonly<{
  PrismaClient: new (options?: unknown) => IntegrationDatabase;
}>;
const database = new prismaModule.PrismaClient({
  datasources: { db: { url: databaseUrl } },
});
const platform = new PostgresSimulationPlatform(database);

const marketRuleV1 = Object.freeze({
  minimumModifierBps: -1000,
  maximumModifierBps: 1000,
  dayOneUsesReference: true,
}) satisfies JsonObject;
const marketRuleV2 = Object.freeze({
  minimumModifierBps: 0,
  maximumModifierBps: 0,
  dayOneUsesReference: true,
}) satisfies JsonObject;
const ingredientCatalog = Object.freeze({
  ingredients: Object.freeze([
    Object.freeze({
      ingredientId: 'rice',
      currency: 'TWD',
      referenceUnitPriceMinor: '30',
    }),
    Object.freeze({
      ingredientId: 'egg',
      currency: 'TWD',
      referenceUnitPriceMinor: '20',
    }),
  ]),
}) satisfies JsonObject;

function jobId(ordinal: number): string {
  return `20000000-0000-4000-8000-${ordinal.toString().padStart(12, '0')}`;
}

async function jobState(jobId: string) {
  const rows = await database.$queryRawUnsafe<
    readonly Readonly<{
      status: string;
      attemptCount: number;
      errorCode: string | null;
    }>[]
  >(
    `SELECT "status"::text AS "status", "attemptCount", "errorCode"
     FROM "SimulationJob" WHERE "id" = $1`,
    jobId,
  );
  return rows[0];
}

try {
  await platform.registry.register({
    kind: 'RULE',
    key: 'MARKET_PRICE',
    version: 'market-rule/v1',
    processorId: 'D03_MARKET_TICK_SHA256_V1',
    payload: marketRuleV1,
  });
  await platform.registry.register({
    kind: 'RULE',
    key: 'MARKET_PRICE',
    version: 'market-rule/v2',
    processorId: 'D03_MARKET_TICK_SHA256_V1',
    payload: marketRuleV2,
  });
  await platform.registry.register({
    kind: 'CATALOG',
    key: 'INGREDIENT_PRICE',
    version: 'ingredient-catalog/v1',
    payload: ingredientCatalog,
  });

  await assert.rejects(
    () =>
      platform.registry.register({
        kind: 'RULE',
        key: 'MARKET_PRICE',
        version: 'market-rule/v1',
        processorId: 'D03_MARKET_TICK_SHA256_V1',
        payload: marketRuleV2,
      }),
    (error: unknown) =>
      error instanceof SimulationJobError && error.code === 'VERSION_ARTIFACT_IMMUTABLE_CONFLICT',
  );

  await assert.rejects(() =>
    platform.assertMarketTickMaterialized({
      restaurantId: 'restaurant-a',
      saveId: 'save-a',
      businessDay: 2,
      tickKind: 'SUPPLY_PRICE',
    }),
  );

  await database.$executeRawUnsafe(
    `CREATE FUNCTION d03_test_reject_first_simulation_job() RETURNS TRIGGER
     LANGUAGE plpgsql AS $$
     BEGIN
       RAISE EXCEPTION 'test transaction interruption' USING ERRCODE = '40001';
     END;
     $$`,
  );
  await database.$executeRawUnsafe(
    `CREATE TRIGGER d03_test_reject_first_simulation_job
     BEFORE INSERT ON "SimulationJob"
     FOR EACH ROW EXECUTE FUNCTION d03_test_reject_first_simulation_job()`,
  );
  await assert.rejects(() => platform.ingestNextOutbox());
  const interruptedCounts = await database.$queryRawUnsafe<
    readonly Readonly<{
      receipts: bigint;
      jobs: bigint;
    }>[]
  >(
    `SELECT
       (SELECT count(*) FROM "OutboxConsumerReceipt"
        WHERE "consumerName" = 'simulation.dispatch.v1')::bigint AS "receipts",
       (SELECT count(*) FROM "SimulationJob")::bigint AS "jobs"`,
  );
  assert.deepEqual(interruptedCounts[0], { receipts: 0n, jobs: 0n });
  await database.$executeRawUnsafe(
    `DROP TRIGGER d03_test_reject_first_simulation_job ON "SimulationJob"`,
  );
  await database.$executeRawUnsafe(`DROP FUNCTION d03_test_reject_first_simulation_job()`);

  assert.equal(await platform.ingestNextOutbox(), true);
  assert.equal(await platform.runOnce('integration.worker', 60), true);
  assert.deepEqual(await jobState(jobId(1)), {
    status: 'SUCCEEDED',
    attemptCount: 1,
    errorCode: null,
  });
  await platform.assertMarketTickMaterialized({
    restaurantId: 'restaurant-a',
    saveId: 'save-a',
    businessDay: 2,
    tickKind: 'SUPPLY_PRICE',
  });

  const firstReplay = await database.$queryRawUnsafe<
    readonly Readonly<{
      ruleVersion: string;
      catalogSelections: unknown;
    }>[]
  >(
    `SELECT "ruleVersion", "catalogSelections"
     FROM "VersionedReplayExecution" WHERE "jobId" = $1`,
    jobId(1),
  );
  assert.equal(firstReplay[0]?.ruleVersion, 'market-rule/v1');
  assert.deepEqual(firstReplay[0]?.catalogSelections, [
    {
      kind: 'CATALOG',
      key: 'INGREDIENT_PRICE',
      version: 'ingredient-catalog/v1',
      payloadHash: await (async () => {
        const artifact = await platform.registry.resolveExact({
          kind: 'CATALOG',
          key: 'INGREDIENT_PRICE',
          version: 'ingredient-catalog/v1',
        });
        return artifact.payloadHash;
      })(),
    },
  ]);

  assert.equal(await platform.ingestNextOutbox(), true);
  assert.equal(await platform.runOnce('integration.worker', 60), true);
  const tickCount = await database.$queryRawUnsafe<readonly { count: bigint }[]>(
    `SELECT count(*)::bigint AS "count" FROM "MarketTick"
     WHERE "saveId" = 'save-a' AND "businessDay" = 2 AND "tickKind" = 'SUPPLY_PRICE'`,
  );
  assert.equal(tickCount[0]?.count, 1n);
  assert.equal((await jobState(jobId(2)))?.status, 'SUCCEEDED');

  assert.equal(await platform.ingestNextOutbox(), true);
  assert.equal(await platform.runOnce('integration.worker', 60), true);
  assert.deepEqual(await jobState(jobId(3)), {
    status: 'FAILED',
    attemptCount: 1,
    errorCode: 'REPLAY_VERSION_MISSING',
  });

  assert.equal(await platform.ingestNextOutbox(), true);
  const firstLease = await platform.claim('integration.worker.one', 5);
  assert.equal(firstLease?.id, jobId(4));
  await database.$queryRawUnsafe(
    `UPDATE "SimulationJob" SET "leaseExpiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 second'
     WHERE "id" = $1`,
    jobId(4),
  );
  const reclaimedLease = await platform.claim('integration.worker.two', 60);
  assert.equal(reclaimedLease?.id, jobId(4));
  assert.equal(reclaimedLease?.attemptCount, 2);
  await database.$queryRawUnsafe(
    `SELECT d03_record_simulation_job_failure(
       $1,$2,'PERMANENT'::"SimulationJobErrorClass",'LEASE_RECLAIM_PROOF','{}'::jsonb
     )`,
    jobId(4),
    reclaimedLease?.leaseToken,
  );
  assert.equal((await jobState(jobId(4)))?.status, 'FAILED');

  assert.equal(await platform.ingestNextOutbox(), true);
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const claim = await platform.claim('integration.retry.worker', 60);
    assert.equal(claim?.id, jobId(5));
    assert.equal(claim.attemptCount, attempt);
    const status = await database.$queryRawUnsafe<readonly { status: string }[]>(
      `SELECT d03_record_simulation_job_failure(
         $1,$2,'TRANSIENT'::"SimulationJobErrorClass",'TEMPORARY_DATABASE_UNAVAILABLE',
         '{"category":"infrastructure"}'::jsonb
       )::text AS "status"`,
      jobId(5),
      claim.leaseToken,
    );
    assert.equal(status[0]?.status, attempt < 5 ? 'PENDING' : 'DEAD_LETTER');
    if (attempt < 5) {
      await database.$queryRawUnsafe(
        `UPDATE "SimulationJob" SET "availableAt" = CURRENT_TIMESTAMP - INTERVAL '1 second'
         WHERE "id" = $1`,
        jobId(5),
      );
    }
  }
  assert.deepEqual(await jobState(jobId(5)), {
    status: 'DEAD_LETTER',
    attemptCount: 5,
    errorCode: 'TEMPORARY_DATABASE_UNAVAILABLE',
  });

  await database.$executeRawUnsafe(
    `CREATE FUNCTION b2_test_reject_first_dead_letter() RETURNS TRIGGER
     LANGUAGE plpgsql AS $$
     BEGIN
       RAISE EXCEPTION 'test dead-letter transaction interruption' USING ERRCODE = '40001';
     END;
     $$`,
  );
  await database.$executeRawUnsafe(
    `CREATE TRIGGER b2_test_reject_first_dead_letter
     BEFORE INSERT ON "OutboxConsumerDeadLetter"
     FOR EACH ROW EXECUTE FUNCTION b2_test_reject_first_dead_letter()`,
  );
  await assert.rejects(() => platform.ingestNextOutbox());
  const interruptedDeadLetter = await database.$queryRawUnsafe<
    readonly Readonly<{ receipts: bigint; deadLetters: bigint }>[]
  >(
    `SELECT
       (SELECT count(*) FROM "OutboxConsumerReceipt"
        WHERE "consumerName" = 'simulation.dispatch.v1')::bigint AS "receipts",
       (SELECT count(*) FROM "OutboxConsumerDeadLetter")::bigint AS "deadLetters"`,
  );
  assert.deepEqual(interruptedDeadLetter[0], { receipts: 5n, deadLetters: 0n });
  await database.$executeRawUnsafe(
    `DROP TRIGGER b2_test_reject_first_dead_letter ON "OutboxConsumerDeadLetter"`,
  );
  await database.$executeRawUnsafe(`DROP FUNCTION b2_test_reject_first_dead_letter()`);

  assert.deepEqual(await Promise.all([platform.ingestNextOutbox(), platform.ingestNextOutbox()]), [
    true,
    true,
  ]);
  assert.equal(await platform.ingestNextOutbox(), false);
  const durableDispatchCounts = await database.$queryRawUnsafe<
    readonly Readonly<{
      receipts: bigint;
      jobs: bigint;
      audits: bigint;
      deadLetters: bigint;
    }>[]
  >(
    `SELECT
       (SELECT count(*) FROM "OutboxConsumerReceipt"
        WHERE "consumerName" = 'simulation.dispatch.v1')::bigint AS "receipts",
       (SELECT count(*) FROM "SimulationJob")::bigint AS "jobs",
       (SELECT count(*) FROM "SimulationJobAudit" WHERE "action" = 'ENQUEUED')::bigint AS "audits",
       (SELECT count(*) FROM "OutboxConsumerDeadLetter")::bigint AS "deadLetters"`,
  );
  assert.deepEqual(durableDispatchCounts[0], {
    receipts: 7n,
    jobs: 5n,
    audits: 5n,
    deadLetters: 2n,
  });

  console.log('D03-S-02 TypeScript/PostgreSQL durable execution integration passed.');
} finally {
  await database.$disconnect();
}
