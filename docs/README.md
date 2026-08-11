# Econ Game 文件導覽

> 文件階段：架構與遊戲設計確認；尚未進入正式 MVP implementation。

本目錄只保存可版本控制、可審查的產品與工程文件。確認過的遊戲決策不在導覽文件中重述；導覽只連結其唯一來源，避免產生第二份真相。

## 來源與優先順序

1. `.hermes/plans/2026-07-30_082729-clerk-supabase-game-architecture.md`：目前已確認架構與遊戲決策的完整規格來源。
2. `architecture/decision-register.md`：已確認決策、未決議題與決策順序的索引。
3. 各分類下經審查、標示狀態與日期的文件：補充規格、ADR、runbook 與測試策略。

若文件互相矛盾，先停止實作或更新，並以第 1 項規格與最新確認的決策為準。

## 資訊架構

| 區域 | 用途 | 入口 |
|---|---|---|
| `architecture/` | 系統邊界、domain model、資料／安全／整合與決策索引 | [architecture/README.md](architecture/README.md) |
| `game-design/` | 可執行的遊戲規則、經濟公式、狀態機與內容設計 | [game-design/README.md](game-design/README.md) |
| `adr/` | 已決定且需要保留背景、取捨與影響的架構決策紀錄 | [adr/README.md](adr/README.md) |
| `runbooks/` | 可操作、可演練的部署、事故、復原與封測流程 | [runbooks/README.md](runbooks/README.md) |
| `testing/` | 測試策略、品質門檻、情境、invariant 與演練證據 | [testing/README.md](testing/README.md) |
| `sdk/` | 現有 HTTP surface 的內部 SDK、型別邊界與可離線驗證 | [sdk/README.md](sdk/README.md) |
| `developer-platform/` | 全技術棧 inventory、runtime／CI 事實與 package 邊界 | [developer-platform/README.md](developer-platform/README.md) |
| `skills/` | 官方工程來源、可重用 Hermes skills、開發平台路線圖與驗證索引 | [skills/source-map.md](skills/source-map.md)；[developer-platform-roadmap.md](skills/developer-platform-roadmap.md) |

## 撰寫規則

- 使用 Markdown；檔名採 `kebab-case`，日期採 ISO `YYYY-MM-DD`。
- 每份正式文件標示 `狀態`、`擁有者`、`最後更新`、`相關決策`；模板已提供欄位。
- 新決策先更新完整規格與決策索引；需要保留可替代方案與後果時，再建立 ADR。
- 文件只描述已確認事實與明確假設；未決事項標示為「待決」。
- 不在文件中放入密鑰、token、連線字串、個資或可用憑證。
