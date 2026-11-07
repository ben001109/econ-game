-- D01-S-01 P0 persistence baseline.
--
-- This migration is intentionally hand-written and reviewable. It establishes
-- the legacy Restaurant/POS tables and adds the tenant-scoped D-01 families.
-- All core writes remain API/worker-only: authenticated clients receive SELECT
-- policies only. The JWT subject session value is set by the trusted Supabase
-- gateway; D04 owns the final Clerk JWT validation and claim configuration.

-- This targets Supabase PostgreSQL. Fail before creating any schema object when
-- its standard PostgREST roles are absent or service_role cannot bypass RLS;
-- creating substitute roles here could silently establish the wrong trust model.
DO $$
DECLARE
  missing_roles TEXT;
BEGIN
  SELECT string_agg(required_role, ', ' ORDER BY required_role)
    INTO missing_roles
  FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS required(required_role)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = required.required_role
  );

  IF missing_roles IS NOT NULL THEN
    RAISE EXCEPTION 'D01 migration requires Supabase roles anon, authenticated, and service_role; missing: %', missing_roles
      USING ERRCODE = '0A000';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'service_role' AND rolbypassrls
  ) THEN
    RAISE EXCEPTION 'D01 migration requires Supabase service_role with BYPASSRLS'
      USING ERRCODE = '0A000';
  END IF;
END;
$$;

CREATE TYPE "OrderType" AS ENUM ('DINE_IN', 'TAKEOUT', 'DELIVERY');
CREATE TYPE "OrderStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'SERVED', 'CLOSED', 'CANCELED');
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'CARD');
CREATE TYPE "MembershipRole" AS ENUM ('OWNER', 'MANAGER', 'CASHIER', 'KITCHEN', 'INVENTORY', 'VIEWER');
CREATE TYPE "SaveMode" AS ENUM ('COMPETITIVE', 'SANDBOX');
CREATE TYPE "EmployeeKind" AS ENUM ('PLAYER', 'NPC');
CREATE TYPE "InventoryTransactionKind" AS ENUM ('RECEIPT', 'CONSUMPTION', 'RESERVATION', 'RELEASE', 'WASTE', 'ADJUSTMENT');
CREATE TYPE "FinancialRiskStatus" AS ENUM ('NORMAL', 'DELINQUENT', 'RESOLUTION', 'REHAB');
CREATE TYPE "ReputationDimension" AS ENUM ('PRICE', 'SPEED', 'QUALITY', 'FAIRNESS', 'VIBE');
CREATE TYPE "WipeBatchStatus" AS ENUM ('DRAFT', 'APPROVED', 'ANNOUNCED', 'SCHEDULED', 'RUNNING', 'VERIFYING', 'COMPLETED', 'FAILED');

CREATE TABLE "Player" (
  "id" TEXT PRIMARY KEY,
  "clerkUserId" TEXT NOT NULL UNIQUE,
  "displayName" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Player_id_clerkUserId_key" UNIQUE ("id", "clerkUserId")
);

CREATE TABLE "Restaurant" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "timezone" TEXT NOT NULL DEFAULT 'UTC',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "IdentityLink" (
  "id" TEXT PRIMARY KEY,
  "playerId" TEXT NOT NULL,
  "clerkUserId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "providerUserId" TEXT NOT NULL,
  "verifiedAt" TIMESTAMPTZ NOT NULL,
  "revokedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IdentityLink_player_subject_fkey" FOREIGN KEY ("playerId", "clerkUserId") REFERENCES "Player"("id", "clerkUserId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "IdentityLink_provider_providerUserId_key" UNIQUE ("provider", "providerUserId"),
  CONSTRAINT "IdentityLink_clerkUserId_provider_key" UNIQUE ("clerkUserId", "provider")
);

CREATE INDEX "IdentityLink_playerId_idx" ON "IdentityLink" ("playerId");

CREATE TABLE "RestaurantMembership" (
  "id" TEXT PRIMARY KEY,
  "playerId" TEXT NOT NULL,
  "restaurantId" TEXT NOT NULL,
  "role" "MembershipRole" NOT NULL,
  "branchScope" JSONB,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMPTZ,
  CONSTRAINT "RestaurantMembership_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "RestaurantMembership_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "RestaurantMembership_playerId_restaurantId_key" UNIQUE ("playerId", "restaurantId")
);

CREATE INDEX "RestaurantMembership_restaurantId_revokedAt_idx" ON "RestaurantMembership" ("restaurantId", "revokedAt");
CREATE INDEX "RestaurantMembership_playerId_revokedAt_idx" ON "RestaurantMembership" ("playerId", "revokedAt");

CREATE TABLE "AuditLog" (
  "id" TEXT PRIMARY KEY,
  "restaurantId" TEXT,
  "actorPlayerId" TEXT,
  "actorType" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "targetType" TEXT NOT NULL,
  "targetId" TEXT NOT NULL,
  "metadata" JSONB NOT NULL,
  "correlationId" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuditLog_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "AuditLog_actorPlayerId_fkey" FOREIGN KEY ("actorPlayerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "AuditLog_restaurantId_createdAt_idx" ON "AuditLog" ("restaurantId", "createdAt");
CREATE INDEX "AuditLog_actorPlayerId_createdAt_idx" ON "AuditLog" ("actorPlayerId", "createdAt");
CREATE INDEX "AuditLog_targetType_targetId_idx" ON "AuditLog" ("targetType", "targetId");

CREATE TABLE "WipeBatch" (
  "id" TEXT PRIMARY KEY,
  "restaurantId" TEXT,
  "status" "WipeBatchStatus" NOT NULL,
  "scope" JSONB NOT NULL,
  "reason" TEXT NOT NULL,
  "requestedByPlayerId" TEXT,
  "approvedByPlayerId" TEXT,
  "announcedAt" TIMESTAMPTZ,
  "startedAt" TIMESTAMPTZ,
  "completedAt" TIMESTAMPTZ,
  "verificationSnapshot" JSONB,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WipeBatch_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "WipeBatch_distinct_approver_check" CHECK ("approvedByPlayerId" IS NULL OR "requestedByPlayerId" IS NULL OR "approvedByPlayerId" <> "requestedByPlayerId")
);

CREATE INDEX "WipeBatch_restaurantId_createdAt_idx" ON "WipeBatch" ("restaurantId", "createdAt");
CREATE INDEX "WipeBatch_status_createdAt_idx" ON "WipeBatch" ("status", "createdAt");

CREATE TABLE "CompetitiveSave" (
  "id" TEXT PRIMARY KEY,
  "restaurantId" TEXT NOT NULL,
  "ownerPlayerId" TEXT NOT NULL,
  "mode" "SaveMode" NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "openingScenario" TEXT NOT NULL,
  "operatingMode" TEXT NOT NULL,
  "servicePeriodPlan" TEXT NOT NULL,
  "difficultyGroup" TEXT NOT NULL,
  "demandSeed" TEXT NOT NULL,
  "simulationRuleVersion" TEXT NOT NULL,
  "openingSnapshot" JSONB NOT NULL,
  "openingSnapshotHash" VARCHAR(64) NOT NULL,
  "retiredAt" TIMESTAMPTZ,
  "retiredByWipeBatchId" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CompetitiveSave_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CompetitiveSave_ownerPlayerId_fkey" FOREIGN KEY ("ownerPlayerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CompetitiveSave_owner_membership_fkey" FOREIGN KEY ("ownerPlayerId", "restaurantId") REFERENCES "RestaurantMembership"("playerId", "restaurantId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CompetitiveSave_retiredByWipeBatchId_fkey" FOREIGN KEY ("retiredByWipeBatchId") REFERENCES "WipeBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CompetitiveSave_version_check" CHECK ("version" > 0),
  CONSTRAINT "CompetitiveSave_openingSnapshotHash_check" CHECK ("openingSnapshotHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "CompetitiveSave_restaurantId_id_key" UNIQUE ("restaurantId", "id"),
  CONSTRAINT "CompetitiveSave_restaurantId_id_version_key" UNIQUE ("restaurantId", "id", "version")
);

CREATE INDEX "CompetitiveSave_restaurantId_retiredAt_idx" ON "CompetitiveSave" ("restaurantId", "retiredAt");
CREATE INDEX "CompetitiveSave_ownerPlayerId_retiredAt_idx" ON "CompetitiveSave" ("ownerPlayerId", "retiredAt");

CREATE TABLE "Branch" (
  "id" TEXT PRIMARY KEY,
  "restaurantId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "address" TEXT,
  "hours" TEXT,
  CONSTRAINT "Branch_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Branch_restaurantId_id_key" UNIQUE ("restaurantId", "id")
);

CREATE INDEX "Branch_restaurantId_idx" ON "Branch" ("restaurantId");

CREATE TABLE "Table" (
  "id" TEXT PRIMARY KEY,
  "branchId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "seats" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'AVAILABLE',
  CONSTRAINT "Table_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Table_branchId_code_key" UNIQUE ("branchId", "code"),
  CONSTRAINT "Table_branchId_id_key" UNIQUE ("branchId", "id"),
  CONSTRAINT "Table_seats_check" CHECK ("seats" > 0)
);

CREATE INDEX "Table_branchId_idx" ON "Table" ("branchId");

CREATE TABLE "MenuItem" (
  "id" TEXT PRIMARY KEY,
  "restaurantId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "sku" TEXT NOT NULL UNIQUE,
  "name" TEXT NOT NULL,
  "basePrice" DECIMAL(10,2) NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT TRUE,
  CONSTRAINT "MenuItem_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "MenuItem_branch_scope_fkey" FOREIGN KEY ("restaurantId", "branchId") REFERENCES "Branch"("restaurantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "MenuItem_restaurantId_id_key" UNIQUE ("restaurantId", "id"),
  CONSTRAINT "MenuItem_branchId_id_key" UNIQUE ("branchId", "id"),
  CONSTRAINT "MenuItem_basePrice_check" CHECK ("basePrice" >= 0)
);

CREATE INDEX "MenuItem_restaurantId_active_idx" ON "MenuItem" ("restaurantId", "active");
CREATE INDEX "MenuItem_branchId_active_idx" ON "MenuItem" ("branchId", "active");

CREATE TABLE "Employee" (
  "id" TEXT PRIMARY KEY,
  "restaurantId" TEXT NOT NULL,
  "saveId" TEXT NOT NULL,
  "playerId" TEXT,
  "stableKey" TEXT NOT NULL,
  "kind" "EmployeeKind" NOT NULL,
  "role" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Employee_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Employee_save_scope_fkey" FOREIGN KEY ("restaurantId", "saveId") REFERENCES "CompetitiveSave"("restaurantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Employee_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Employee_saveId_stableKey_key" UNIQUE ("saveId", "stableKey"),
  CONSTRAINT "Employee_restaurantId_saveId_id_key" UNIQUE ("restaurantId", "saveId", "id")
);

CREATE INDEX "Employee_restaurantId_active_idx" ON "Employee" ("restaurantId", "active");
CREATE INDEX "Employee_playerId_idx" ON "Employee" ("playerId");

CREATE TABLE "WageContract" (
  "id" TEXT PRIMARY KEY,
  "restaurantId" TEXT NOT NULL,
  "saveId" TEXT NOT NULL,
  "employeeId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "termsVersion" TEXT NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "salaryMinor" BIGINT NOT NULL,
  "salaryUnit" TEXT NOT NULL,
  "shiftCoverage" TEXT NOT NULL,
  "effectiveDay" INTEGER NOT NULL,
  "endDay" INTEGER,
  "bonusType" TEXT NOT NULL,
  "bonusMinor" BIGINT NOT NULL DEFAULT 0,
  "profitShareBps" INTEGER NOT NULL DEFAULT 0,
  "termsSnapshot" JSONB NOT NULL,
  "acceptedAt" TIMESTAMPTZ,
  "supersedesId" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WageContract_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "WageContract_save_scope_fkey" FOREIGN KEY ("restaurantId", "saveId") REFERENCES "CompetitiveSave"("restaurantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "WageContract_employee_scope_fkey" FOREIGN KEY ("restaurantId", "saveId", "employeeId") REFERENCES "Employee"("restaurantId", "saveId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "WageContract_supersedes_scope_fkey" FOREIGN KEY ("restaurantId", "employeeId", "supersedesId") REFERENCES "WageContract"("restaurantId", "employeeId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "WageContract_employeeId_version_key" UNIQUE ("employeeId", "version"),
  CONSTRAINT "WageContract_restaurantId_employeeId_id_key" UNIQUE ("restaurantId", "employeeId", "id"),
  CONSTRAINT "WageContract_terms_check" CHECK ("version" > 0 AND "effectiveDay" > 0 AND ("endDay" IS NULL OR "endDay" >= "effectiveDay") AND "salaryMinor" >= 0 AND "bonusMinor" >= 0 AND "profitShareBps" BETWEEN 0 AND 1500)
);

CREATE INDEX "WageContract_restaurantId_effectiveDay_idx" ON "WageContract" ("restaurantId", "effectiveDay");
CREATE INDEX "WageContract_saveId_effectiveDay_idx" ON "WageContract" ("saveId", "effectiveDay");

CREATE TABLE "EmployeeShift" (
  "id" TEXT PRIMARY KEY,
  "restaurantId" TEXT NOT NULL,
  "saveId" TEXT NOT NULL,
  "employeeId" TEXT NOT NULL,
  "wageContractId" TEXT NOT NULL,
  "businessDay" INTEGER NOT NULL,
  "servicePeriod" TEXT NOT NULL,
  "shiftSnapshot" JSONB NOT NULL,
  "completedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EmployeeShift_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "EmployeeShift_save_scope_fkey" FOREIGN KEY ("restaurantId", "saveId") REFERENCES "CompetitiveSave"("restaurantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "EmployeeShift_employee_scope_fkey" FOREIGN KEY ("restaurantId", "saveId", "employeeId") REFERENCES "Employee"("restaurantId", "saveId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "EmployeeShift_wage_contract_scope_fkey" FOREIGN KEY ("restaurantId", "employeeId", "wageContractId") REFERENCES "WageContract"("restaurantId", "employeeId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "EmployeeShift_employeeId_businessDay_servicePeriod_key" UNIQUE ("employeeId", "businessDay", "servicePeriod"),
  CONSTRAINT "EmployeeShift_businessDay_check" CHECK ("businessDay" > 0)
);

CREATE INDEX "EmployeeShift_restaurantId_businessDay_idx" ON "EmployeeShift" ("restaurantId", "businessDay");
CREATE INDEX "EmployeeShift_saveId_businessDay_idx" ON "EmployeeShift" ("saveId", "businessDay");

CREATE TABLE "MenuCatalog" (
  "id" TEXT PRIMARY KEY,
  "restaurantId" TEXT NOT NULL,
  "revision" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MenuCatalog_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "MenuCatalog_restaurantId_id_key" UNIQUE ("restaurantId", "id"),
  CONSTRAINT "MenuCatalog_restaurantId_revision_key" UNIQUE ("restaurantId", "revision")
);

CREATE INDEX "MenuCatalog_restaurantId_createdAt_idx" ON "MenuCatalog" ("restaurantId", "createdAt");

CREATE TABLE "RecipeVersion" (
  "id" TEXT PRIMARY KEY,
  "restaurantId" TEXT NOT NULL,
  "catalogId" TEXT NOT NULL,
  "stableKey" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "recipe" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RecipeVersion_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "RecipeVersion_catalog_scope_fkey" FOREIGN KEY ("restaurantId", "catalogId") REFERENCES "MenuCatalog"("restaurantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "RecipeVersion_catalogId_stableKey_version_key" UNIQUE ("catalogId", "stableKey", "version"),
  CONSTRAINT "RecipeVersion_version_check" CHECK ("version" > 0)
);

CREATE INDEX "RecipeVersion_restaurantId_stableKey_version_idx" ON "RecipeVersion" ("restaurantId", "stableKey", "version");

CREATE TABLE "MenuSelection" (
  "id" TEXT PRIMARY KEY,
  "restaurantId" TEXT NOT NULL,
  "saveId" TEXT NOT NULL,
  "catalogId" TEXT NOT NULL,
  "businessDay" INTEGER NOT NULL,
  "version" INTEGER NOT NULL,
  "selection" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MenuSelection_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "MenuSelection_save_scope_fkey" FOREIGN KEY ("restaurantId", "saveId") REFERENCES "CompetitiveSave"("restaurantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "MenuSelection_catalog_scope_fkey" FOREIGN KEY ("restaurantId", "catalogId") REFERENCES "MenuCatalog"("restaurantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "MenuSelection_saveId_businessDay_version_key" UNIQUE ("saveId", "businessDay", "version"),
  CONSTRAINT "MenuSelection_day_version_check" CHECK ("businessDay" > 0 AND "version" > 0)
);

CREATE INDEX "MenuSelection_restaurantId_businessDay_idx" ON "MenuSelection" ("restaurantId", "businessDay");

CREATE TABLE "InventoryItem" (
  "id" TEXT PRIMARY KEY,
  "restaurantId" TEXT NOT NULL,
  "stableKey" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "unit" TEXT NOT NULL,
  "perishable" BOOLEAN NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InventoryItem_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "InventoryItem_restaurantId_id_key" UNIQUE ("restaurantId", "id"),
  CONSTRAINT "InventoryItem_restaurantId_stableKey_key" UNIQUE ("restaurantId", "stableKey")
);

CREATE INDEX "InventoryItem_restaurantId_category_idx" ON "InventoryItem" ("restaurantId", "category");

CREATE TABLE "InventoryStock" (
  "id" TEXT PRIMARY KEY,
  "restaurantId" TEXT NOT NULL,
  "saveId" TEXT NOT NULL,
  "inventoryItemId" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "onHand" BIGINT NOT NULL DEFAULT 0,
  "reservedUndelivered" BIGINT NOT NULL DEFAULT 0,
  "capacity" BIGINT NOT NULL,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InventoryStock_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "InventoryStock_save_scope_fkey" FOREIGN KEY ("restaurantId", "saveId") REFERENCES "CompetitiveSave"("restaurantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "InventoryStock_item_scope_fkey" FOREIGN KEY ("restaurantId", "inventoryItemId") REFERENCES "InventoryItem"("restaurantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "InventoryStock_saveId_inventoryItemId_key" UNIQUE ("saveId", "inventoryItemId"),
  CONSTRAINT "InventoryStock_id_version_key" UNIQUE ("id", "version"),
  CONSTRAINT "InventoryStock_restaurantId_saveId_id_key" UNIQUE ("restaurantId", "saveId", "id"),
  CONSTRAINT "InventoryStock_capacity_check" CHECK ("version" > 0 AND "onHand" >= 0 AND "reservedUndelivered" >= 0 AND "capacity" >= 0 AND "onHand" + "reservedUndelivered" <= "capacity")
);

CREATE INDEX "InventoryStock_restaurantId_inventoryItemId_idx" ON "InventoryStock" ("restaurantId", "inventoryItemId");

CREATE TABLE "InventoryTransaction" (
  "id" TEXT PRIMARY KEY,
  "restaurantId" TEXT NOT NULL,
  "saveId" TEXT NOT NULL,
  "stockId" TEXT NOT NULL,
  "transactionId" TEXT NOT NULL,
  "stockVersion" INTEGER NOT NULL,
  "kind" "InventoryTransactionKind" NOT NULL,
  "quantityDelta" BIGINT NOT NULL,
  "onHandAfter" BIGINT NOT NULL,
  "reservedAfter" BIGINT NOT NULL,
  "reason" TEXT NOT NULL,
  "metadata" JSONB,
  "occurredAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InventoryTransaction_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "InventoryTransaction_save_scope_fkey" FOREIGN KEY ("restaurantId", "saveId") REFERENCES "CompetitiveSave"("restaurantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "InventoryTransaction_stock_scope_fkey" FOREIGN KEY ("restaurantId", "saveId", "stockId") REFERENCES "InventoryStock"("restaurantId", "saveId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "InventoryTransaction_restaurantId_transactionId_key" UNIQUE ("restaurantId", "transactionId"),
  CONSTRAINT "InventoryTransaction_stockId_stockVersion_key" UNIQUE ("stockId", "stockVersion"),
  CONSTRAINT "InventoryTransaction_balances_check" CHECK ("stockVersion" > 0 AND "onHandAfter" >= 0 AND "reservedAfter" >= 0)
);

CREATE INDEX "InventoryTransaction_restaurantId_occurredAt_idx" ON "InventoryTransaction" ("restaurantId", "occurredAt");
CREATE INDEX "InventoryTransaction_saveId_occurredAt_idx" ON "InventoryTransaction" ("saveId", "occurredAt");

CREATE TABLE "Order" (
  "id" TEXT PRIMARY KEY,
  "restaurantId" TEXT NOT NULL,
  "saveId" TEXT,
  "branchId" TEXT NOT NULL,
  "tableId" TEXT,
  "businessDay" INTEGER,
  "version" INTEGER NOT NULL DEFAULT 1,
  "type" "OrderType" NOT NULL DEFAULT 'DINE_IN',
  "status" "OrderStatus" NOT NULL DEFAULT 'OPEN',
  "openedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closedAt" TIMESTAMPTZ,
  CONSTRAINT "Order_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Order_save_scope_fkey" FOREIGN KEY ("restaurantId", "saveId") REFERENCES "CompetitiveSave"("restaurantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Order_branch_scope_fkey" FOREIGN KEY ("restaurantId", "branchId") REFERENCES "Branch"("restaurantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Order_table_scope_fkey" FOREIGN KEY ("branchId", "tableId") REFERENCES "Table"("branchId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Order_restaurantId_id_key" UNIQUE ("restaurantId", "id"),
  CONSTRAINT "Order_restaurantId_id_version_key" UNIQUE ("restaurantId", "id", "version"),
  CONSTRAINT "Order_version_day_check" CHECK ("version" > 0 AND ("businessDay" IS NULL OR "businessDay" > 0))
);

CREATE INDEX "Order_restaurantId_businessDay_status_idx" ON "Order" ("restaurantId", "businessDay", "status");
CREATE INDEX "Order_branchId_status_idx" ON "Order" ("branchId", "status");
CREATE INDEX "Order_saveId_businessDay_idx" ON "Order" ("saveId", "businessDay");

CREATE TABLE "OrderItem" (
  "id" TEXT PRIMARY KEY,
  "restaurantId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "menuItemId" TEXT NOT NULL,
  "qty" INTEGER NOT NULL DEFAULT 1,
  "price" DECIMAL(10,2) NOT NULL,
  "notes" TEXT,
  CONSTRAINT "OrderItem_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "OrderItem_order_scope_fkey" FOREIGN KEY ("restaurantId", "orderId") REFERENCES "Order"("restaurantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "OrderItem_menu_item_scope_fkey" FOREIGN KEY ("restaurantId", "menuItemId") REFERENCES "MenuItem"("restaurantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "OrderItem_values_check" CHECK ("qty" > 0 AND "price" >= 0)
);

CREATE INDEX "OrderItem_restaurantId_orderId_idx" ON "OrderItem" ("restaurantId", "orderId");
CREATE INDEX "OrderItem_restaurantId_menuItemId_idx" ON "OrderItem" ("restaurantId", "menuItemId");

CREATE TABLE "Payment" (
  "id" TEXT PRIMARY KEY,
  "orderId" TEXT NOT NULL,
  "method" "PaymentMethod" NOT NULL,
  "amount" DECIMAL(10,2) NOT NULL,
  "paidAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Payment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Payment_amount_check" CHECK ("amount" >= 0)
);

CREATE INDEX "Payment_orderId_paidAt_idx" ON "Payment" ("orderId", "paidAt");

CREATE TABLE "TaxLine" (
  "id" TEXT PRIMARY KEY,
  "orderId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "amount" DECIMAL(10,2) NOT NULL,
  CONSTRAINT "TaxLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "TaxLine_amount_check" CHECK ("amount" >= 0)
);

CREATE INDEX "TaxLine_orderId_idx" ON "TaxLine" ("orderId");

CREATE TABLE "Tip" (
  "id" TEXT PRIMARY KEY,
  "orderId" TEXT NOT NULL,
  "amount" DECIMAL(10,2) NOT NULL,
  CONSTRAINT "Tip_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Tip_amount_check" CHECK ("amount" >= 0)
);

CREATE INDEX "Tip_orderId_idx" ON "Tip" ("orderId");

CREATE TABLE "OrderServiceState" (
  "id" TEXT PRIMARY KEY,
  "restaurantId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "state" TEXT NOT NULL,
  "reason" TEXT,
  "snapshot" JSONB NOT NULL,
  "occurredAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderServiceState_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "OrderServiceState_order_scope_fkey" FOREIGN KEY ("restaurantId", "orderId") REFERENCES "Order"("restaurantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "OrderServiceState_orderId_version_key" UNIQUE ("orderId", "version"),
  CONSTRAINT "OrderServiceState_version_check" CHECK ("version" > 0)
);

CREATE INDEX "OrderServiceState_restaurantId_occurredAt_idx" ON "OrderServiceState" ("restaurantId", "occurredAt");

CREATE TABLE "ReplayEvent" (
  "id" TEXT PRIMARY KEY,
  "restaurantId" TEXT NOT NULL,
  "saveId" TEXT NOT NULL,
  "eventId" TEXT NOT NULL UNIQUE,
  "businessDay" INTEGER NOT NULL,
  "sequence" INTEGER NOT NULL,
  "eventType" TEXT NOT NULL,
  "simulationRuleVersion" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "eventHash" VARCHAR(64) NOT NULL,
  "occurredAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReplayEvent_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ReplayEvent_save_scope_fkey" FOREIGN KEY ("restaurantId", "saveId") REFERENCES "CompetitiveSave"("restaurantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ReplayEvent_saveId_businessDay_sequence_key" UNIQUE ("saveId", "businessDay", "sequence"),
  CONSTRAINT "ReplayEvent_values_check" CHECK ("businessDay" > 0 AND "sequence" >= 0 AND "eventHash" ~ '^[0-9a-f]{64}$')
);

CREATE INDEX "ReplayEvent_restaurantId_businessDay_sequence_idx" ON "ReplayEvent" ("restaurantId", "businessDay", "sequence");

CREATE TABLE "DayEndSnapshot" (
  "id" TEXT PRIMARY KEY,
  "restaurantId" TEXT NOT NULL,
  "saveId" TEXT NOT NULL,
  "businessDay" INTEGER NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "grossRevenueMinor" BIGINT NOT NULL,
  "cogsMinor" BIGINT NOT NULL,
  "wasteLossMinor" BIGINT NOT NULL,
  "payrollMinor" BIGINT NOT NULL,
  "opexMinor" BIGINT NOT NULL,
  "taxMinor" BIGINT NOT NULL,
  "debtDueMinor" BIGINT NOT NULL,
  "riskPenaltyMinor" BIGINT NOT NULL,
  "dailyNetMinor" BIGINT NOT NULL,
  "resolutionComparisonShortfallMinor" BIGINT NOT NULL,
  "shortfallMinor" BIGINT NOT NULL,
  "cashAfterMinor" BIGINT NOT NULL,
  "riskPenaltyRuleVersion" TEXT NOT NULL,
  "riskPenaltyBaseMinor" BIGINT NOT NULL,
  "riskPenaltyRateBps" INTEGER NOT NULL,
  "riskPenaltyRateDenominator" INTEGER NOT NULL,
  "riskPenaltyRoundingMode" TEXT NOT NULL,
  "riskPenaltyMinimumPositiveMinor" BIGINT NOT NULL,
  "riskPenaltyAccruedTotalMinor" BIGINT NOT NULL,
  "reputationPrice" INTEGER NOT NULL,
  "reputationSpeed" INTEGER NOT NULL,
  "reputationQuality" INTEGER NOT NULL,
  "reputationFairness" INTEGER NOT NULL,
  "reputationVibe" INTEGER NOT NULL,
  "riskStatus" "FinancialRiskStatus" NOT NULL,
  "riskTags" JSONB NOT NULL,
  "highRiskRevenueEnabled" BOOLEAN NOT NULL,
  "leaderboardEligible" BOOLEAN NOT NULL,
  "eventHash" VARCHAR(64) NOT NULL,
  "snapshotHash" VARCHAR(64) NOT NULL,
  "finalResourceVersions" JSONB NOT NULL,
  "fixedFieldSnapshot" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DayEndSnapshot_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "DayEndSnapshot_save_scope_fkey" FOREIGN KEY ("restaurantId", "saveId") REFERENCES "CompetitiveSave"("restaurantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "DayEndSnapshot_saveId_businessDay_key" UNIQUE ("saveId", "businessDay"),
  CONSTRAINT "DayEndSnapshot_values_check" CHECK (
    "businessDay" > 0 AND
    "grossRevenueMinor" >= 0 AND "cogsMinor" >= 0 AND "wasteLossMinor" >= 0 AND
    "payrollMinor" >= 0 AND "opexMinor" >= 0 AND "taxMinor" >= 0 AND
    "debtDueMinor" >= 0 AND "riskPenaltyMinor" >= 0 AND
    "resolutionComparisonShortfallMinor" >= 0 AND "shortfallMinor" >= 0 AND
    "riskPenaltyBaseMinor" >= 0 AND "riskPenaltyRateBps" >= 0 AND
    "riskPenaltyRateDenominator" > 0 AND "riskPenaltyMinimumPositiveMinor" > 0 AND
    "riskPenaltyAccruedTotalMinor" >= 0 AND
    "reputationPrice" BETWEEN 0 AND 100 AND "reputationSpeed" BETWEEN 0 AND 100 AND
    "reputationQuality" BETWEEN 0 AND 100 AND "reputationFairness" BETWEEN 0 AND 100 AND
    "reputationVibe" BETWEEN 0 AND 100 AND
    "eventHash" ~ '^[0-9a-f]{64}$' AND "snapshotHash" ~ '^[0-9a-f]{64}$'
  )
);

CREATE INDEX "DayEndSnapshot_restaurantId_businessDay_idx" ON "DayEndSnapshot" ("restaurantId", "businessDay");

CREATE TABLE "RiskState" (
  "id" TEXT PRIMARY KEY,
  "restaurantId" TEXT NOT NULL,
  "saveId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "businessDay" INTEGER NOT NULL,
  "status" "FinancialRiskStatus" NOT NULL,
  "reason" TEXT NOT NULL,
  "precondition" JSONB NOT NULL,
  "postcondition" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RiskState_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "RiskState_save_scope_fkey" FOREIGN KEY ("restaurantId", "saveId") REFERENCES "CompetitiveSave"("restaurantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "RiskState_saveId_version_key" UNIQUE ("saveId", "version"),
  CONSTRAINT "RiskState_values_check" CHECK ("version" > 0 AND "businessDay" > 0)
);

CREATE INDEX "RiskState_restaurantId_businessDay_idx" ON "RiskState" ("restaurantId", "businessDay");

CREATE TABLE "ReputationDimensionHistory" (
  "id" TEXT PRIMARY KEY,
  "restaurantId" TEXT NOT NULL,
  "saveId" TEXT NOT NULL,
  "businessDay" INTEGER NOT NULL,
  "dimension" "ReputationDimension" NOT NULL,
  "version" INTEGER NOT NULL,
  "score" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReputationDimensionHistory_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ReputationDimensionHistory_save_scope_fkey" FOREIGN KEY ("restaurantId", "saveId") REFERENCES "CompetitiveSave"("restaurantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ReputationDimensionHistory_save_day_dimension_version_key" UNIQUE ("saveId", "businessDay", "dimension", "version"),
  CONSTRAINT "ReputationDimensionHistory_values_check" CHECK ("businessDay" > 0 AND "version" > 0 AND "score" BETWEEN 0 AND 100)
);

CREATE INDEX "ReputationDimensionHistory_restaurantId_businessDay_idx" ON "ReputationDimensionHistory" ("restaurantId", "businessDay");

CREATE TABLE "Loan" (
  "id" TEXT PRIMARY KEY,
  "restaurantId" TEXT NOT NULL,
  "saveId" TEXT NOT NULL,
  "stableKey" TEXT NOT NULL,
  "termsVersion" INTEGER NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "principalMinor" BIGINT NOT NULL,
  "interestRateBps" INTEGER NOT NULL,
  "lateFeeBps" INTEGER NOT NULL,
  "graceBusinessDays" INTEGER NOT NULL,
  "termsSnapshot" JSONB NOT NULL,
  "replacesLoanId" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Loan_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Loan_save_scope_fkey" FOREIGN KEY ("restaurantId", "saveId") REFERENCES "CompetitiveSave"("restaurantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Loan_replaces_scope_fkey" FOREIGN KEY ("restaurantId", "saveId", "replacesLoanId") REFERENCES "Loan"("restaurantId", "saveId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Loan_saveId_stableKey_termsVersion_key" UNIQUE ("saveId", "stableKey", "termsVersion"),
  CONSTRAINT "Loan_restaurantId_saveId_id_key" UNIQUE ("restaurantId", "saveId", "id"),
  CONSTRAINT "Loan_restaurantId_id_key" UNIQUE ("restaurantId", "id"),
  CONSTRAINT "Loan_values_check" CHECK ("termsVersion" > 0 AND "principalMinor" >= 0 AND "interestRateBps" >= 0 AND "lateFeeBps" >= 0 AND "graceBusinessDays" >= 0)
);

CREATE INDEX "Loan_restaurantId_createdAt_idx" ON "Loan" ("restaurantId", "createdAt");

CREATE TABLE "LoanInstallment" (
  "id" TEXT PRIMARY KEY,
  "restaurantId" TEXT NOT NULL,
  "loanId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "dueBusinessDay" INTEGER NOT NULL,
  "principalMinor" BIGINT NOT NULL,
  "interestMinor" BIGINT NOT NULL,
  "totalMinor" BIGINT NOT NULL,
  "status" TEXT NOT NULL,
  "snapshot" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LoanInstallment_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "LoanInstallment_loan_scope_fkey" FOREIGN KEY ("restaurantId", "loanId") REFERENCES "Loan"("restaurantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "LoanInstallment_loanId_sequence_key" UNIQUE ("loanId", "sequence"),
  CONSTRAINT "LoanInstallment_values_check" CHECK ("sequence" > 0 AND "dueBusinessDay" > 0 AND "principalMinor" >= 0 AND "interestMinor" >= 0 AND "totalMinor" = "principalMinor" + "interestMinor")
);

CREATE INDEX "LoanInstallment_restaurantId_dueBusinessDay_idx" ON "LoanInstallment" ("restaurantId", "dueBusinessDay");

CREATE TABLE "IdempotencyRecord" (
  "id" TEXT PRIMARY KEY,
  "restaurantId" TEXT,
  "playerId" TEXT,
  "actorScope" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestFingerprint" VARCHAR(64) NOT NULL,
  "status" TEXT NOT NULL,
  "aggregateType" TEXT,
  "aggregateId" TEXT,
  "responseSnapshot" JSONB,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "terminalAt" TIMESTAMPTZ,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "IdempotencyRecord_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "IdempotencyRecord_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "IdempotencyRecord_actorScope_idempotencyKey_key" UNIQUE ("actorScope", "idempotencyKey"),
  CONSTRAINT "IdempotencyRecord_fingerprint_check" CHECK ("requestFingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "IdempotencyRecord_retention_check" CHECK ("expiresAt" >= COALESCE("terminalAt", "createdAt") + INTERVAL '30 days')
);

CREATE INDEX "IdempotencyRecord_restaurantId_createdAt_idx" ON "IdempotencyRecord" ("restaurantId", "createdAt");
CREATE INDEX "IdempotencyRecord_playerId_createdAt_idx" ON "IdempotencyRecord" ("playerId", "createdAt");
CREATE INDEX "IdempotencyRecord_expiresAt_idx" ON "IdempotencyRecord" ("expiresAt");

-- Historical rows are append-only. Corrections are represented by replacement,
-- compensation, or later version records rather than UPDATE/DELETE.
CREATE FUNCTION d01_reject_history_mutation() RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; write a replacement or compensating record', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;

CREATE FUNCTION d01_lock_competitive_save_fields() RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."restaurantId" IS DISTINCT FROM OLD."restaurantId"
     OR NEW."ownerPlayerId" IS DISTINCT FROM OLD."ownerPlayerId"
     OR NEW."mode" IS DISTINCT FROM OLD."mode"
     OR NEW."openingScenario" IS DISTINCT FROM OLD."openingScenario"
     OR NEW."operatingMode" IS DISTINCT FROM OLD."operatingMode"
     OR NEW."servicePeriodPlan" IS DISTINCT FROM OLD."servicePeriodPlan"
     OR NEW."difficultyGroup" IS DISTINCT FROM OLD."difficultyGroup"
     OR NEW."demandSeed" IS DISTINCT FROM OLD."demandSeed"
     OR NEW."simulationRuleVersion" IS DISTINCT FROM OLD."simulationRuleVersion"
     OR NEW."openingSnapshot" IS DISTINCT FROM OLD."openingSnapshot"
     OR NEW."openingSnapshotHash" IS DISTINCT FROM OLD."openingSnapshotHash" THEN
    RAISE EXCEPTION 'competitive save creation fields are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "CompetitiveSave_lock_creation_fields"
BEFORE UPDATE ON "CompetitiveSave"
FOR EACH ROW EXECUTE FUNCTION d01_lock_competitive_save_fields();

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'AuditLog', 'WageContract', 'EmployeeShift', 'RecipeVersion',
    'InventoryTransaction', 'OrderServiceState', 'ReplayEvent',
    'DayEndSnapshot', 'RiskState', 'ReputationDimensionHistory',
    'Loan', 'LoanInstallment'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION d01_reject_history_mutation()',
      table_name || '_append_only', table_name
    );
  END LOOP;
END;
$$;

-- Membership-derived subject. Empty or absent context fails closed. The value
-- is supplied by the trusted Supabase/PostgREST JWT bridge, never by request
-- bodies or client-provided tenant/actor IDs.
CREATE FUNCTION d01_clerk_subject() RETURNS TEXT
LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', TRUE), '')
$$;

CREATE FUNCTION d01_is_restaurant_member(target_restaurant_id TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM "RestaurantMembership" membership
    JOIN "Player" player ON player."id" = membership."playerId"
    WHERE membership."restaurantId" = target_restaurant_id
      AND membership."revokedAt" IS NULL
      AND player."clerkUserId" = d01_clerk_subject()
  )
$$;

REVOKE ALL ON FUNCTION d01_is_restaurant_member(TEXT) FROM PUBLIC;

-- Every P0 table uses FORCE RLS so ordinary owners cannot accidentally bypass
-- policies. Supabase service_role/BYPASSRLS remains the API/worker boundary.
DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'Player', 'IdentityLink', 'Restaurant', 'RestaurantMembership', 'AuditLog',
    'WipeBatch', 'CompetitiveSave', 'Branch', 'Table', 'MenuItem', 'Employee',
    'WageContract', 'EmployeeShift', 'MenuCatalog', 'RecipeVersion',
    'MenuSelection', 'InventoryItem', 'InventoryStock', 'InventoryTransaction',
    'Order', 'OrderItem', 'Payment', 'TaxLine', 'Tip', 'OrderServiceState',
    'ReplayEvent', 'DayEndSnapshot', 'RiskState', 'ReputationDimensionHistory',
    'Loan', 'LoanInstallment', 'IdempotencyRecord'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC', table_name);
  END LOOP;
END;
$$;

CREATE POLICY "Player_select_self" ON "Player"
FOR SELECT TO authenticated USING ("clerkUserId" = d01_clerk_subject());

CREATE POLICY "IdentityLink_select_self" ON "IdentityLink"
FOR SELECT TO authenticated USING ("clerkUserId" = d01_clerk_subject());

CREATE POLICY "Restaurant_select_member" ON "Restaurant"
FOR SELECT TO authenticated USING (d01_is_restaurant_member("id"));

CREATE POLICY "RestaurantMembership_select_member" ON "RestaurantMembership"
FOR SELECT TO authenticated USING (d01_is_restaurant_member("restaurantId"));

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'CompetitiveSave', 'Branch', 'Employee', 'WageContract', 'EmployeeShift',
    'MenuCatalog', 'RecipeVersion', 'MenuSelection', 'InventoryItem',
    'InventoryStock', 'InventoryTransaction', 'Order', 'OrderServiceState',
    'ReplayEvent', 'DayEndSnapshot', 'RiskState', 'ReputationDimensionHistory',
    'Loan', 'LoanInstallment'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (d01_is_restaurant_member("restaurantId"))',
      table_name || '_select_member', table_name
    );
  END LOOP;
END;
$$;

-- Derived-scope legacy children remain readable only when their parent order,
-- branch, or menu row is visible under the same membership context.
CREATE POLICY "Table_select_member" ON "Table" FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM "Branch" branch WHERE branch."id" = "Table"."branchId")
);
CREATE POLICY "MenuItem_select_member" ON "MenuItem" FOR SELECT TO authenticated
USING (d01_is_restaurant_member("restaurantId"));
CREATE POLICY "OrderItem_select_member" ON "OrderItem" FOR SELECT TO authenticated
USING (d01_is_restaurant_member("restaurantId"));
CREATE POLICY "Payment_select_member" ON "Payment" FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM "Order" parent_order WHERE parent_order."id" = "Payment"."orderId")
);
CREATE POLICY "TaxLine_select_member" ON "TaxLine" FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM "Order" parent_order WHERE parent_order."id" = "TaxLine"."orderId")
);
CREATE POLICY "Tip_select_member" ON "Tip" FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM "Order" parent_order WHERE parent_order."id" = "Tip"."orderId")
);

-- Audit, wipe governance, and idempotency internals intentionally have no
-- authenticated-client policy. No INSERT/UPDATE/DELETE policy exists anywhere.
DO $$
DECLARE
  table_name TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    FOREACH table_name IN ARRAY ARRAY[
      'Player', 'IdentityLink', 'Restaurant', 'RestaurantMembership', 'AuditLog',
      'WipeBatch', 'CompetitiveSave', 'Branch', 'Table', 'MenuItem', 'Employee',
      'WageContract', 'EmployeeShift', 'MenuCatalog', 'RecipeVersion',
      'MenuSelection', 'InventoryItem', 'InventoryStock', 'InventoryTransaction',
      'Order', 'OrderItem', 'Payment', 'TaxLine', 'Tip', 'OrderServiceState',
      'ReplayEvent', 'DayEndSnapshot', 'RiskState', 'ReputationDimensionHistory',
      'Loan', 'LoanInstallment', 'IdempotencyRecord'
    ] LOOP
      EXECUTE format('REVOKE ALL ON TABLE %I FROM anon', table_name);
    END LOOP;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    FOREACH table_name IN ARRAY ARRAY[
      'Player', 'IdentityLink', 'Restaurant', 'RestaurantMembership',
      'CompetitiveSave', 'Branch', 'Table', 'MenuItem', 'Employee',
      'WageContract', 'EmployeeShift', 'MenuCatalog', 'RecipeVersion',
      'MenuSelection', 'InventoryItem', 'InventoryStock', 'InventoryTransaction',
      'Order', 'OrderItem', 'Payment', 'TaxLine', 'Tip', 'OrderServiceState',
      'ReplayEvent', 'DayEndSnapshot', 'RiskState', 'ReputationDimensionHistory',
      'Loan', 'LoanInstallment'
    ] LOOP
      EXECUTE format('GRANT SELECT ON TABLE %I TO authenticated', table_name);
    END LOOP;
    GRANT EXECUTE ON FUNCTION d01_is_restaurant_member(TEXT) TO authenticated;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    FOREACH table_name IN ARRAY ARRAY[
      'Player', 'IdentityLink', 'Restaurant', 'RestaurantMembership', 'AuditLog',
      'WipeBatch', 'CompetitiveSave', 'Branch', 'Table', 'MenuItem', 'Employee',
      'WageContract', 'EmployeeShift', 'MenuCatalog', 'RecipeVersion',
      'MenuSelection', 'InventoryItem', 'InventoryStock', 'InventoryTransaction',
      'Order', 'OrderItem', 'Payment', 'TaxLine', 'Tip', 'OrderServiceState',
      'ReplayEvent', 'DayEndSnapshot', 'RiskState', 'ReputationDimensionHistory',
      'Loan', 'LoanInstallment', 'IdempotencyRecord'
    ] LOOP
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO service_role', table_name);
    END LOOP;
    GRANT EXECUTE ON FUNCTION d01_is_restaurant_member(TEXT) TO service_role;
  END IF;
END;
$$;
