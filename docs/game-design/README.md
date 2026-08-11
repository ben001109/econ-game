# Game Design 文件

本區保存可執行、可校準的遊戲設計規格：規則輸入、公式、狀態機、不變量、資料版本與 replay 要求。敘事、UI 構想或未經確認的點子不應偽裝成規則。

## 目前決策來源

- 完整已確認決策：[架構與遊戲決策規格](../../.hermes/plans/2026-07-30_082729-clerk-supabase-game-architecture.md)
- 決策順序與未決項目：[architecture/decision-register.md](../architecture/decision-register.md)

## 預定文件類型

| 主題 | 對應決策 | 建議檔名 |
|---|---|---|
| 開局情境與經濟不變量 | E-01（已確認） | [starting-scenarios.md](starting-scenarios.md) |
| 客群、需求與客流公式 | E-02 | `demand-model.md` |
| 菜單、原料、採購與損耗 | E-03 | `inventory-and-procurement.md` |
| 服務、品質與多維口碑 | E-04 | `service-quality-and-reputation.md` |
| 日結、失敗、救濟與重整 | E-05 | `daily-close-and-recovery.md` |

## 文件最低要求

每份規則規格都必須包含：輸入與單位、輸出、版本識別、deterministic seed／隨機性、邊界條件、不可違反的不變量、例子與對應測試情境。涉及金錢、契約或市場的規則，還要連結 ledger／audit／replay 要求。
