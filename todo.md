# 開發計畫 Roadmap（Restaurant Tycoon）

本文件彙整短/中/長期開發規劃、技術選型、里程碑與驗收標準，並對應容器化開發環境。參考既有專案 maii-bot 的工程慣例（Node、Docker Compose、K8s 清單、ESLint/Prettier），新專案在此基礎上以 TypeScript、Fastify、Prisma、BullMQ 進一步實作。

---

## 0. 工程基礎與慣例（對齊 maii-bot）
- Node 版本: 導入 `.nvmrc`（Node 20）
- 稽核工具: ESLint + Prettier（與 maii-bot 類似配置，TS 版）
- Git 規範: Conventional Commits、自動生成 CHANGELOG
- CI/CD: GitHub Actions（Lint、Build、基本測試、Docker 影像推送）
- 容器與本地: `docker-compose.yml` 啟動 Postgres/Redis/API/Worker/Frontend；提供 dev profile 支援熱更新
- K8s（中期）: 參考 maii-bot 的 `k8s/` 結構，加入部署與環境變數範本
- 設定檔: `.env`（本地）、`secrets`（部署）、dotenv 加載

---

## 1. 需求輪廓與系統邏輯（餐飲導向）
- 分層職能（前/中/後段）：
  - 前台（FOH）：訂位、帶位、桌位/客數、點餐（內用/外帶/外送）、帳單拆併單、折扣/稅/服務費、收款與小費
  - 中台（MOH/廚房）：菜單與配方、出餐節點（工位/站點）、Kitchen Display System（KDS）、出餐優先序與叫號、備料/工序
  - 後台（BOH/供應）：供應商/採購、入庫與驗收、庫存批次與保存期限、報廢/盤點、成本/毛利、補貨規則與交期
- 技術基礎：Redis（快取/佇列）+ PostgreSQL（權威儲存）
- i18n 與多國：多語（UI/訊息）、稅別（VAT/GST/營業稅）、貨幣與四捨五入、時區與營業時段
- 經營循環：餐廳/分店建立 → 設定菜單/價格/配方 → 進貨/備料 → 點餐/製作/出餐 → 結帳/小費 → 日結/盤點/補貨

---

## 2. 資料模型（餐飲初稿）
- 相容性（不影響現況）：保留現有 `Player` 作為「老闆/公司」；會計雙分錄 `Account/Ledger*` 沿用
- 會計與稅：`Account(AccountType)`, `LedgerEntry/Line`, `TaxRule`, `ServiceCharge`, `Tip`
- 門店/人員/營業：
  - `Restaurant { name, timezone }`, `Branch { restaurantId, address, hours }`
  - `Table { branchId, code, seats, status }`, `Reservation { tableId?, guestName, partySize, timeslot }`
  - `Staff { name, role }`, `Shift { branchId, startsAt, endsAt }`, `StaffAssignment { staffId, shiftId, station? }`
- 菜單/配方/修飾：
  - `MenuCategory`, `MenuItem { sku, name, basePrice, active }`, `MenuPrice { menuItemId, timeOfDay, price }`
  - `ModifierGroup { name, min,max }`, `ModifierOption { name, priceDelta }`
  - `Recipe { menuItemId, yieldQty }`, `RecipeComponent { recipeId, ingredientId, qty, unit }`
- 庫存/採購：
  - `Ingredient { name, unit, perishability, sku? }`, `Vendor { name, leadTimeDays }`
  - `PurchaseOrder { vendorId, branchId, eta }`, `PurchaseOrderLine { ingredientId, qty, price }`
  - `GoodsReceipt { poId }`, `InventoryLot { ingredientId, qty, unitCost, receivedAt, expiresAt? }`
  - `StockMovement { type(purchase/issue/spoilage/transfer), lotId?, ingredientId, qty, ref }`
  - `ReorderRule { ingredientId, minQty, targetQty, safetyDays }`
- 點餐/結帳：
  - `Order { branchId, tableId?, type(dine-in/takeout/delivery), status }`
  - `OrderItem { orderId, menuItemId, qty, price }`, `OrderModifier { orderItemId, optionId, priceDelta }`
  - `KitchenTicket { orderId, status, station }`, `TicketItem { menuItemId, qty, notes }`
  - `Payment { orderId, method(cash/card), amount }`, `TaxLine`, `ServiceCharge`, `Tip`

---

## 3. 服務與模組（餐飲場景）
- API（Fastify + Prisma）
  - FOH：餐廳/桌位/訂位、建立訂單、加菜/備註/修飾、拆併單、折扣/服務費/小費、結帳
  - MOH（KDS）：拉單/出餐/退菜、站點/工位佇列、優先序
  - BOH：供應商/採購單/驗收、庫存批次/報廢/轉移、配方/成本試算、補貨建議
  - 安全：JWT/Session、Rate Limit、Idempotency-Key（結帳/入庫）、權限（職務/門店）
  - i18n：code-based 訊息，字典對應（`en/zh`）
- Worker（BullMQ）
  - 日結：結算銷售、COGS、服務費/小費分攤，關帳憑證寫入 `Ledger*`
  - 庫存：配方耗用出庫、保鮮期/報廢、盤點差異調整
  - 採購：補貨規則運算 → 產生建議 PO；交期模擬與到貨扣帳
  - 成本：配方成本回溯/滾動平均、毛利報表快取
- 快取（Redis）
  - KDS 佇列/訂單狀態、熱門品項、門店看板；TTL/失效策略

---

## 4. 前端（Next.js, i18n）
- 語系：`en/zh` 起步，金額/稅/小費格式化
- 模組頁面：
  - FOH POS：桌位/訂位、點餐（修飾/加料）、拆併單、結帳收銀（含小費）
  - KDS：站點佇列/叫號、出餐/退菜、優先序
  - 庫存/採購：品項、批次/到期、補貨建議、採購單/驗收
  - 菜單/配方：品項、修飾、時段價、配方與成本
  - 儀表板：銷售/毛利、耗用與報廢、補貨 KPI

---

## 5. 測試與觀測
- 測試
  - 單元（經濟演算、撮合、會計平衡）
  - 整合（API + DB + Redis，以 Testcontainers 或 docker-compose profile）
  - 場景回放（固定種子/事件腳本）
- 觀測
  - 日誌（結構化 pino）、追蹤（可選 OpenTelemetry）、指標（Prometheus/Grafana）
  - 關鍵 KPI：撮合延遲、tick 用時、佇列深度、DB QPS、Cache 命中率

---

## 6. 安全與合規
- Rate limiting、輸入驗證（Zod/Valibot）
- Idempotency（金融/下單接口必須）
- 權限與審批（組織/公會/企業）
- 反作弊/異常偵測（資金流異常、價格操縱、刷量）
- 稽核與追溯：Event Sourcing + Snapshot（中期）

---

## 7. 里程碑與驗收標準

### 里程碑 A（0–3 週）餐飲 MVP（優先 P0）
- DB：Prisma 新增餐飲最小實體（Restaurant/Branch/Table/MenuItem/Order/OrderItem/Payment/TaxLine/Tip）於 `schema=dev`
- API：POS 最小流程（開單/加菜/結帳）+ KDS 拉單/出餐
- Worker：日結（Sales/COGS/Tip/ServiceCharge 憑證）
- 前端：簡易 POS 與 KDS 原型、i18n 切換
- 驗收：一組內用點餐→出餐→結帳→日結→帳務平衡

### 里程碑 B（3–6 週）庫存與採購
- DB：Ingredient/Vendor/PO/GoodsReceipt/InventoryLot/StockMovement/Recipe/RecipeComponent
- API：採購/驗收、出庫（配方耗用/報廢）、補貨建議
- Worker：保鮮期/報廢、補貨排程、配方成本滾動
- 前端：庫存/採購/配方管理 UI
- 驗收：依菜單出貨耗料、到期自動報廢、補貨建議可生成草稿 PO

### 里程碑 C（6–12 週）拓展與報表
- 多分店/時段價/修飾、拆併單
- 角色/權限、審計日誌、觀測面板
- 報表：銷售/毛利、庫存周轉、員工績效（基礎）

---

## 8. 工作分解（可指派的 TODO，已餐飲化）

### 基礎設置
- [x] 新增 `.nvmrc`（Node 20）
 - [x] 新增 ESLint/Prettier（TS 設定），對齊 maii-bot 風格
 - [x] GitHub Actions：Lint/Build/測試 + Docker build
- [x] docker-compose dev profile（API/Worker 源碼熱更新）

### P0（立即優先，避免阻塞）
- [ ] Prisma schema（dev schema）新增最小餐飲實體：Restaurant/Branch/Table/MenuItem/Order/OrderItem/Payment/TaxLine/Tip（不移除既有 `Player/Account/*`）
- [ ] API 路由（最小）：開單 POST /orders、加菜 POST /orders/:id/items、結帳 POST /orders/:id/payments、KDS：/kds/tickets 拉單/出餐
- [ ] 前端原型：POS（開單/加菜/結帳）與 KDS 清單頁
- [ ] i18n 文案：新增餐飲相關字串鍵（不破壞既有鍵）
- [ ] 日結 Worker：聚合銷售/小費/服務費與 COGS，寫入 `Ledger*`

### 資料庫與模型（餐飲）
- [ ] Ingredient/Vendor/PO/GoodsReceipt/InventoryLot/StockMovement/Recipe/RecipeComponent
- [ ] ReorderRule（安全存量/補貨天數）
- [ ] MenuPrice（時段價）、ModifierGroup/Option（修飾/加料）

### API（餐飲）
- [ ] POS：桌位/帶位、開單/加菜/拆併單、折扣/服務費、小費、結帳
- [ ] KDS：站點佇列、出餐/退菜/優先序
- [ ] 採購/庫存：PO/驗收、出庫（配方耗用/報廢/轉移）
- [ ] i18n 錯誤碼與前端字典對應
- [ ] 安全：Rate limit、Idempotency-Key（結帳/入庫）

### Worker（餐飲）
- [ ] 日結：Sales/COGS/ServiceCharge/Tip 憑證
- [ ] 庫存：保鮮期/報廢、配方耗用出庫、盤點差異
- [ ] 補貨：規則運算與建議 PO 產生

### 前端（餐飲）
- [ ] POS：桌位/點餐/結帳（MVP）
- [ ] KDS：出餐佇列（MVP）
- [ ] 庫存/採購：品項/批次/驗收（V2）
- [ ] 菜單/配方：時段價/修飾/配方（V2）

### 觀測與維運
- [ ] Pino 日誌結構化輸出，請求追蹤 ID
- [ ] 指標：BullMQ 佇列深度、Tick 用時、DB/Redis 指標
- [ ] 健康檢查、Readiness、Liveness（K8s）

### 風控與稽核
- [ ] 反作弊檢測（異常交易/資金流）
- [ ] Event Sourcing + Snapshot 設計（中期）

---

## 9. 風險與緩解
- 模型轉向風險 → 優先以 dev schema 新增餐飲實體，保留舊模型以相容，逐步遷移
- 結帳/帳務正確性 → 單元測試覆蓋稅/折扣/服務費/小費與雙分錄平衡
- 庫存複雜度 → 先支持批次/報廢/出庫，後續再加盤點/轉移/多倉
- i18n 成本 → 統一字串鍵，落入字典維護流程

---

## 10. 驗證與上線清單
- [ ] 可重現本地環境（`docker compose up`）
- [ ] DB schema 版本化與遷移（Prisma）
- [ ] 基準場景測試（POS 點餐→KDS→結帳→日結；庫存耗用/報廢）
- [ ] 監控儀表板最小集合到位
- [ ] 安全掃描（依賴/容器）

---

## 附註
- 現有腳手架：`econ-game/` 已包含 API/Worker/Frontend、Postgres、Redis 與文件
- 與現況相容策略：短期在 `schema=dev` 新增/演進餐飲模型，待穩定後再考慮清理歷史模型或改名（例如將 `Player` 更名為 `Owner/Company`）
