-- D01-S-01 rollback for a database that has applied migration.sql.
--
-- This is a destructive schema rollback and must only be used against an
-- isolated/restored database after backup verification. PostgreSQL roles are
-- intentionally untouched because Supabase owns anon/authenticated/service_role.

DROP TABLE IF EXISTS "IdempotencyRecord";
DROP TABLE IF EXISTS "LoanInstallment";
DROP TABLE IF EXISTS "Loan";
DROP TABLE IF EXISTS "ReputationDimensionHistory";
DROP TABLE IF EXISTS "RiskState";
DROP TABLE IF EXISTS "DayEndSnapshot";
DROP TABLE IF EXISTS "ReplayEvent";
DROP TABLE IF EXISTS "OrderServiceState";
DROP TABLE IF EXISTS "Tip";
DROP TABLE IF EXISTS "TaxLine";
DROP TABLE IF EXISTS "Payment";
DROP TABLE IF EXISTS "OrderItem";
DROP TABLE IF EXISTS "Order";
DROP TABLE IF EXISTS "InventoryTransaction";
DROP TABLE IF EXISTS "InventoryStock";
DROP TABLE IF EXISTS "InventoryItem";
DROP TABLE IF EXISTS "MenuSelection";
DROP TABLE IF EXISTS "RecipeVersion";
DROP TABLE IF EXISTS "MenuCatalog";
DROP TABLE IF EXISTS "EmployeeShift";
DROP TABLE IF EXISTS "WageContract";
DROP TABLE IF EXISTS "Employee";
DROP TABLE IF EXISTS "MenuItem";
DROP TABLE IF EXISTS "Table";
DROP TABLE IF EXISTS "Branch";
DROP TABLE IF EXISTS "CompetitiveSave";
DROP TABLE IF EXISTS "WipeBatch";
DROP TABLE IF EXISTS "AuditLog";
DROP TABLE IF EXISTS "RestaurantMembership";
DROP TABLE IF EXISTS "IdentityLink";
DROP TABLE IF EXISTS "Restaurant";
DROP TABLE IF EXISTS "Player";

DROP FUNCTION IF EXISTS d01_is_restaurant_member(TEXT);
DROP FUNCTION IF EXISTS d01_clerk_subject();
DROP FUNCTION IF EXISTS d01_lock_competitive_save_fields();
DROP FUNCTION IF EXISTS d01_reject_history_mutation();

DROP TYPE IF EXISTS "WipeBatchStatus";
DROP TYPE IF EXISTS "ReputationDimension";
DROP TYPE IF EXISTS "FinancialRiskStatus";
DROP TYPE IF EXISTS "InventoryTransactionKind";
DROP TYPE IF EXISTS "EmployeeKind";
DROP TYPE IF EXISTS "SaveMode";
DROP TYPE IF EXISTS "MembershipRole";
DROP TYPE IF EXISTS "PaymentMethod";
DROP TYPE IF EXISTS "OrderStatus";
DROP TYPE IF EXISTS "OrderType";
