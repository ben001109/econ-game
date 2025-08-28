# 開發計畫 Roadmap（Econ Game）

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

## 1. 需求輪廓與系統邏輯
- 兩段式資料層: Redis（快取/佇列）+ PostgreSQL（永久/權威）
- i18n 與多國生態: 多語（UI/訊息）、多幣別、匯率、各國關稅/稅制、時區/度量單位
- 真實經濟要素:
  - 貨幣與匯率: `Currency`, `ExchangeRate (FX)`、中央銀行政策（利率、量化寬鬆）
  - 商品與資源: `Commodity`（原料/能源/農產/金屬）、`Product`（製成品）
  - 市場與撮合: `Market`（地區/國家/全球）、訂單簿（限價、市價、撮合引擎）
  - 生產與供應鏈: `Factory`, `Recipe`（投入/產出/效率/產能）、`Inventory`, `Logistics`（運輸/倉儲/時延/成本）
  - 政策與稅: 關稅、營業稅、所得稅、補貼、配額、禁令
  - 金融體系: `Account` 雙分錄帳、`Loan`/`Interest`、`Bond`（可後期）、`Bank`（放款/存款）、信用評等
  - 風險與衝擊: 黑天鵝事件、供應中斷、天氣、戰爭、疫情（事件模型）
- 遊戲循環: 玩家/公司建立 → 採購/生產/運輸 → 市場交易 → 擴張/研發 → 政策互動

---

## 2. 資料模型（初稿）
- 會計（已腳手架）: `Player`, `Account(AccountType)`, `LedgerEntry`, `LedgerLine`
- 多幣別/匯率: `Currency { code, symbol, precision }`, `ExchangeRate { base, quote, rate, ts }`
- 市場與訂單:
  - `Market { region, commodity/product, currency }`
  - `Order { side, price, qty, type(limit/market), tif, playerId, marketId }`
  - `Trade { buyOrderId, sellOrderId, price, qty, ts }`
  - `OrderBookSnapshot`（可選，快照以利查詢/回測）
- 商品/配方/產能:
  - `Commodity`, `Product`, `Recipe { inputs[], outputs[], duration, energy, labor }`
  - `Factory { location, capacity, efficiency }`
  - `Inventory { owner, sku, qty, costModel }`
- 物流/地理:
  - `Location { country, region, port? }`, `Route { from, to, time, cost }`, `Shipment`
- 稅制/政策:
  - `TaxRule { type, rate, scope, effectiveAt }`, `Tariff { from, to, commodity, rate }`, `Subsidy`
- 金融:
  - `Loan { principal, rate, schedule }`, `Bank`, `InterestAccrual`
- 指標與歷史:
  - `PriceTick`, `MarketMetrics`, `EconomicIndicator`（供需、庫存、產能利用率）

---

## 3. 服務與模組
- API（Fastify + Prisma）
  - REST（可擴展 GraphQL）：玩家、帳戶、交易（雙分錄）、市場查詢、下單、出入庫
  - 驗證/安全: JWT 或 Session、Rate Limit、Idempotency-Key（下單/轉帳）、權限/配額
  - i18n 回傳: code-based 錯誤/訊息，前端字典對應
- Worker（BullMQ）
  - 經濟 Tick：供需演算、價格更新、利息累計、工廠產出、物流推進
  - 撮合引擎：以佇列驅動撮合，確保順序與一致性；或獨立匹配器（後期）
  - 外部事件：政策變動/隨機事件注入（可配置機率與影響權重）
- 快取策略（Redis）
  - 熱門行情、排行榜、玩家資產總覽快取；TTL + 失效策略
  - 去抖與頻率限制，避免 cache stampede

---

## 4. 前端（Next.js, i18n）
- 語系與在地化: `en`/`zh` 起步，擴充路由、字串、數字/貨幣/時間格式
- 頁面
  - 登入/註冊/公司建立
  - 儀表板：資產負債、現金流、倉儲與產能、當前訂單
  - 市場：商品清單、深度、成交、下單面板
  - 生產：配方、工廠、產能排程、耗能/成本
  - 物流：路線規劃、在途貨物、倉儲
  - 政策：稅率/關稅展示、國家資訊
- 可視化：K線、深度圖、Sankey（供應鏈流向）、地圖（物流路徑）

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

### 里程碑 A（0–4 週）MVP
- API：玩家/帳戶/雙分錄交易、基本市場查詢、下單（限價單，先撮合簡化）
- Worker：經濟 tick（庫存衰減/固定成本/利息累計）、簡化價格更新
- 前端：登入/儀表板/市場列表 + 下單雛形、i18n 切換
- 資料庫：Prisma schema 覆蓋會計 + 市場最小集合
- 驗收：
  - 新玩家建立與基礎帳戶自動建立
  - 可建立一次完整交易（雙分錄平衡）
  - 下限價單可成交並生成成交紀錄與帳務
  - 前端能展示持倉/餘額/最近成交

### 里程碑 B（1–3 個月）可玩版本
- 市場：正式撮合引擎（價優、時間優先），撮合隊列化，快照/回放
- 供應鏈：Recipe/Factory/Inventory/Logistics 基線模型與 UI
- 多國：Currency/FX、跨國市場、關稅/稅制（基本）
- 安全/可靠：Rate limit、Idempotency、審計日誌、觀測面板
- 驗收：
  - 支援多幣別交易與即時/定時匯率更新
  - 跨國物流影響交期與成本，關稅計入成本
  - 撮合吞吐與延遲達到目標（例如 p50<50ms，p99<200ms 在測試數據下）

### 里程碑 C（3–12 個月）規模化
- 事件溯源 + 快照，歷史查詢/回放
- 複雜政策/金融工具（貸款、債券、補貼/配額）
- 大型地圖/多市場互通、動態事件/災害
- 資料分區與歸檔、性能調優（索引、批處理、CQRS/讀寫分離）
- 驗收：
  - 在壓測（同時玩家/訂單數量）下保持穩定
  - 經濟指標可視化與回測工具可用

---

## 8. 工作分解（可指派的 TODO）

### 基礎設置
- [x] 新增 `.nvmrc`（Node 20）
 - [x] 新增 ESLint/Prettier（TS 設定），對齊 maii-bot 風格
 - [x] GitHub Actions：Lint/Build/測試 + Docker build
- [x] docker-compose dev profile（API/Worker 源碼熱更新）

### 資料庫與模型
- [ ] 擴充 Prisma：`Currency`, `ExchangeRate`, `Market`, `Order`, `Trade`
- [ ] 商品/配方/產能：`Commodity`, `Product`, `Recipe`, `Factory`, `Inventory`
- [ ] 稅制/政策：`TaxRule`, `Tariff`（先覆蓋最小集合）
- [ ] 指標：`PriceTick`, `MarketMetrics`

### API
- [ ] 玩家/帳戶：CRUD、餘額查詢、科目彙總
- [ ] 交易：下單（限價/市價）、撤單、查詢訂單/成交
- [ ] 倉儲/生產：入庫/出庫、配方排程
- [ ] i18n 錯誤碼與前端字典對應
- [ ] 安全：Rate limit、Idempotency-Key

### Worker / 經濟引擎
- [ ] Tick 框架（已雛形）：模組化處理器（利息、庫存、價格、物流）
- [ ] 撮合：匹配與成交寫入（交易事件化），快照生成
- [ ] 匯率：定時更新（內建模型或外部來源）、多幣結算
- [ ] 物流：路徑耗時與成本累計，抵達入庫

### 前端
- [ ] i18n 結構與字典維護流程
- [ ] 儀表板：資產/倉儲/訂單/行情
- [ ] 市場：深度/成交/K 線、下單面板
- [ ] 生產/物流：配置與狀態視圖

### 觀測與維運
- [ ] Pino 日誌結構化輸出，請求追蹤 ID
- [ ] 指標：BullMQ 佇列深度、Tick 用時、DB/Redis 指標
- [ ] 健康檢查、Readiness、Liveness（K8s）

### 風控與稽核
- [ ] 反作弊檢測（異常交易/資金流）
- [ ] Event Sourcing + Snapshot 設計（中期）

---

## 9. 風險與緩解
- 經濟複雜度過高 → 以迭代方式引入（先簡化成本/需求，再加彈性/政策）
- 撮合與一致性 → 單點序列化（佇列/鎖）、事件驅動、明確事務邊界
- 性能瓶頸 → 指標監控、索引與查詢優化、批處理與快照
- i18n 維護成本 → 統一字串鍵與流程、lint 檢查缺漏

---

## 10. 驗證與上線清單
- [ ] 可重現本地環境（`docker compose up`）
- [ ] DB schema 版本化與遷移（Prisma）
- [ ] 基準場景測試（撮合、tick、下單吞吐）
- [ ] 監控儀表板最小集合到位
- [ ] 安全掃描（依賴/容器）

---

## 附註
- 現有腳手架：`econ-game/` 已包含 API/Worker/Frontend、Postgres、Redis 與文件
- 若需要完全比照 maii-bot 的目錄與腳本風格（例如更傾向 JS 而非 TS），可在里程碑 A 內調整開發模板與工具鏈
