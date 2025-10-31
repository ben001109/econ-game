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
- Mini-game（nanb）
  - 核心玩法：`nanb` 猜數字/問答（依定義完善），支援多人輪流與單人練習模式
  - 獎勵系統：每日任務、周/月累積獎勵、餐飲系統虛擬貨幣或折扣券
  - 排行榜：日/週/月排行榜，支援餐廳內部與全伺服器榜單、平手處理與作弊檢測
  - 整合：遊戲結果回寫 Player Profile、POS 提示當週冠軍、Discord 公告
- Bot（Discord Slash Commands）
  - FOH 快捷：`/pos open`（開單）、`/pos add-item`（加菜/備註）、`/pos close`（結帳/小費/關單）
  - KDS 操作：`/kds tickets`（查看佇列）、`/kds start`、`/kds serve`、`/kds bump`（退菜預留）
  - 維運支援：`/ops bootstrap`（重建 Demo 資料）、`/ops health`（服務健康）、`/ops alert`（日結/庫存提醒）
  - 權限與 i18n：指令層級權限（管理員/前台/後台）與 `en/zh` 本地化回應
- 快取（Redis）
  - KDS 佇列/訂單狀態、熱門品項、門店看板；TTL/失效策略

---

## 4. 前端（Next.js, i18n）
- 架構/基礎：
  - Next 14（Pages Router）+ TypeScript；評估里程碑 B 起轉 App Router（Server Actions）可行性
  - UI：Tailwind + Headless UI 或 Radix；建立共用 Layout、Top Nav、狀態提示（Toast/Modal）
  - 資料層：自訂 API 客戶端（fetch + Zod）與 React Query（或 SWR）管理快取；錯誤統一處理
  - 狀態：POS/KDS 採用 Zustand（或 Context）存放暫存訂單；支援樂觀更新與離線提醒
  - i18n：Next Intl（或 next-translate）維護 `en/zh`，金額/時區格式化，權限字串同步
- 模組藍圖（依里程碑）：
  - 里程碑 A（MVP）
    - POS：桌位地圖/搜尋、開單流程、點餐面板、帳單摘要、小費/折扣輸入、Demo Bootstrap CTA
    - KDS：工位看板、票單狀態切換（start/serve）、退菜預留、音效/視覺提醒
    - 共用：登入（暫用魔術碼或 Demo 模式）、權限守衛、健康狀態橫幅、Loading Skeleton
    - Mini-game：nanb 遊戲入口、即時答題 UI、計分與結果彈窗、排行榜預覽卡
  - 里程碑 B（庫存/採購）
    - 庫存：Ingredient 列表、低庫存提醒、批次詳情、Lot 進出紀錄
    - 採購：PO 清單、草稿編輯、收貨驗收、成本統計摘要
    - 菜單/配方：Modifier/Option 編輯、Recipe + 成本試算、時段價設定
    - Mini-game：獎勵兌換頁、週/月排行頁面、玩家成就牆
  - 里程碑 C（拓展/報表）
    - 多門店切換、班表/權限 UI、POS 拆併單、報表儀表板（銷售/毛利/庫存周轉）
    - 行動版最佳化（POS/KDS）、自訂主題與品牌化
    - Mini-game：跨餐廳排行榜、邀請賽/活動、成就徽章展示與分享
- 體驗與維運：
  - 無障礙（WCAG AA）、鍵盤導覽
  - Storybook 元件庫（或 Ladle）、Chromatic 快照
  - E2E：Playwright/Cypress 覆蓋 POS/KDS 關鍵路徑，整合 GitHub Actions
  - 監測：前端 Sentry、性能指標（Web Vitals）上報、版本標記

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
- Mini-game：nanb 基礎對局、個人即時積分、每日排行榜雛型
- 驗收：一組內用點餐→出餐→結帳→日結→帳務平衡

### 里程碑 B（3–6 週）庫存與採購
- DB：Ingredient/Vendor/PO/GoodsReceipt/InventoryLot/StockMovement/Recipe/RecipeComponent
- API：採購/驗收、出庫（配方耗用/報廢）、補貨建議
- Worker：保鮮期/報廢、補貨排程、配方成本滾動
- 前端：庫存/採購/配方管理 UI
- Mini-game：週/月排行榜結算、獎勵兌換、Discord 公告整合
- 驗收：依菜單出貨耗料、到期自動報廢、補貨建議可生成草稿 PO

### 里程碑 C（6–12 週）拓展與報表
- 多分店/時段價/修飾、拆併單
- 角色/權限、審計日誌、觀測面板
- 報表：銷售/毛利、庫存周轉、員工績效（基礎）
- Mini-game：跨餐廳競賽、活動賽季、成就徽章與獎勵擴充

---

## 8. 工作分解（可指派的 TODO，已餐飲化）

### 基礎設置
- [x] 新增 `.nvmrc`（Node 20）
 - [x] 新增 ESLint/Prettier（TS 設定），對齊 maii-bot 風格
 - [x] GitHub Actions：Lint/Build/測試 + Docker build
- [x] docker-compose dev profile（API/Worker 源碼熱更新）

### P0（立即優先，避免阻塞）
- [x] Prisma schema（dev schema）新增最小餐飲實體：Restaurant/Branch/Table/MenuItem/Order/OrderItem/Payment/TaxLine/Tip（不移除既有 `Player/Account/*`）
- [x] API 路由（最小）：開單 POST /orders、加菜 POST /orders/:id/items、結帳 POST /orders/:id/payments、KDS：/kds/tickets 拉單/出餐
- [x] 前端原型：POS（開單/加菜/結帳）與 KDS 清單頁
- [x] i18n 文案：新增餐飲相關字串鍵（POS/KDS 初稿，不破壞既有鍵）
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
- [ ] Mini-game API：`/games/nanb` 對局管理、獎勵發放、排行榜讀寫與快取、作弊偵測 hook

### Worker（餐飲）
- [ ] 日結：Sales/COGS/ServiceCharge/Tip 憑證
- [ ] 庫存：保鮮期/報廢、配方耗用出庫、盤點差異
- [ ] 補貨：規則運算與建議 PO 產生
- [ ] Mini-game 排程：每日/每週/每月排行榜結算、獎勵派發、通知推播、資料封存

### 前端（餐飲）
- [ ] 基礎：UI Kit/Design Token、共用 Layout、API 客戶端 + React Query、i18n 切換與偏好儲存
- [ ] 里程碑 A - POS：桌位地圖、開單/加菜流程、帳單摘要、小費/折扣、錯誤/離線提示
- [ ] 里程碑 A - KDS：票單清單、狀態操作（start/serve/bump）、即時刷新、聲光通知
- [ ] 里程碑 A - 共用：簡易登入/權限守衛、健康狀態橫幅、Demo Bootstrap 手動觸發
- [ ] 里程碑 B - 庫存/採購：Ingredient/批次列表、低庫存警示、PO 草稿與收貨、成本檢視
- [ ] 里程碑 B - 菜單/配方：Modifier & Option 編輯、Recipe 管理、時段價設定、成本試算
- [ ] 里程碑 C - 報表/多門店：銷售/毛利/庫存儀表板、拆併單 UI、班表/權限管理、行動版最佳化
- [ ] 品質：Storybook 或 Ladle、Playwright/Cypress E2E、Sentry + Web Vitals 上報
- [ ] 里程碑 A - Mini-game：nanb 遊戲 UI、即時分數、失敗/勝利狀態、排行榜快照
- [ ] 里程碑 B - Mini-game：獎勵兌換、任務進度、週/月排行榜詳情頁
- [ ] 里程碑 C - Mini-game：跨伺服器排行榜、活動賽事、社群分享與徽章展示

### Bot（Discord 指令）
- [ ] MVP：`/pos open`、`/pos add-item`、`/pos close` 串接 API，支援桌位選擇與小費輸入
- [ ] KDS：`/kds tickets` 查詢、`/kds start`/`/kds serve` 更新狀態，回傳 ticket 摘要
- [ ] 維運：`/ops bootstrap` Demo 資料重建、`/ops health` 服務健康檢查、通知 channel
- [ ] 庫存/採購（B 期）：`/inventory low` 欠料清單、`/inventory po-draft` 建議採購指令，連動 Worker 報告
- [ ] Mini-game：`/nanb play`、`/nanb leaderboard`、`/nanb reward` 指令，串接排行榜與獎勵

### 觀測與維運
- [ ] Pino 日誌結構化輸出，請求追蹤 ID
- [ ] 指標：BullMQ 佇列深度、Tick 用時、DB/Redis 指標
- [ ] 健康檢查、Readiness、Liveness（K8s）
- [ ] Mini-game 指標：活躍玩家數、平均回合、排行榜更新延遲、獎勵發放狀態

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

補充：
- [x] API `/bootstrap` 端點：一鍵建立示範餐廳/門店/桌位與菜單，便於 POS/KDS 測試

---

## 附註
- 現有腳手架：`econ-game/` 已包含 API/Worker/Frontend、Postgres、Redis 與文件
- 與現況相容策略：短期在 `schema=dev` 新增/演進餐飲模型，待穩定後再考慮清理歷史模型或改名（例如將 `Player` 更名為 `Owner/Company`）
