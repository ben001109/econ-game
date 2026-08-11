# MVP 經濟不變量：開局快照（E-01）

- **狀態：** active
- **擁有者：** Econ Game domain architecture
- **最後更新：** 2026-08-01
- **相關規格：** [開局情境與經濟不變量](../game-design/starting-scenarios.md)、[E-01 decision register](../architecture/decision-register.md)
- **測試層次：** unit

## 目標

證明 M0 的純 TypeScript opening-scenario contract 精確承載已確認的三組開局數值，且不可被不可信輸入或呼叫端 mutation 改變。這些測試不連線資料庫，也不測試會計入帳、授權或 Worker 行為。

## 前提與測試資料

- 固定 `simulationRuleVersion`：`mvp-e01-v1`。
- Money 使用 `TWD` 與 canonical base-10 integer minor-unit strings；不使用 JavaScript `number`、真實個資、憑證、資料庫或 production 資料。
- 測試指令：在 `services/api` 內以 Node 20 執行 `npm test`。

## 不變量／驗收條件

- catalog 僅包含 `EMPTY_PREMISES`、`DEFAULT_SMALL_SHOP`、`TROUBLED_SHOP`，且數值精確符合 E-01。
- Money 僅接受三字母大寫 code 格式與 canonical integer minor-unit string，且可直接 JSON 序列化。
- 只有 locked competitive operating mode 與非空 simulation rule version 能建立 snapshot。
- 建立出的 snapshot 與其 nested Money／range／NPC 資料均不可變。
- 未知 scenario、未鎖定模式或空 rule version 必須失敗，不能 fallback。

## 情境矩陣

| ID | Given | When | Then | 層次 | 自動化狀態 |
|---|---|---|---|---|---|
| E01-U01 | 已確認 catalog | 載入 catalog | 三種情境與所有鎖定數值完全相符 | unit | automated |
| E01-U02 | `TWD`, `"32000"` | 建立 Money | 產生不可變、可序列化的 canonical integer Money | unit | automated |
| E01-U03 | 無效 currency、JavaScript `number` 或非 canonical amount string | 建立 Money | 拒絕輸入 | unit | automated |
| E01-U04 | 問題店、策略模式、固定 rule version | 建立 snapshot | 包含債務、還款、設備、NPC、口碑與損益區間 | unit | automated |
| E01-U05 | 未知 scenario、沙盒模式或空 rule version | 建立 snapshot | 明確拒絕，不產生 fallback snapshot | unit | automated |
| E01-U06 | 已建立問題店 snapshot | 嘗試修改 nested Money | mutation 失敗，原金額維持 8,000 | unit | automated |
| E01-U07 | 預設小店／問題店／空白店面 | 建立 snapshot | 設備帳面值分別為 28,000／25,000／不存在 | unit | automated |

完整設備折舊、NPC 合約、各口碑維度、租約與貸款 schedule 尚無足夠已確認資料，不能以測試 fixture 發明 expected values；詳見 [M0 Architecture blockers](../architecture/mvp-first-milestone.md#architecture-blockers不得由-mvp-補值)。

## 可觀測性與證據

- `npm test` 的 TAP 輸出為 M0 unit assertion 證據。
- `npm run build` 證明 contract 與現有 API TypeScript compile 相容。
- `prisma generate --no-engine` 僅作 tooling gate；不建立 migration 或寫入資料庫。

## 失敗處理

- 任一 E01 unit 測試失敗時，不允許將 contract 接入 Fastify routes、Prisma schema、Worker 或 client。
- 若 future rule 變更，新增 rule version 與對應 fixture；不得改寫既有競技存檔的 snapshot。
- E-02～E-05 定稿前，任何對客流、原料、口碑或日結的數值推導都不屬於本測試規格。
