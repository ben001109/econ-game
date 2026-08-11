# Testing 文件

本區定義如何證明已確認規格正確，而非保存某次 CI 的短暫結果。測試策略、可重現情境與演練證據必須可追溯至規則、ADR 或 runbook。

## 品質層次

| 層次 | 證明內容 | 預定範圍 |
|---|---|---|
| Unit／property | Money、公式、狀態轉移與不變量 | 經濟規則與 domain services |
| Integration | transaction、ledger、outbox、worker 與資料庫邊界 | API、PostgreSQL／Supabase、Redis |
| Authorization／RLS | 跨玩家／餐廳隔離與角色權限 | Clerk、Fastify RBAC、Supabase RLS、Bot actor |
| E2E | Web 與 Discord 的共用 state transition | 建店、營業、日結、帳號連結等已核准流程 |
| Load／resilience | queue、market tick、replay、backup restore 與故障恢復 | 公開測試／上線門檻 |

## 預定文件

| 主題 | 建檔時機 | 建議檔名 |
|---|---|---|
| 全域品質門檻與 CI gates | O-02 定稿時 | `quality-gates.md` |
| 經濟 invariant 與 replay 情境 | E-01（active）；E-02～E-05 定稿後擴充 | [economic-invariants.md](economic-invariants.md) |
| 授權與跨租戶測試矩陣 | D-04／D-05 定稿時 | `authorization-matrix.md` |
| 災難復原與演練驗收 | O-03 定稿時 | `resilience-drills.md` |

## 模板

複製 [test-spec-template.md](test-spec-template.md) 建立可審查的測試規格。
