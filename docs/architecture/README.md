# Architecture 文件

本區描述 Econ Game 的技術與 domain 架構；不重複記錄遊戲數值、未確認方案或 implementation task。

## 現有文件

| 文件 | 狀態 | 用途 |
|---|---|---|
| [decision-register.md](decision-register.md) | 活躍 | 已確認架構基線、未決決策與決策順序索引 |
| [../../.hermes/plans/2026-07-30_082729-clerk-supabase-game-architecture.md](../../.hermes/plans/2026-07-30_082729-clerk-supabase-game-architecture.md) | 活躍 | 目前完整架構與遊戲決策規格來源 |
| [mvp-first-milestone.md](mvp-first-milestone.md) | 已審查 | 第一個窄範圍、無資料庫 mutation 的 MVP 可執行 handoff |

## 預定文件類型

| 主題 | 建檔時機 | 建議檔名 |
|---|---|---|
| Domain model 與 aggregate 邊界 | E-01～E-05 已定稿後 | `domain-model.md` |
| API、狀態機與一致性契約 | 每個 mutation contract 定稿時 | `state-machines.md` |
| 資料、授權與整合邊界 | 身份、RLS 或 Bot actor 設計定稿時 | `data-and-authorization.md` |
| 經濟 replay、ledger、outbox 與 worker | 事件與 simulation version 定稿時 | `eventing-and-replay.md` |

新文件應連結相關 ADR、決策 ID 與測試文件；不得把未確認的 schema 或 API 當作既定事實。
