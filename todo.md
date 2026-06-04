# 開發計畫 Roadmap（Godot-first 產業鏈經濟遊戲）

本專案方向以 Godot/Steam 主遊戲優先，Discord BOT 作為 companion app，Web 則定位為開發與管理工具。餐飲是第一個切入經濟與供應鏈模擬的產業入口：先由 NPC 供應商支撐採購與庫存循環，再逐步加入價格波動、玩家市場與可遊玩的產業鏈角色。

---

## 0. 工程基礎與慣例
- Node 版本: 導入 `.nvmrc`（Node 20）
- 稽核工具: ESLint + Prettier（與 maii-bot 類似配置，TS 版）
- Git 規範: Conventional Commits、自動生成 CHANGELOG
- CI/CD: GitHub Actions（Lint、Build、基本測試、Docker 影像推送）
- 容器與本地: `docker-compose.yml` 啟動 Postgres/Redis/API/Worker/Frontend；提供 dev profile 支援熱更新
- K8s（中期）: 參考 maii-bot 的 `k8s/` 結構，加入部署與環境變數範本
- 設定檔: `.env`（本地）、`secrets`（部署）、dotenv 加載
- 共享套件: `packages/game-core`、`packages/content`、`packages/shared` 分離規則、內容與共用型別/工具

---

## 1. 需求輪廓與系統邏輯（餐飲作為第一產業入口）
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
  - `ModifierGroup { name, min, max }`, `ModifierOption { name, priceDelta }`
  - `Recipe { menuItemId, yieldQty }`, `RecipeComponent { recipeId, ingredientId, qty, unit }`
- 庫存/採購：
  - `Ingredient { name, unit, perishability, sku? }`, `Vendor { name, leadTimeDays }`
  - `PurchaseOrder { vendorId, branchId, eta }`, `PurchaseOrderLine { ingredientId, qty, price }`
  - `GoodsReceipt { poId }`, `InventoryLot { ingredientId, qty, unitCost, receivedAt, expiresAt? }`
  - `StockMovement { type(purchase/issue/spoilage/transfer), lotId?, ingredientId, qty, ref }`
  - `ReorderRule { ingredientId, minQty, targetQty, safetyDays }`
- 小遊戲 / 玩家：
  - `GameSession { id, playerId, type(nanb), score, duration, playedAt }`
  - `LeaderboardEntry { period(daily/weekly/monthly), startsAt, endsAt, playerId, score, rank }`
  - `RewardBundle { id, name, period?, pointsRequired, payload(json) }`
  - `PlayerReward { playerId, rewardId, grantedAt, claimedAt?, status }`
- 點餐/結帳：
  - `Order { branchId, tableId?, type(dine-in/takeout/delivery), status }`
  - `OrderItem { orderId, menuItemId, qty, price }`, `OrderModifier { orderItemId, optionId, priceDelta }`
  - `KitchenTicket { orderId, status, station }`, `TicketItem { menuItemId, qty, notes }`
  - `Payment { orderId, method(cash/card), amount }`, `TaxLine`, `ServiceCharge`, `Tip`

---

## 3. 服務、客戶端與模組定位
- Godot（Steam 主遊戲）
  - 2D management UI，承載玩家主要操作與遊戲節奏
  - 採購、菜單決策、自動營業、日結、解鎖與成長循環
  - 本地存檔永遠可用，雲端同步與 Discord 連動作為選配能力
- API（Fastify + Prisma）
  - 持久化、同步、身分連結、Godot/BOT API
  - Route handlers 不擁有核心規則；經濟、庫存、日結等規則移至 `packages/game-core`
  - 安全：JWT/Session、Rate Limit、Idempotency-Key（結帳/入庫）、權限與 i18n code-based 訊息
- Worker（BullMQ）
  - 日結、供應商價格/缺貨/交期/補貨 jobs
  - 排行榜、活動、獎勵與 Discord notification queue
- Bot（Discord Companion）
  - Companion MVP 指令：`/status`、`/daily`、`/inventory low`、`/supplier deals`、`/restock`、`/leaderboard`；`/event join` 留到 C 期社群活動
  - 推播通知：日結、低庫存、供應商特價/缺貨、活動與獎勵提醒
  - 不承載完整 POS/KDS/配方/建造/地圖/市場/全產業鏈 UI
- Frontend（Next.js）
  - 管理後台與開發工具，用於內容、營運、除錯、Demo bootstrap 與內部測試
  - POS/KDS 僅作為內部測試工具，不是主要玩家入口
- Shared packages
  - `packages/game-core`：經濟規則、供應鏈演算、日結與可重放 deterministic logic
  - `packages/content`：產業、食材、供應商、事件、解鎖與平衡資料
  - `packages/shared`：共用型別、Zod schema、API contract、i18n keys 與工具函式

---

## 4. 客戶端與管理工具（Godot + Next.js）
- Godot 主客戶端（Steam-first）：
  - 2D management prototype：餐廳狀態、庫存摘要、供應商報價、菜單/價格決策、自動營業與日結結果
  - 本地存檔：離線可玩、可重開讀取、日結與解鎖狀態保存在 local save；雲端同步與 Discord linking 為選配
  - 共享規則：透過 `packages/game-core` 匯出的 deterministic core loop 驅動採購、消耗、收入、COGS、日結與解鎖
  - UI 邊界：完整玩家體驗在 Godot；Web 與 Bot 不替代主遊戲操作
- Frontend（Next.js admin/dev tooling）：
  - Next 14（Pages Router）+ TypeScript；用於內容管理、營運後台、除錯、Demo bootstrap、內部測試與觀測入口
  - UI：Tailwind + Headless UI 或 Radix；建立共用 Layout、Top Nav、狀態提示（Toast/Modal）
  - 資料層：自訂 API 客戶端（fetch + Zod）與 React Query（或 SWR）管理快取；錯誤統一處理
  - i18n：Next Intl（或 next-translate）維護 `en/zh`，金額/時區格式化，權限字串同步
- 管理/測試模組藍圖（依里程碑）：
  - 里程碑 A（MVP）
    - Admin dashboard：玩家/餐廳檢視、經濟狀態摘要、手動觸發日結、健康狀態橫幅、Demo Bootstrap CTA（前端整合待做；API 端點已完成）
    - Content tooling：食材、供應商、菜單與事件資料的讀取/檢視，對應 `packages/content`
    - POS/KDS prototype：保留桌位地圖、開單、點餐、票單狀態切換等頁面作為內部測試工具
  - 里程碑 B（庫存/採購）
    - 庫存：Ingredient 列表、低庫存提醒、批次詳情、Lot 進出紀錄
    - 採購：PO 清單、草稿編輯、收貨驗收、成本統計摘要
    - 菜單/配方：Modifier/Option 編輯、Recipe + 成本試算、時段價設定
  - 里程碑 C（拓展/報表）
    - 多門店切換、班表/權限 UI、報表儀表板（銷售/毛利/庫存周轉）
    - POS/KDS 內部測試頁延伸：拆併單、KDS 壓力測試、行動版檢查；仍不是主要玩家入口
    - Mini-game：跨餐廳排行榜、邀請賽/活動、成就徽章展示與分享
- 體驗與維運：
  - 無障礙（WCAG AA）、鍵盤導覽
  - Storybook 元件庫（或 Ladle）、Chromatic 快照
  - E2E：Playwright/Cypress 覆蓋 admin/dev tooling 與 POS/KDS 內部測試關鍵路徑，整合 GitHub Actions
  - 監測：前端 Sentry、性能指標（Web Vitals）上報、版本標記

---

## 5. 測試與觀測
- 測試
  - 單元（`game-core` 經濟演算、供應鏈消耗、日結、會計平衡）
  - Godot runtime（本地存檔、重開讀取、核心循環結果與 `game-core` fixture 對齊）
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

### 里程碑 A（0–3 週）Godot-first 餐飲經濟原型（優先 P0）
- Godot：2D management prototype（採購、菜單/價格決策、自動營業、日結、解鎖）與本地存檔
- Shared packages：建立 `packages/game-core`、`packages/content`、`packages/shared`，將核心經濟/供應鏈規則、內容資料與 API contract 分離
- DB/API：Prisma 最小餐飲實體沿用 Restaurant/Branch/Table/MenuItem/Order/OrderItem/Payment/TaxLine/Tip（保留 `Player/Account/*`）於 `schema=dev`；另加入支撐 core loop 的最小 `Ingredient/Vendor/Inventory` foundation（簡化食材、NPC 供應商、庫存餘量），完整 PO/GoodsReceipt/InventoryLot/StockMovement/Recipe/ReorderRule 留給里程碑 B
- Worker：日結（Sales/COGS/Tip/ServiceCharge 憑證），以及基於最小供應商資料的簡易 supplier deal/shortage tick 與低庫存通知 queue；完整供應商價格/交期/補貨系統留給里程碑 B
- Bot Companion：`/status`、`/daily`、`/inventory low`、`/supplier deals`、`/restock`、`/leaderboard` MVP 與通知 channel；A 期 `/leaderboard` 僅讀取既有/簡單分數摘要，深度排行榜結算與獎勵留給 B 期
- Frontend：admin/dev tooling（Demo bootstrap、內容檢視、健康狀態、POS/KDS 內部測試原型、i18n 切換）
- 驗收：Godot 可完成一輪採購→自動營業→日結→庫存/現金/帳務更新→本地存檔重開；API/Worker/BOT 可同步與通知同一輪結果；POS/KDS 僅作內部測試輔助

### 里程碑 B（3–6 週）庫存與採購
- DB：完整供應商/採購/庫存擴充（PO/GoodsReceipt/InventoryLot/StockMovement/Recipe/RecipeComponent，必要時擴充 Ingredient/Vendor 欄位）
- API：採購/驗收、出庫（配方耗用/報廢）、補貨建議
- Worker：保鮮期/報廢、補貨排程、配方成本滾動
- 前端：庫存/採購/配方管理 UI
- Mini-game：後端週/月結算、獎勵派發/兌換、基礎排行榜詳情與 Discord 公告整合
- 驗收：依菜單出貨耗料、到期自動報廢、補貨建議可生成草稿 PO

### 里程碑 C（6–12 週）拓展與報表
- 多分店/時段價/修飾、拆併單
- 角色/權限、審計日誌、觀測面板
- 報表：銷售/毛利、庫存周轉、員工績效（基礎）
- Mini-game：跨伺服器/社群競賽、活動賽季、成就徽章、分享與社群互動擴充

---

## 8. 工作分解（Godot-first foundation，可指派的 TODO）

### 基礎設置
- [x] 新增 `.nvmrc`（Node 20）
- [x] 新增 ESLint/Prettier（TS 設定），對齊 maii-bot 風格
- [x] GitHub Actions：Lint/Build/測試 + Docker build
- [x] docker-compose dev profile（API/Worker 源碼熱更新）

### P0（Godot-first foundation，避免阻塞）

#### P0 剩餘阻塞
- [ ] Monorepo packages：建立 `packages/game-core`、`packages/content`、`packages/shared`，並設定 lint/build/test pipeline
- [ ] `game-core`：採購、菜單/價格、自動營業、庫存消耗、收入/COGS、日結、解鎖的 deterministic core loop
- [ ] `content`：餐飲第一產業入口資料（食材、NPC 供應商、菜單、事件、初始平衡參數）
- [ ] `shared`：Godot/BOT/API 共用型別、Zod schema、API contract、i18n keys
- [ ] Godot prototype：2D management UI、本地存檔、採購→自動營業→日結→解鎖一輪 playable loop
- [ ] API endpoints：Godot 狀態讀寫、日結提交/查詢、補貨/供應商 deals、Discord linking；route handlers 只調用 `game-core`
- [ ] Worker：聚合銷售/小費/服務費與 COGS，寫入 `Ledger*`；以最小 `Vendor` 資料跑簡易 supplier deal/shortage tick 與通知 queue（完整價格/交期/補貨排程屬里程碑 B）
- [ ] Bot Companion MVP：`/status`、`/daily`、`/inventory low`、`/supplier deals`、`/restock`、`/leaderboard`（A 期 read-only summary）

#### 已完成基礎（保留紀錄）
- [x] Prisma schema（dev schema）新增最小餐飲實體：Restaurant/Branch/Table/MenuItem/Order/OrderItem/Payment/TaxLine/Tip（不移除既有 `Player/Account/*`）
- [x] API `/bootstrap` 端點：一鍵建立示範餐廳/門店/桌位與菜單；前端 Demo Bootstrap CTA 整合另列於 admin/dev tooling 待辦
- [x] Frontend 粗版內部測試原型：現有 POS（開單/加菜/結帳）與 KDS 清單頁可供 dev/admin 驗證；里程碑 A polish 另列待辦
- [x] i18n 文案：新增餐飲相關字串鍵（含 POS/KDS 內部測試初稿，不破壞既有鍵）

### 資料庫與模型（餐飲）
- [ ] 里程碑 A foundation：`Ingredient` / `Vendor` / `Inventory` 最小欄位（支撐 core loop 的食材、NPC 供應商、庫存餘量）
- [ ] 里程碑 B：PO/GoodsReceipt/InventoryLot/StockMovement/Recipe/RecipeComponent（採購、批次、耗用、配方）
- [ ] 里程碑 B：ReorderRule（安全存量/補貨天數）
- [ ] 里程碑 C：MenuPrice（時段價）、ModifierGroup/Option（修飾/加料）

### API（Godot/BOT sync）
- [ ] Godot sync：讀寫玩家/餐廳狀態、本地存檔 metadata、日結結果、解鎖進度與雲端同步（選配）
- [ ] Economy endpoints：採購/庫存、供應商 deals、補貨建議、日結查詢；核心規則由 `packages/game-core` 提供
- [ ] Discord linking：連結 Discord user/guild/channel 偏好，供 Bot Companion 與通知使用
- [ ] Internal test endpoints：保留 POS/KDS 開單、票單與出餐 API 作為內部測試工具，避免承載完整玩家 UI 規則
- [ ] i18n 錯誤碼與 Godot/BOT/Frontend 字典對應
- [ ] 安全：Rate limit、Idempotency-Key（日結/補貨/入庫）、權限與審計日誌
- [ ] 里程碑 A/B - Mini-game API：`/games/nanb` 對局管理、獎勵發放、排行榜讀寫與快取、作弊偵測 hook

### Worker（餐飲）
- [ ] 里程碑 A：日結 Sales/COGS/ServiceCharge/Tip 憑證，並以最小 `Vendor` 資料執行簡易 supplier deal/shortage tick
- [ ] 里程碑 B：庫存保鮮期/報廢、配方耗用出庫、盤點差異
- [ ] 里程碑 B：補貨規則運算與建議 PO 產生
- [ ] 里程碑 B/C - Mini-game 排程：B 期每日/每週/每月排行榜結算、獎勵派發、通知推播、資料封存；C 期活動/社群競賽排程

### Godot（Steam 主遊戲）
- [ ] 里程碑 A：2D management UI（餐廳狀態、庫存、供應商、菜單/價格、日結結果）
- [ ] 里程碑 A：本地存檔、讀取/重開驗證、離線 playable core loop
- [ ] 里程碑 A：串接 `game-core` deterministic loop 或等價輸出，保持與 API/Worker 結算一致
- [ ] 里程碑 B：供應商價格波動、缺貨、交期、補貨提示與解鎖節奏
- [ ] 里程碑 C：玩家市場、可玩產業鏈角色、活動與排行榜 UI

### Frontend（admin/dev tooling）
- [ ] 基礎：UI Kit/Design Token、共用 Layout、API 客戶端 + React Query、i18n 切換與偏好儲存
- [ ] 里程碑 A - Admin polish：Demo Bootstrap CTA（串接已完成 API 端點）、玩家/餐廳狀態、健康狀態、手動日結、content 檢視
- [ ] 里程碑 A - POS/KDS 內部測試 polish：整理既有粗版原型，補桌位地圖、開單/加菜流程、票單清單、狀態操作（start/serve/bump）
- [ ] 里程碑 B - 庫存/採購管理：Ingredient/批次列表、低庫存警示、PO 草稿與收貨、成本檢視
- [ ] 里程碑 B - 內容/平衡工具：Modifier & Option、Recipe、時段價、供應商事件與成本試算
- [ ] 里程碑 C - 報表/多門店後台：銷售/毛利/庫存儀表板、拆併單測試、班表/權限管理
- [ ] 品質：Storybook 或 Ladle、Playwright/Cypress E2E、Sentry + Web Vitals 上報
- [ ] 里程碑 B/C - Mini-game tooling：B 期提供排行榜詳情/獎勵兌換稽核/任務進度；C 期擴充活動設定、成就與分享工具

### Bot（Discord Companion）
- [ ] Companion MVP：`/status`、`/daily`、`/inventory low`、`/supplier deals`、`/restock`、`/leaderboard` 串接 API 與 Worker 結果；`/leaderboard` A 期僅提供 read-only summary
- [ ] Event/community phase：`/event join`、活動報名、社群競賽與賽季互動（C 期）
- [ ] 通知：日結摘要、低庫存、供應商特價/缺貨、補貨完成、活動開始/結束與獎勵可領取提醒
- [ ] Discord linking：支援 Discord 帳號與遊戲身分連結、權限檢查、伺服器/頻道偏好與 `en/zh` 本地化回應
- [ ] Dev test commands：保留 POS/KDS 相關指令作為內部開發測試工具，不作為完整玩家操作介面

### 觀測與維運
- [ ] Pino 日誌結構化輸出，請求追蹤 ID
- [ ] 指標：BullMQ 佇列深度、Tick 用時、DB/Redis 指標
- [ ] 健康檢查、Readiness、Liveness（K8s）
- [ ] 里程碑 A/B/C - Mini-game 指標：活躍玩家數、平均回合、排行榜更新延遲、獎勵發放狀態

### 風控與稽核
- [ ] 反作弊檢測（異常交易/資金流）
- [ ] Event Sourcing + Snapshot 設計（中期）

---

## 9. 風險與緩解
- Godot runtime 風險 → 先做小型 2D management prototype 與本地存檔驗證，再擴充 UI/內容；以固定 seed 對齊 `game-core` 結果
- Local save / sync 風險 → 本地存檔永遠可用，雲端同步與 Discord linking 作為選配；同步失敗不阻塞 core loop
- 模型轉向風險 → 優先以 dev schema 新增餐飲實體，保留舊模型以相容，逐步遷移
- 結帳/帳務正確性 → 單元測試覆蓋稅/折扣/服務費/小費與雙分錄平衡
- 庫存複雜度 → 先支持批次/報廢/出庫，後續再加盤點/轉移/多倉
- POS/KDS 定位偏移 → 明確標記為內部測試/admin tooling，不作為主要玩家入口或完整產品 UI
- i18n 成本 → 統一字串鍵，落入字典維護流程

---

## 10. 驗證與上線清單
- [ ] 可重現本地環境（`docker compose up`）
- [ ] DB schema 版本化與遷移（Prisma）
- [ ] Godot runtime 驗證（採購→自動營業→日結→解鎖→本地存檔重開）
- [ ] `game-core` fixture 驗證（固定 seed 下庫存耗用、收入/COGS、帳務平衡與 Worker/API 結果一致）
- [ ] 基準場景測試（Godot core loop→API sync→Worker 日結→BOT 通知；POS/KDS 僅內部測試）
- [ ] 監控儀表板最小集合到位
- [ ] 安全掃描（依賴/容器）

---

## 附註
- 現有腳手架：`econ-game/` 已包含 API/Worker/Frontend、Postgres、Redis 與文件
- 與現況相容策略：短期在 `schema=dev` 新增/演進餐飲模型，待穩定後再考慮清理歷史模型或改名（例如將 `Player` 更名為 `Owner/Company`）
