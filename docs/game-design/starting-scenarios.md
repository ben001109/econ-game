# MVP 開局情境與經濟不變量（E-01）

- **狀態：** active
- **決策：** E-01
- **唯一規格來源：** [架構與遊戲決策規格](../../.hermes/plans/2026-07-30_082729-clerk-supabase-game-architecture.md)
- **對應程式碼：** `services/api/src/domains/opening-scenario/`
- **對應測試：** `services/api/src/domains/{money,opening-scenario}/*.test.ts`

## 目的與邊界

本文件將已確認的三種第一間餐廳開局，轉為可被 API domain layer 建立的不可變快照。它不定義客流（E-02）、原料與損耗（E-03）、品質與口碑計算（E-04），或日結與重整公式（E-05）。

M0 不建立資料庫資料、不寫入帳本、不建立 Prisma migration，亦不連接 Clerk、Discord、Worker 或現有 POS/KDS。

## Money 與版本輸入

所有金額以 `Money { currency, minorUnits }` 表示；`minorUnits` 的 canonical wire form 是 base-10 integer string：

- `currency` 必須是三字母大寫 ISO 4217 code 格式。
- `minorUnits` 只接受 `0`、無前導零的正整數字串，或 `-` 加無前導零的正整數字串；不接受 JavaScript `number`、小數、指數格式、前導零、`+` 或 `-0`。
- 這個字串形式可直接 JSON 序列化且不受 JavaScript number 精度限制；`Money` 與開局 snapshot 仍維持 frozen／immutable。
- 本表列出的是已確認的遊戲結算整數基準，M0 直接以 canonical `minorUnits` string 保存。區域貨幣精度、顯示換算、稅率與 rounding snapshot 仍屬 D-01／E-05 的後續工作，M0 不自行補定。
- 每次建立競技存檔都必須提供非空的 `simulationRuleVersion`，用於日後 deterministic replay。

## 已確認情境 catalog

| 情境 | 初始現金 | 本金債務 | 日租金 | NPC／設備 | 初始口碑 | 成熟目標營收 | 前 10 個完成營業日目標損益 |
|---|---:|---:|---:|---|---:|---:|---:|
| `EMPTY_PREMISES`（空白店面） | 32,000 | 0 | 900 | 0 NPC／無設備 | 50 | 4,200 | −300 ～ +550 |
| `DEFAULT_SMALL_SHOP`（預設小店） | 12,000 | 35,000 | 1,000 | 2 NPC／基本設備（帳面值 28,000） | 50 | 5,000 | +100 ～ +400 |
| `TROUBLED_SHOP`（問題店） | 8,000 | 55,000 | 700 | 2 名低士氣 NPC／老舊設備（帳面值 25,000） | 30 | 4,100 | −350 ～ +250 |

附加的已確認條件：

- 預設小店：每 5 個完成營業日還款 1,750。
- 問題店：每 5 個完成營業日還款 2,750；完成有限成本、可見修復路徑後，目標日損益為 +250 ～ +650。
- 空白店面預留約 20,000 作為基本設備 15,000 與押金／首批庫存 5,000 的規劃基準；M0 不把它們建成資產或庫存交易。

## 開局 snapshot contract

`createOpeningSnapshot()` 目前接受：

- `scenario`：只接受上述三個 catalog 值。
- `operatingMode`：只接受已鎖定的競技模式 `STRATEGY` 或 `LIGHTWEIGHT_REALTIME`。
- `currency`：Money 的幣別 code。
- `simulationRuleVersion`：非空版本字串。

輸出為深度 frozen 的純資料快照，包含 scenario、模式、規則版、各 Money 金額、還款安排、整體口碑基準、已確認的設備 condition／帳面值與 NPC 人數／已確認士氣資訊。輸入、catalog 或呼叫端後續 mutation 不得改變既有 snapshot。

完整 snapshot 仍受 [M0 Architecture blockers](../architecture/mvp-first-milestone.md#architecture-blockers不得由-mvp-補值) 約束。M0 不得為設備折舊細節、NPC 合約條款、各口碑維度開局分數、租約條款、完整貸款 schedule 或 display-to-minor-unit conversion 自行補值。

## 不變量

1. 三種情境與其經濟基準是 locked architecture input；不得由 client、AI 或任意 request 重新定價。
2. 問題店初始現金 8,000 足以覆蓋 10 個最壞目標日虧損（10 × 350 = 3,500）。
3. 競技存檔建立後不得切換開局情境或營業模式；排行榜至少以開局情境 × 營業模式分組。
4. 起始資產／設備折舊狀態／NPC 合約、口碑維度、租約與貸款還款表尚未確認的內容是 Architecture blockers；M0 僅保存 E-01 已確認的快照子集，不能以程式預設值取代決策。
5. 相同的 M0 input 與 rule version 必須建構出相等的 snapshot；後續 replay 仍須補入 seed、日結輸入與事件序列。

## 例子

```text
createOpeningSnapshot({
  scenario: "TROUBLED_SHOP",
  operatingMode: "STRATEGY",
  currency: "TWD",
  simulationRuleVersion: "mvp-e01-v1"
})
```

此呼叫不會存取網路、資料庫、queue 或帳本，也不會進行任何金錢 mutation。
