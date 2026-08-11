# MVP M0：開局經濟契約與可重播快照

> **狀態：** E-01 完整 Architecture contract 已確認；M0 bounded code 待 E01-S-01 擴充
> **擁有者：** MVP（Architecture 為唯一決策 gate）
> **最後更新：** 2026-08-07
> **相關決策：** E-01；版本／hash 語意與 D-01、D-03 對齊

## 目標

把已確認的三種開局輸入與完整 immutable snapshot 落成**不依賴資料庫、可純函式測試**的 TypeScript domain contract。E01-S-01 只實作 E-01 opening state、Money conversion、版本與 deterministic hash，不實作 E-02～E-05 的營業日行為。

## 先決條件

1. 已以 repo 宣告的 Node 20.20.2 工具鏈驗證 install、`prisma generate --no-engine`、M0 tests 與 API build；Prisma generate 約 37 ms（整體 command 約 1.01 秒）。
2. `docs/architecture/decision-register.md` 的 E-01 與完整架構計畫同步為「已確認」。
3. 不建立或套用 Prisma migration，不連線或改寫資料庫，不執行 `db push`。
4. API 已新增最小 `test` script；Frontend、Worker、Bot 仍無 `test` script，不能視為跨服務測試通過。

## 交付範圍

### Domain contract

建議建立：

- `services/api/src/domains/opening-scenario/types.ts`
- `services/api/src/domains/opening-scenario/catalog.ts`
- `services/api/src/domains/opening-scenario/create-opening-snapshot.ts`
- `services/api/src/domains/money/*`

Contract 只涵蓋：

- `OpeningScenario`: `EMPTY_PREMISES`、`DEFAULT_SMALL_SHOP`、`TROUBLED_SHOP`
- `Money`: supported ISO 4217 currency code + canonical base-10 integer minor-unit string；禁止 JavaScript `number`、浮點、前導零與負零
- `CurrencyMetadata`: server-registry code、`minorUnitExponent`、`currencyMetadataVersion`；E-01 display integer 以 arbitrary-precision integer 乘 `10^exponent`
- 完整 immutable `OpeningSnapshot`: stable logical asset／liability identity、設備折舊、NPC contract、五維名譽、租約、20 期貸款 schedule、planning allocations、版本與 `openingSnapshotHash`
- `snapshotSchemaVersion="opening-snapshot/v1"`、`openingCatalogVersion="mvp-e01-opening-v2"`、registry-resolved `currencyMetadataVersion`／`simulationRuleVersion`
- allowlisted scenario／mode／currency、server-owned versions、canonical ordering／serialization 與深度 immutable validation

### 已確認的 E01-S-01 contract（不得另行補值）

以下缺口已由 Architecture 定案；現有 M0 bounded code 仍只承載舊子集，實作者必須依完整架構計畫擴充，不得保留舊欄位語意或自行選值：

| 要求 | 已確認 contract |
|---|---|
| 初始 identity／資產 | stable keys：`cash:settlement`、`lease-deposit:opening`、有設備時 `equipment:opening-bundle:1`、有貸款時 `loan:opening:1`；期初庫存為空，planning allocation 不是資產或 ledger movement |
| 設備 | 預設小店：原值 32,000、累折 4,000、帳面 28,000、殘值 8,000、120 日直線法、已用／剩餘 20／100、每日 200、倍率 1.00、品質 0；問題店：40,000／15,000／25,000／4,000、已用／剩餘 50／70、每日 300、倍率 0.85、品質 −10；空白店無設備；唯一值須與 E-04 一致 |
| NPC contracts | 預設：`KITCHEN` 650、`CASHIER` 550，`MEDIUM/NORMAL`；問題店：750／650，`MEDIUM/LOW`。皆涵蓋 locked service periods、day 1–30、per completed scheduled day、bonus／profit share 0；空白店無 NPC。opening snapshot 保存 morale enum 與 `simulationRuleVersion`；E-04 唯一解析為 NPC `LOW/NORMAL/HIGH = 0.90/1.00/1.10`，不得另存或疊加 pool morale multiplier；MVP PLAYER 固定 1.00 |
| 五維名譽 | `QUALITY/SPEED/PRICE/FAIRNESS/VIBE`：空白店與預設小店各維 50，問題店各維 30；overall 為五維 `roundHalfUp` 平均 |
| 租約 | stable lease／premises key，day 1–30、每日 DayEnd 收租；deposit 為日租 2 倍（1,800／2,000／1,400）且 opening 時已 held、不可重複扣 starting cash；term 內不調租，續約最多 +10%、提前 5 日通知並確認 |
| 空白店 allocations | 原 5,000 精確拆為 held deposit 1,800＋`initialInventoryBudget` 3,200；另有 `basicEquipmentBudget` 15,000；budget 不是既有資產 |
| 貸款 | 預設／問題店均為 0 bps、20 期等額本金，due day 5,10,…,100，分別每期 1,750／2,750；每筆逾期費 500 bps、minor units `roundHalfUp`、不複利；每筆貸款僅首次 missed due 有一次 1 日 grace |
| Money conversion | 架構表數值是整數 major/display units；`minorUnits = displayInteger × 10^minorUnitExponent`。unsupported currency、client exponent、fractional display input 全拒絕；相同 snapshot 只用一個 settlement currency |
| versions／hash | schema、opening catalog、currency metadata、simulation rule 四版皆由 server registry resolve；canonical payload 無 timestamp／UUID／DB ID，logical-key 排序並以 SHA-256 產生 hash；舊 snapshot 不 silent migrate 或 latest-version fallback |

完整數值、公式、immutable 更新邊界與 canonical hash 語意以[完整架構計畫](../../.hermes/plans/2026-07-30_082729-clerk-supabase-game-architecture.md)的「E-01 完整 OpeningSnapshot contract」為唯一規格來源。

### Tests

至少證明：

- catalog 恰有三種 scenario，且 currency exponent 0／2 分別把 32,000 轉成 `"32000"`／`"3200000"`；unsupported currency、client exponent、小數與不 canonical Money 被拒絕。
- 空白店面無債務、設備、NPC 或期初庫存；只有 cash、held lease deposit 與兩個非資產 planning allocations，且 1,800＋3,200＝5,000。
- 兩個設備 bundle 均滿足原值－累折＝帳面值、直線折舊／殘值／剩餘日數，並精確輸出 1.00／0.85 容量倍率與 0／−10 品質修正；其他品質修正 fixture 必須失敗。
- 四份 NPC contract 具 stable identity、role、salary、shift、day 1–30 term、morale／capability 與 zero bonus／profit share；問題店 LOW NPC 只解析為 0.90，snapshot／fixture 不得含第二個 pool morale multiplier；empty scenario contracts 為空。
- 三個 scenario 的五維名譽精確為 50／50／30，overall 平均不改變既有基準。
- 三份 lease 的 rent、2× deposit、day 1–30、調租 cap／notice 與 held deposit 不重複扣現金不變量皆成立。
- 預設小店與問題店各有 20 筆 immutable installment，due day 為 5..100、principal sum 等於 35,000／55,000，interest 0、late fee 500 bps、首次 grace 1 日。
- 問題店初始現金符合規格中的約十個最壞目標虧損 runway。
- caller mutation 不能改變已建立 snapshot。
- 未知 scenario、未鎖定模式、缺少或 registry 不認得的任一版本被拒絕。
- 相同 canonical input＋四個版本產生 byte-identical payload 與 SHA-256 hash；wall-clock／random／persistence metadata 不進入 hash，array 順序固定。

## 明確非目標

- Restaurant、Player、IdentityLink、Membership、Ledger、Audit、Outbox 的 Prisma schema。
- migration、RLS、Clerk、Supabase、Discord、BullMQ 或 UI integration。
- 修改既有 demo POS/KDS、client supplied totals 或 bootstrap 路徑。
- 實作 E-02～E-05 的客流、採購、服務、名譽更新、DayEnd、風險或救濟行為。

## 驗收

```text
Node 20 下 prisma generate 在明確 timeout 內完成
M0 targeted tests 全數通過
API build 通過
四個 service 的既有 lint gate 狀態被明確記錄
沒有 Prisma migration 產生
沒有資料庫連線／寫入或 db push
沒有 E-02～E-05 規則進入 code
最後 git diff --check 通過
```

## 後續依賴順序

1. `E01-S-01` 可立即派發：只擴充 pure-domain opening catalog／snapshot／Money metadata／tests，不碰 schema、API route 或 persistence。
2. E01-S-01 通過後，D-01 aggregate／schema story 才能引用完整 opening snapshot contract。
3. D-02/D-03 的 mutation、ledger／outbox／worker replay 消費同一 canonical snapshot／version/hash 語意。
4. D-04/D-05 保持各自已核准的 security／governance scope，不是 E01-S-01 的實作內容。
