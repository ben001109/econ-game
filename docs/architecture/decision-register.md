# Econ Game 架構決策總表

> **狀態：** 架構決策階段；尚未進入正式 MVP implementation。
>
> **唯一規格來源：** `.hermes/plans/2026-07-30_082729-clerk-supabase-game-architecture.md`。
> 本文件只用來索引已確認事項、排列未決問題與追蹤決策先後順序；不能取代完整架構計畫。
>
> **主控交接：** [MVP 封測主控交接稿](mvp-closed-beta-controller-handoff.md)。

## 決策原則

1. 一次只決定一項會影響資料模型、經濟公式、權限、安全、測試或營運的規則。
2. 確認後必須更新完整架構計畫、保留原因與階段邊界。
3. 金錢、契約、股權、市場與其他高風險 mutation 必須經 server-side transaction、authorization、idempotency、version check、audit 與可重播規則版本。
4. MVP 與 Beta 是封測產品；正式公開版才承諾持續世界與永久經濟資料。

## 已確認架構基線

| 範圍 | 已確認決策 |
|---|---|
| 正式產品線 | TypeScript／Fastify／Prisma／Next.js／Discord Bot；Python 不做正式產品主線。 |
| 身份 | Clerk User 為唯一身份真相；Discord 透過短效一次性 IdentityLink 連到 Clerk User 與 Player。 |
| 資料與授權 | Supabase PostgreSQL、RLS 與 Fastify RBAC 雙層保護；client 不直接寫高風險遊戲資料。 |
| 跨平台一致性 | Web 與 Discord 共用 API state machine；採 version、idempotency key、SHA-256 request fingerprint。 |
| 資料可追溯 | 金錢、契約、股權與市場事件 append-only；一般營運狀態可更新但保留 version/audit；修正用補償／沖銷 event。 |
| 人工補償治理 | 系統依審核規則可自動補償；人工補償需提出者與 approver 雙人覆核。 |
| 經濟世界 | 正式公開版是持續世界、使用績效窗排行榜；MVP／Beta 為受邀刪檔封測。 |
| wipe | 僅在公告里程碑或破壞性 schema 變更前；保留身份、Discord 綁定、邀請資格與非經濟偏好；清除遊戲經濟與 AI session context。 |
| 封測入口與回饋 | MVP 限內部／受信任邀請；Beta 邀請碼分批擴大；測試參與給稱號與非競技起始包，資料同意不交換經濟優勢。 |
| 多國經濟 | ISO 4217、minor units、區域稅與 rounding snapshot；外部匯率僅是有界輸入，固定 market batch 產生可重播遊戲 FX snapshot。 |
| 地理／價格 | 價格 = 遊戲基準 × 大區購買力／成本指數 × 有界外部參考；MVP 國家／大區，Beta 城市分級，正式版城市模型。 |
| 稅與價格呈現 | MVP 使用消費稅/VAT＋雇主成本的有效稅率；帳本保留淨額、稅額、總額；售價顯示、稅率與 rounding rule 皆 snapshot。 |
| 債務 | 營運幣別的固定期限貸款；每 5 個完成營業日扣款；首次逾期採寬限期、逾期費與重整／救濟。 |
| 員工契約 | 日結淨營業利潤分潤；總池 30%、單人 15%；改約重接受、下一營業日生效；已完成班次依 immutable contract snapshot。 |
| 玩家內容與 AI | MVP catalog＋文字品牌；Beta 才開放受審核圖片資產；AI 只能受控 proposal、moderation、標籤與摘要，不能直接更改經濟或權限。 |
| 公開營運可靠性 | 初次公開目標：RPO ≤15 分鐘、RTO ≤4 小時、99.5% availability SLO。 |

## 架構決策順序

以下順序不可跳過；數字定稿前，不進入 schema／API／UI 正式實作。

### P0：MVP 經濟閉環

| ID | 決策題目 | 交付物 | 狀態 |
|---|---|---|---|
| E-01 | 三種開局的目標體驗與數值不變量 | 已確認完整 OpeningSnapshot：stable asset／liability identity、設備原值／累折／直線折舊與營運 modifier（基本設備品質 0；問題店老舊設備唯一品質修正 −10、容量 0.85）、四份 NPC role／薪資／班次／30 日 term、三情境五維名譽、30 日租約／2×日租 deposit／續約調租邊界、兩筆零息 20 期貸款／500 bps late fee／首次 1 日 grace、ISO 4217 exponent conversion，以及 schema／catalog／currency metadata／simulation rule 四版與 canonical SHA-256 hash 語意。數值 catalog 為 `mvp-e01-opening-v2`；E01-S-01 可直接派發。 | 已確認（無 Architecture blocker） |
| E-02 | 第一個營業日的需求與客流模型 | 已確認：`e02-space-v1` first-day limits 為 EMPTY `grid 9×8 / usable 72 / seats 26 / waiting groups 3`、DEFAULT `10×9 / 90 / 30 / 4`、TROUBLED `8×7 / 56 / 24 / 2`。矩形 grid 全 usable，第一日只含 seat／walkway／waiting zone；waiting cap 以完整 1–4 人 group 計。正常三段晚餐尖峰依固定 group mix 為 30／34／27 人，對 seats 上限 raw overload 為 15.38%／13.33%／12.50%，符合 10–20%。BASIC／AGED 與 repair 不改 premises limits，AGED 0.85 不套空間；只有未來 versioned renovation 可改後續 snapshot。配置只可開店前或合法離峰更新，三個尖峰期間鎖定。其餘教學友善正常日、無 VIP／事件 NPC、預報、三類客群、二／三段營業、需求 seed／replay 與價格／天氣邊界均已寫入完整架構計畫；競技存檔鎖定時段方案、營業模式與未來難度條件並分組排行榜。 | 已確認 |
| E-03 | 菜單、原料、損耗與採購公式 | 已確認：durable／perishable 絕對容量為 `EMPTY_PREMISES=280/280`、`DEFAULT_SMALL_SHOP=305/305`、`TROUBLED_SHOP=255/255` 整數點。驗證以 E-02 二／三段 base groups 疊加各情境 forecast 上界、+5% weather、+10% price conversion 後取 ceil，採三段較大值、2.25 人／組、每人最壞 3 點、單一 pool `+20%`，再向上對齊 5 點。合法菜單可全壓 durable 或 perishable 並恰好滿池；兩池不借用。EMPTY 未安裝 BASIC bundle 時實際容量 0 且不得開店；TROUBLED 的 255 已 baked-in，E-04 0.85 與 MVP repair 不再改 storage capacity，僅 versioned replacement／upgrade 可從新 snapshot 改變。take-or-pay 自簽約即以全部未到貨承諾占用對應 pool，並強制 `onHand+reservedUndelivered<=capacity`；到貨原子 reservation→onHand，付款不足不釋放。其餘受控菜譜卡、難度菜單張數、每人主餐、價格／轉換公式、替代、移動平均成本、可重播市價與現貨／合約規則均已寫入完整架構計畫；售罄服務效果屬 E-04，付款不足救濟屬 E-05。 | 已確認 |
| E-04 | 服務、品質與聲望公式 | 已確認：偏好菜譜售罄依 seed deterministic 改點一次，無可供應菜才離店；耐心只適用候位，訂單建立後保證完成。訂單採 `CREATED → PREPARING → READY → SERVED` 的 deterministic K/F 工作量／tick 工作流，`K_WORK/F_WORK=12/8`；Web／Discord 共用規則。容量為 `Σ(roleBase×ability×morale×equipment)`：roleBase 廚房 `1.00/0.70/0.55`、前場 `1.00/0.75/0.65`，ability `0.80/1.00/1.15`，設備 basic／aged `1.00/0.85`。NPC morale 唯一為 `LOW/NORMAL/HIGH=0.90/1.00/1.10`，不得疊加 pool morale factor；MVP PLAYER morale 固定 `1.00`。contributor 與訂單均穩定排序，逐 tick 記錄 `WorkContribution`。LOW KITCHEN NPC 的品質修正 `−5` 只套到實際取得其正數 contribution 的訂單，每單最多一次、不因多 tick／多人疊加；idle LOW NPC 不污染 pool，LOW CASHIER 只影響前場 capacity／速度。老舊設備品質修正 `−10`。完成訂單各產生 0–100 的 foodQuality／serviceSpeed，並依既定 price／speed／quality／fairness／vibe 五維公式以 0.4 權重更新；超載 >20% 寫 `FLOW_RISK_HIGH`。 | 已確認 |
| E-05 | 日結會計與失敗／重整狀態機 | 已確認：`DELINQUENT`、`RESOLUTION`、`REHAB`、`RecoveryNeeded`、`ReputationCrash`、`FLOW_RISK_HIGH` 的轉換與事件已固定。`riskPenalty` 使用 `e05-risk-penalty-v1`：`base=0→amount=0`；正數 base 為 `max(1,floor((base×300+5000)/10000))`，即 300 bps、HALF_UP、最低 1 minor unit。每個正數 `resolutionComparisonShortfallMinor` DayEnd 收一次，不只首次；跨日 amount 線性累加，當次與歷史 penalty 均不進後續 base、不複利，DayEnd 唯一鍵防止重試重複入帳。snapshot 固定保存 version／base／rate／denominator／rounding／minimum／amount／accrued total／currency，正數 base event 另存累計 before／after。`DELINQUENT → RESOLUTION` 使用本輪 Day 1 immutable `delinquencyBaselineShortfallMinor`，其值取 pre-risk-penalty `resolutionComparisonShortfallMinor`；第 2 日起以 minor-unit 整數式 `2×current>=baseline` 升級，故剛好 50% 升級，嚴格 `<50%` 才留在 `DELINQUENT`，不得相對前一日 rebase。comparator 包含 `debtDue` 內的 overdue penalty、排除 E-05 `riskPenalty`；最終報表 `shortfall` 仍含 `riskPenalty` 並用於完全清償。active baseline 在離開 `DELINQUENT` 時設 `null`，event 保留比較值，未來新一輪再建立。未改善 canonical 序列為 Day 1 DayEnd 進 `DELINQUENT`、Day 2 DayEnd 進 `RESOLUTION`（Day 3 開日生效）、完成 3 個 `RESOLUTION` 營業日後於 Day 5 DayEnd 進 `REHAB`（Day 6 開日生效）；轉入 `RESOLUTION` 的 DayEnd 不算其第 1 日。`consecutiveDelinquentDays`／`consecutiveResolutionDays` 為 state-local，離開對應狀態即歸零；`ReputationCrash` 具最高優先權，同 transaction 直接進 `REHAB` 並歸零 counters。`highRiskRevenueEnabled` 的唯一規則為 `NORMAL=true`、首次 `DELINQUENT`（連續 1 日）`true`、連續欠款第 2 日起的 `DELINQUENT=false`、`RESOLUTION=false`、`REHAB=false`。每日營業採開日快照值，DayEnd 原子更新狀態／counters／次日旗標，不回溯當日已完成收益；回到 `NORMAL` 後次一營業日才恢復 `true`。旗標只控制 allowlist 高風險收益，不關閉正常訂單收益、必要支出、核心作業許可或救濟流程。日結計算鏈路、`shortfall` 追蹤、固定欄位、雙端 replay 一致性與封測放行條件均已寫入完整架構計畫。 | 已確認 |

### P1：可執行資料與服務設計

| ID | 決策題目 | 交付物 | 狀態 |
|---|---|---|---|
| D-01 | 核心 aggregate 與表格邊界 | 已確認 MVP 最小 family：身份／租戶、競技存檔、人員／契約、菜單／採購、庫存、營業流程、重播／日結、風險／歷史與 wipe batch。aggregate transaction、歷史保留、最小索引與 RLS/API-only 寫入邊界已固定；封測一致性採 `ReplayEvent` eventHash＋`DayEndSnapshot` snapshotHash 雙層 SHA-256，任一不一致即阻擋。精確 schema/DDL 留待實作設計。 | 已確認 |
| D-02 | 每個 mutation 的狀態機與 API contract | 已確認：資源導向 endpoint＋統一 command envelope；強制 `idempotencyKey`／`expectedVersion`、server-derived actor/scope、canonical SHA-256 fingerprint、相同請求回傳原結果、key 重用與舊 version 拒絕。核心玩家 mutation 用短時同步 transaction；wipe／批次重算等長工作用非同步 job，回 `202` 與 `jobId`。統一 machine-readable error envelope：版本／key／狀態衝突為 `409`，格式合法但違反規則或前置條件為 `422`。idempotency record 先以唯一約束取得執行權，終態至少保留 30 天（job 自終態起算）；期限後不保證回原結果，但舊 version 必拒絕。精確 schema／OpenAPI 留待實作設計。 | 已確認 |
| D-03 | Ledger、outbox、market tick、replay 設計 | 已確認：所有貨幣 movement 採 append-only 雙分錄 ledger、整數 minor unit、`transactionId` 分組與補償／沖銷；aggregate 狀態、ledger 與 immutable outbox event 同一 transaction 寫入。outbox 採 at-least-once，consumer 以 `eventId` 去重，不能直接改寫 core aggregate。job 以原子 lease claim、續租與可安全重跑 handler 執行；僅暫時錯誤最多 5 次 capped exponential retry，之後進 `DEAD_LETTER` 並告警／稽核人工處置。MVP market tick 以每個 save 的營業日邊界、唯一 tick identity 與可重跑 materialization 執行，無全域真實時間市場；tick／開店 snapshot 必存 seed、catalog revision 與 `simulationRuleVersion`，replay 缺原版本即阻擋。 | 已確認 |
| D-04 | Clerk、Supabase、Discord security spike | 已確認：Clerk 為唯一 end-user identity；Fastify 必驗證 JWKS／issuer／audience／expiry／authorized-party，並以 token subject 對應 server-managed Player／membership／role／branch scope。Supabase 只採 Clerk third-party JWT；RLS 僅開放必要 read model，核心表拒絕 client write；service role 僅供 API／worker。IdentityLink 採 Discord-ID-bound、雜湊保存、最長 10 分鐘、一次性 challenge，browser 需 Clerk 登入加同 Discord OAuth 證實；每方僅一 active link，轉移必須 re-auth／客服 recovery 並完整 audit。Bot 是 scope 受限 service principal，API 以其 credential＋Discord interaction 查 link 後建立 actor context；其操作與 Web 同 endpoint／RBAC／idempotency，且不得持有 end-user JWT、資料庫 service-role 或全域 admin。 | 已確認 |
| D-05 | 封測／wipe／邀請治理模型 | 已確認：MVP 採 cohort allowlist；`TestCohort` 定義目的、環境、名額、時窗、功能旗標與 eligibility policy version。Invite 為雜湊保存、單次、限時、可撤銷且只限一位已登入 Clerk User 兌換；lifecycle 為 `DRAFT → ACTIVE → CONSUMED | EXPIRED | REVOKED`，所有資格變動可稽核，且不授予經濟特權。Wipe 僅能透過雙人覆核且預先公告的 `WipeBatch` 非同步 job 執行，凍結 scope、隔離舊 live state、保留身份／連結／資格／偏好及 append-only 歷史，並以 hash／count 驗證。額外 replay／AI／詳細遙測為預設關閉、purpose-specific、版本化且可撤回的 consent；撤回停新蒐集。RewardEligibility 以 cohort milestone server events 快照判定、與 consent 無關，獎勵僅非競技。 | 已確認 |

### P2：AI、內容與營運

| ID | 決策題目 | 交付物 | 狀態 |
|---|---|---|---|
| A-01 | AI provider 與 model routing | 非全域封測阻擋；核心經濟 cohort 先以 AI feature flag 關閉進行。啟用 AI cohort 前必須完成 provider adapter、成本／速率熔斷、fallback、prompt/data retention 與 audit。 | 延後至 AI cohort 前 |
| A-02 | UGC moderation／appeal policy | 非封測阻擋；MVP 不開放公開 UGC、圖片／Logo／菜單資產、公開評論或申訴，僅保留受控 catalog 與非公開文字欄位。 | 延後 Beta |
| O-01 | 雲端部署與 secrets ownership | P0 封測阻擋：需 staging／production-like isolation、明確 owner、最小權限 principals、集中 secrets 管理與 rotation／revocation 路徑。 | 封測前必須完成 |
| O-02 | CI/CD 與測試品質門檻 | P0 封測阻擋：release gate 至少包含 lint、typecheck、unit／invariant、integration、RLS、雙端 E2E、併發／重送與 replay hash。 | 封測前必須完成 |
| O-03 | SLO runbook 與 disaster recovery | P0 封測阻擋（最小版）：事故／feature flag、backup restore 演練、market/replay 重建與 wipe fail/resume runbook；正式 SLO 容量承諾延後公開 Beta。 | 封測前必須完成 |

### P3：Beta 與正式版延伸

- 城市分級、區域 FX、跨區採購。
- 共享市場、有限玩家交易、公開職缺與跨城市徵才。
- 圖片／Logo／菜單資產 moderation pipeline。
- 完整供應鏈、物流、公司、股市、公司治理與跨境經濟。

## 下一步

E-01～E-05、D-01～D-05 已確認。封測放行以「決策可回放、日結／風險邊界齊備、雙層 hash、Web／Discord 一致」及 O-01～O-03 最小營運基線為條件。MVP 可依 [M0：開局經濟契約與可重播快照](mvp-first-milestone.md) 與下列工作包進行工程 handoff；A-01 僅阻擋 AI cohort，A-02 延後 Beta。

## MVP 封測可派發工作包（可直接交主控）

### E-01～E-03／D-01 補齊 Story

| Story | 優先級 | Owner | 估時 | 依賴 | DoD |
|---|---|---|---:|---|---|
| E01-S-01 完整開局 snapshot | P0 | `gameplay-core` | 2–3 天 | 既有 M0 contract、D-01 決策 | 三種情境完整保存資產／設備、NPC 合約、五維名譽、租約、還款表、Money conversion 與 rule version；相同 canonical input 產生相同 immutable snapshot。 |
| E02-S-01 需求預報與客群排程 | P0 | `simulation-core` | 3–4 天 | E01-S-01 | 二／三時段、三情境組數、客群／耐心／天氣／價格邊界與預報誤差依 E-02；第一日無 VIP／事件 NPC；同 seed 產生相同 replay events。 |
| E02-S-02 配置容量與 flow 指標 | P0 | `gameplay-core` | 2–3 天 | E02-S-01、E04-S-01 | 開店／離峰可配置、尖峰鎖定；走道距離、壅塞與候位可見性 deterministic；不建立即時 NPC 尋路。 |
| E03-S-01 菜單、庫存、成本與損耗 | P0 | `economic-engine` | 4–5 天 | E01-S-01 | recipe version／menu selection、分類庫存、容量、替代、移動平均成本、易腐損耗與價格轉換依 E-03，且可由 snapshot／event 重建。 |
| E03-S-02 採購、合約與市場輸入 | P0 | `economic-engine` | 3–4 天 | E03-S-01、D03-S-02 | 現貨與 take-or-pay contract、供應價 snapshot、付款義務與違約輸入可 replay；不加入 Beta 多供應商競標／物流。 |
| D01-S-01 Aggregate persistence／RLS boundary | P0 | `data-platform` | 4–5 天 | O01-S-01 | 實作 D-01 最小 family、FK／歷史不可 cascade、必要 unique／tenant indexes 與 RLS/API-only write boundary；跨租戶測試拒絕，migration 可審查且不使用 `db push`。 |

| 套件 | 可執行目標 | 主要交付 | 驗收條件 |
|---|---|---|---|
| E04-S-01 | 實作服務流程與流量承載參數 | 確認 `K/F` 工時、`queue/demand` 風險、tick 服務進度、`FLOW_RISK_HIGH` 事件 | 1) 任一 seed 可重放售罄改點與候位離開 2) `queue/demand>1.2` 會產生 `FLOW_RISK_HIGH` 3) 速度分數隨等待線性下降 |
| E04-S-02 | 實作品質與名譽映射 | 實作 `foodQuality`、`serviceSpeed` 與五維名譽更新（price/speed/quality/fairness/vibe） | 同 seed 在兩次跑分下，名譽每維都落在 0–100 且一致，且可由 replay 還原 |
| E05-S-01 | 實作日結會計鏈路 | 實作 `grossRevenue/cogs/wasteLoss/payroll/opex/tax/debtDue/dailyNet/shortfall/cash_after`，並寫入固定欄位報表 | 任一日結可輸出完整欄位且欄位型別固定；`shortfall>0` 可追蹤事件 |
| E05-S-02 | 實作風險狀態機 | 實作 `DELINQUENT/RESOLUTION/REHAB/RecoveryNeeded/ReputationCrash` 轉換規則與 event 追蹤 | 連續2日 DELINQUENT 會進 RESOLUTION，連續3日或名譽崩盤進 REHAB，能回放重現轉換 |
| E05-S-03 | 實作封測交付閘門 | 建 `封測可交付` 驗收流程：固定欄位、seed replay 一致、雙端一致 | Web 與 Discord 同 seed 重放 hash 一致；封測 wipe + replay 可還原營運結果 |
| P0-PLAT-01 | 跨端一致性 E2E | 建立 `開店→營運→日結→wiped→replay` 兩端驗收腳本 | 雙端每步驟狀態快照一致，關鍵欄位（營收、名譽、風險標籤）無缺漏 |

### D/O 架構衍生 Story（主控可直接開 ticket）

| Story | 優先級 | Owner | 估時 | 依賴 | DoD |
|---|---|---|---:|---|---|
| O01-S-01 封測環境與 secrets 基線 | P0 | `platform-infra` | 3–4 天 | 雲端帳號／region／billing owner 授權 | staging 與封測環境隔離；API／worker／Bot 各用最小權限 principal；secrets 不在 repo／client，且有 owner、rotation／revocation 步驟與 access audit。 |
| D02-S-01 統一 mutation contract | P0 | `api-platform` | 3–4 天 | D01-S-01 | 資源 endpoint 共用 envelope；server-derived actor/scope；idempotency＋fingerprint＋version 行為符合 D-02；同步／`202 jobId`、`409`／`422` error envelope 皆有 integration tests。 |
| D04-S-01 Clerk、RLS 與 Discord actor | P0 | `identity-security` | 4–5 天 | D01-S-01 | Clerk JWT 驗證與 server-side RBAC；RLS read-model isolation；一次性 link／relink audit；Bot service principal 只能推導 actor；跨租戶與未連結帳號測試皆拒絕。 |
| D03-S-01 Ledger 與 transactional outbox | P0 | `economic-platform` | 4–5 天 | D02-S-01 | 每個金錢 mutation 的雙分錄平衡、不可變 `transactionId` 與補償；aggregate／ledger／outbox 原子寫入；重送 consumer 不重複入帳。 |
| D03-S-02 Job、market tick 與版本 replay | P0 | `simulation-platform` | 3–4 天 | D03-S-01 | lease reclaim、5 次暫時錯誤 retry、DLQ audit；`(saveId,businessDay,tickKind)` 唯一 tick；歷史 rule/catalog version 重播成功，缺版本明確阻擋。 |
| D05-S-01 Cohort、Invite、Consent 與 Eligibility | P0 | `release-platform` | 3–4 天 | D04-S-01 | 單人／單次／限時／可撤銷 invite 與 cohort 上限原子驗證；purpose-specific opt-in／withdrawal；以 server events snapshot 的非競技 reward eligibility 與完整 audit。 |
| D05-S-02 WipeBatch workflow | P0 | `release-platform` | 3–4 天 | D03-S-02、D05-S-01、O01-S-01 | 雙人覆核與公告狀態機；freeze／resume-safe async wipe；舊 live state 隔離、append-only history 標記；hash／count verify 與 failed-runbook 演練。 |
| O02-S-01 封測 CI/CD release gates | P0 | `platform-qa` | 4–5 天 | D02-S-01、D03-S-02、D04-S-01、D05-S-02、E04/E05 stories | 封測部署須自動通過 lint、typecheck、unit／invariant、integration、RLS、Web／Discord E2E、併發／重送與雙層 replay hash；failure 不可 promotion，且具 rollback。 |
| O03-S-01 最小營運與復原 runbook | P0 | `release-ops` | 3–4 天 | O01-S-01、D03-S-02、D05-S-02 | 事故分級／聯絡、feature-flag 停用、backup restore、market/replay rebuild、wipe fail/resume 都有可演練步驟；staging restore drill 成功並留證。 |
| A01-S-01 AI cohort safety baseline | P1 | `ai-platform` | 3–5 天 | D02-S-01、D04-S-01、O01-S-01 | 僅在 AI feature flag 開啟前執行；provider adapter、budget／rate circuit breaker、fallback、prompt/data retention 與 audit 全數驗收。 |
| A02-S-01 公開 UGC 治理 | P1（Beta） | `trust-safety` | 5–7 天 | A01-S-01、O03-S-01 | 公開素材／評論上線前具 schema gate、review／report／appeal／removal、保存與 audit；MVP 不開工。 |

### 派發建議順序

1. 立即啟動 `E01-S-01`、`E04-S-01`／`E04-S-02`，並取得 O-01 授權後完成 `O01-S-01`。
2. `E01-S-01` 後並行執行 `E02-S-01`、`E03-S-01`；`O01-S-01` 後執行 `D01-S-01`。
3. `D01-S-01` 後並行執行 `D02-S-01`、`D04-S-01`；再接 `D03-S-01/02`、`E02-S-02`、`E03-S-02` 與 E-05 工作。
4. 以 `D05-S-01` 收斂 cohort，再實作並演練 `D05-S-02`；其後完成 `O03-S-01` 的復原 runbook。
5. `O02-S-01` 與既有 `E05-S-03`、`P0-PLAT-01` 最後共同構成封測放行門檻。

### 派發排程（主控可直接開 ticket）

- `E04-S-01`：1–2 天，Owner `gameplay-core`，依賴 `E-04 公式明細`
  - 目標：服務/流量引擎（K/F、tick、`FLOW_RISK_HIGH`）
  - DoD：同 seed 重放售罄改點與候位離開；`queue/demand>1.2` 標註風險
- `E04-S-02`：1.5–2 天，Owner `gameplay-core`，依賴 `E04-S-01` 或共享共識模型並行啟動
  - 目標：品質、服務速度、五維名譽映射
  - DoD：名譽維度重放一致且範圍在 0–100
- `E05-S-01`：2–3 天，Owner `economic-engine`，依賴 `E04-S-01/02` 已可回放
  - 目標：日結公式與 `shortfall` 報表
  - DoD：日結輸出欄位完整且可追蹤 shortfall 事件
- `E05-S-02`：1–2 天，Owner `economic-engine`，依賴 `E05-S-01`
  - 目標：風險狀態機與事件可追溯
  - DoD：2 日/3 日轉檔與名譽崩盤條件可重放
- `E05-S-03`：0.5–1 天，Owner `release-ops`，依賴 `E05-S-01/02`
  - 目標：封測交付閘門與風險欄位稽核
  - DoD：固定欄位輸出、雙端 replay hash 一致
- `P0-PLAT-01`：2–3 天，Owner `platform-qa`，依賴 `E05-S-03`
  - 目標：Web/Discord E2E 對齊（開店→營運→日結→wipe→replay）
  - DoD：雙端每步驟快照一致，欄位缺漏率 0%
