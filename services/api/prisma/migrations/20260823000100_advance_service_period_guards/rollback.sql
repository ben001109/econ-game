BEGIN;

DROP TRIGGER IF EXISTS "BusinessDay_service_complete_guard" ON "BusinessDay";
DROP FUNCTION IF EXISTS p0_guard_service_complete_transition();
DROP TRIGGER IF EXISTS "ServicePeriodExecution_order_guard" ON "ServicePeriodExecution";
DROP FUNCTION IF EXISTS p0_guard_service_period_order();

COMMIT;
