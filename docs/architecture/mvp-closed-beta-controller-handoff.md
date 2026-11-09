# Econ Game MVP 封測主控交接稿

> **狀態：** Engineering in progress；Architecture ready，但九項 release gates 尚未全部通過
>
> **最後更新：** 2026-08-18
>
> **唯一完整規格：** [Clerk + Supabase 遊戲架構計畫](../../.hermes/plans/2026-07-30_082729-clerk-supabase-game-architecture.md)
>
> **決策與 Story 索引：** [架構決策總表](decision-register.md)
>
> **2026-11-08 主線調整：** 主線改為 Discord 優先的 `discord-first` 分支，Web 前端延到 M2。本文件以下內容為 2026-08-18 的進度紀錄，提到的 Web 端與雙端條件需依決策總表 PLAT-01～03 重新確認。目前方向見 [roadmap](../roadmap.md)。

## 0. 主控實作進度

| Story | 狀態 | 直接證據 |
|---|---|---|
| `E01-S-01` 完整開局 snapshot | 已實作、targeted 驗收通過 | Money／OpeningSnapshot targeted tests 17/17；catalog `mvp-e01-opening-v2`、四版 registry、canonical SHA-256、deep immutability 與三情境完整 contract 均有測試 |
| `E04-S-01` 服務／流量引擎 | 已實作、targeted 驗收通過 | E-04 targeted tests 10/10；K/F contribution replay、候位／售罄、tick workflow 與 `FLOW_RISK_HIGH` 均通過 |
| `E04-S-02` 品質與五維名譽 | 已實作、targeted 驗收通過 | contribution-scoped LOW KITCHEN penalty、AGED `−10`、foodQuality／serviceSpeed／五維名譽與 byte-identical replay 均通過 |
| `E02-S-01` 需求預報與客群排程 | 已實作、整合測試通過 | 三情境二／三時段需求、客群／組數、天氣／價格邊界、預報 disclosure、seed schedule 與結算後 replay 均納入 API full suite |
| `E02-S-02` 配置容量與 flow 指標 | 已實作、domain 驗收通過 | `e02-space-v1` 三情境 limits、30／34／27 人尖峰、cap 邊界、配置時窗／尖峰鎖定、layout hash 與 deterministic raw metrics 均有測試；`e02-e04-floor-flow-v1` 將真實座位／候位與走道負荷以 deterministic 前場延遲接入 E-04，不改變需求、食材或既定 K/F 規則。 |
| `E03-S-01/02` 菜單、庫存、損耗與採購 | domain 驗收通過；持久化前置 source/static 審查通過 | `e03-storage-capacity-v1`、移動平均成本／損耗、現貨與 take-or-pay reservation、market snapshot 與 OpenDay snapshot 均有直接測試；另有 inventory pool／成本池、command／ledger provenance、service-only market seed、Day-1 MarketTick command/job provenance、RLS 與 fail-closed rollback migration 的獨立審查。PostgreSQL runtime migration／RLS／延遲約束仍待補，且尚未接入 CONFIGURE／OPEN durable handler。 |
| `E05-S-01/02` | 已實作、targeted 驗收通過 | E-05 targeted tests 18/18；固定日結欄位、episode baseline、狀態 counters、次日 revenue gate 與 `e05-risk-penalty-v1` replay 證據均通過 |
| `E05-S-03` 封測交付閘門 | pure-domain 與 replay verification source/static contract 已完成；跨端整合待辦 | `mvp-release-evidence-v1` 依 sequence／simulation rule version 計算 eventHash，依完整 E-05 fixed fields／risk／reputation／final resource versions 計算 snapshotHash；Web／Discord 任一 hash 不同即 fail closed。`REQUEST_DAY_REPLAY` 現有 durable request／outbox／worker verification source/static path，並以同一 runtime hash module 重算 `MATCH`／`MISMATCH`；仍缺上游 durable 日結 evidence、PostgreSQL runtime、真實雙端與 staging 證據。 |
| `D01-S-01` aggregate persistence／RLS | migration 與 source/static 驗證完成；PostgreSQL runtime 待補 | migration 以 tenant-scoped composite FK、防跨租戶關聯、RLS 與 service-only write 建模；靜態合約已通過。真實 PostgreSQL migration／RLS integration 仍是 release evidence 缺口。 |
| `D02-S-01` 統一 mutation contract | 已實作、API contract 驗證通過 | 2026-08-18 API full suite 220/220 包含 Fastify HTTP envelope、idempotency、version、legacy default 404 與 persistence fail-closed 測試。遊戲六命令尚未全部接入 durable handler。 |
| `D03-S-01/02` ledger、outbox、job／版本 replay | migration 與 source/static 驗證完成；PostgreSQL runtime 待補 | 雙分錄／outbox、lease/retry/DLQ、market tick 及 versioned replay contract 已具 migration/static 證據；Day replay request／artifact／worker verifier 已有 source/static 證據。真實 PostgreSQL runtime 與產生 `ReplayEvent`／`DayEndSnapshot` 的上游營業日 producer 仍未完成。 |
| `D04-S-01` identity、RLS、Discord actor | 已實作、API contract 驗證通過；真實 provider/staging 待補 | JWT/JWKS validation、server-derived scope、Discord link、Bot principal 與 fail-closed production composition 均由 API suite 覆蓋；真實 Clerk／Supabase／Discord composition 仍待 staging evidence。 |
| `D05-S-01/02` cohort、invite、wipe | source/static contract 驗證完成；durable runtime／演練待補 | invite、consent、eligibility、wipe authority／scope／lease 與 guarded rollback 已有 API/static 證據；PostgreSQL runtime、clear executor 與 staging wipe-resume drill 未完成。 |
| `O02-S-01` CI/CD release gates | 本地基線已實作；promotion 證據待齊 | 靜態 migration/persistence contracts 2026-08-18 為 69/69；migration safety 95 個可執行／設定檔通過。supply-chain checker 目前正確 fail-closed：OCI signature／attestation／layer-CVE evidence 缺失。實際 CI、RLS／E2E／雙 hash／rollback evidence 仍待相依 Story 與 O-01 環境。 |
| `O03-S-01` 最小營運與復原 | 本地 runbook／fail-closed registry 已完成；staging drills 待辦 | 已建立事故分級／feature-flag freeze、隔離 backup restore、market／replay rebuild、cohort 與 wipe fail／resume runbooks；promotion registry 強制要求 incident、restore、rebuild、wipe-resume 四項 immutable evidence。checker 目前因未演練而正確阻擋；實際 drills 依賴 O-01、D-03、D-05 |

上述 source、unit 與 static evidence 只完成對應契約，不代表任何封測 Gate 已通過；Gate 仍須待 durable PostgreSQL runtime、跨端整合、staging drill 與最終 E2E 的直接證據齊備。

## 1. 主控結論

1. E-01～E-05 與 D-01～D-05 均已確認並同步至兩份權威文件。
2. D-01 的封測一致性固定採 `ReplayEvent` eventHash＋`DayEndSnapshot` snapshotHash 雙層 SHA-256；任一不一致即阻擋放行。
3. A-01 不是核心經濟封測阻擋；AI feature flag 維持關閉，延後至 AI cohort 啟用前完成。
4. A-02 延後 Beta；MVP 不開放公開 UGC、圖片／Logo／菜單資產、公開評論或申訴。
5. O-01、O-02、O-03 是受邀 MVP 封測的 P0 阻擋項；O-01 仍需要使用者指定雲端帳號、billing owner、region 與 platform owner。
6. P0-PLAT-01 的 save-scoped gameplay RBAC 已由 catalog 導出並保持未實作命令 fail-closed；仍缺六個遊戲命令的 durable orchestration，不能當成已可玩的流程。
7. 本交接只記錄可重跑的本地證據，不把 source/static 測試當作 production、staging 或封測放行證據。

## 2. 歷史初始派發（不代表目前尚未實作）

| Story | Owner | 優先級 | 估時 | DoD |
|---|---|---:|---:|---|
| `E01-S-01` 完整開局 snapshot | `gameplay-core` | P0 | 2–3 天 | 三情境完整 snapshot 包含資產／設備、NPC 合約、名譽、租約、還款、Money conversion 與 rule version；canonical input 重放一致。 |
| `E04-S-01` 服務／流量引擎 | `gameplay-core` | P0 | 1–2 天 | 同 seed 可重放售罄改點、候位離開與服務 tick；`queue/demand > 1.2` 產生 `FLOW_RISK_HIGH`。 |
| `E04-S-02` 品質與五維名譽 | `gameplay-core` | P0 | 1.5–2 天 | `foodQuality`、`serviceSpeed` 與五維名譽皆在 0–100；相同 seed 的完整軌跡一致且可 replay。 |

兩項可共用已確認的 E-04 pure-domain 規則並行；若共享模型尚未固定，由 Owner 先協調邊界，不得自行改寫公式。

## 3. 歷史 Story 矩陣（以第 0 節現況為準）

| Story | Owner | 優先級 | 估時 | 主要依賴 | DoD 摘要 |
|---|---|---:|---:|---|---|
| `O01-S-01` 封測環境與 secrets 基線 | `platform-infra` | P0 | 3–4 天 | 雲端帳號、region、billing owner 授權 | 環境隔離；最小權限 principals；集中 secrets、rotation／revocation 與 access audit。 |
| `D01-S-01` Aggregate persistence／RLS | `data-platform` | P0 | 4–5 天 | `O01-S-01` | 最小 family、FK／歷史保留、unique／tenant indexes、RLS/API-only write、跨租戶拒絕與可審查 migration；不使用 `db push`。 |
| `D02-S-01` 統一 mutation contract | `api-platform` | P0 | 3–4 天 | `D01-S-01` | 共用 envelope；server-derived actor；idempotency／version；同步／job；`409`／`422` integration tests。 |
| `D04-S-01` Clerk、RLS、Discord actor | `identity-security` | P0 | 4–5 天 | `D01-S-01` | JWT／RBAC、RLS isolation、一次性 link、Bot principal；跨租戶與未連結測試拒絕。 |
| `D03-S-01` Ledger＋transactional outbox | `economic-platform` | P0 | 4–5 天 | `D02-S-01` | 雙分錄平衡、補償事件、aggregate／ledger／outbox 原子寫入，重送不重複入帳。 |
| `D03-S-02` Job、market tick、版本 replay | `simulation-platform` | P0 | 3–4 天 | `D03-S-01` | lease reclaim、最多 5 次暫時錯誤 retry、DLQ audit、唯一 tick、歷史版本 replay。 |
| `E02-S-01` 需求預報與客群排程 | `simulation-core` | P0 | 3–4 天 | `E01-S-01` | 二／三時段、三情境客流、客群／耐心／天氣／價格與預報誤差依 E-02；第一日無 VIP；同 seed replay 一致。 |
| `E02-S-02` 配置容量與 flow 指標 | `gameplay-core` | P0 | 2–3 天 | `E02-S-01`、`E04-S-01` | 配置時窗／尖峰鎖定及距離、壅塞、候位指標 deterministic；不做 NPC 尋路。 |
| `E03-S-01` 菜單、庫存、成本與損耗 | `economic-engine` | P0 | 4–5 天 | `E01-S-01` | recipe/menu、庫存容量、替代、移動平均成本、損耗與價格轉換可 snapshot／replay。 |
| `E03-S-02` 採購、合約與市場輸入 | `economic-engine` | P0 | 3–4 天 | `E03-S-01`、`D03-S-02` | 現貨／take-or-pay、供應價 snapshot、付款與違約輸入可 replay；不偷渡 Beta 物流。 |
| `E05-S-01` 日結公式 | `economic-engine` | P0 | 2–3 天 | `E04-S-01/02` | 固定日結欄位完整；`shortfall` event 可追蹤與重放。 |
| `E05-S-02` 風險狀態機 | `economic-engine` | P0 | 1–2 天 | `E05-S-01` | `DELINQUENT／RESOLUTION／REHAB` 與名譽崩盤轉換可 replay。 |
| `D05-S-01` Cohort／Invite／Consent／Eligibility | `release-platform` | P0 | 3–4 天 | `D04-S-01` | 邀請與名額原子驗證、可撤回 consent、非競技 eligibility 與完整 audit。 |
| `D05-S-02` WipeBatch workflow | `release-platform` | P0 | 3–4 天 | `D03-S-02`、`D05-S-01`、`O01-S-01` | 雙人覆核、公告、freeze、resume-safe wipe、舊狀態隔離、hash／count verify。 |
| `O03-S-01` 最小營運與復原 runbook | `release-ops` | P0 | 3–4 天 | `O01-S-01`、`D03-S-02`、`D05-S-02` | 事故、feature flag、restore、rebuild、wipe fail/resume 可演練；staging drill 留證。 |
| `O02-S-01` CI/CD release gates | `platform-qa` | P0 | 4–5 天 | 所有核心 P0 Story | lint、typecheck、unit／invariant、integration、RLS、E2E、併發／重送與雙層 hash 自動阻擋 promotion。 |
| `E05-S-03` 封測交付閘門 | `release-ops` | P0 | 0.5–1 天 | `E05-S-01/02`、`O02-S-01` | 固定欄位、狀態事件、雙層 hash 與雙端一致性皆可稽核。 |
| `P0-PLAT-01` Web／Discord E2E | `platform-qa` | P0 | 2–3 天 | `E05-S-03`、`D04-S-01`、`D05-S-02` | `開店→營運→日結→wipe→replay` 每步快照一致，關鍵欄位缺漏率 0%。 |

## 4. 唯一仍待外部決策

`O01-S-01` 在真正建立封測環境前，需要產品／帳務 Owner 指定：

1. 可供封測使用的雲端帳號或 organization。
2. billing owner 與成本告警接收者。
3. staging／封測 region。
4. secrets 與部署環境的最終 platform owner。

此決策阻擋封測環境與所有依賴它的 Story，但不阻擋 E-04 pure-domain 工作、文件、contract 測試設計或本地無副作用驗證。選擇供應商前不得建立付費資源或讀取／搬移任何 credential。

## 5. MVP 封測放行門檻

| Gate | 必要證據 | 關聯 Story | 目前狀態 |
|---|---|---|---|
| 遊戲流程 | 完整開局 snapshot、需求預報／客群、配置 flow、售罄改點、候位、服務 tick、品質與名譽 deterministic replay | `E01-S-01`、`E02-S-01/02`、`E04-S-01/02` | 部分完成：E01、E02、E04 與 `e02-e04-floor-flow-v1` pure-domain bridge 可重放；尚未由 durable command orchestration 串成一個玩家可操作的營業日。 |
| 經濟結算 | 菜單／庫存／採購輸入、固定日結欄位、雙分錄平衡、shortfall 與風險狀態可重放 | `E03-S-01/02`、`E05-S-01/02`、`D03-S-01` | 部分完成：E03/E05 與 D03 source/static contract 可驗證；尚無一條 durable command transaction 串起完整日結。 |
| Replay 一致性 | 同 seed／rule version 的 eventHash 與 snapshotHash 雙層一致；缺歷史版本明確阻擋 | `D03-S-02`、`E05-S-03` | 部分完成：雙 hash pure-domain、Day replay request／artifact／worker verifier 與 job/outbox source/static contract 已有；日結 evidence producer、PostgreSQL runtime 與跨端證據未完成。 |
| Web／Discord 一致性 | 兩端使用同 API／state machine；完整流程快照與結果一致 | `D02-S-01`、`D04-S-01`、`P0-PLAT-01` | 未實作 |
| 身份與安全 | aggregate tenant boundary、Clerk JWT、server-derived RBAC、RLS isolation、一次性 Discord link、Bot 最小權限 | `D01-S-01`、`D04-S-01` | 部分完成：來源與 API contract 可驗證；真實 PostgreSQL RLS 與 Clerk/Supabase/Discord staging composition 未驗證。 |
| 邀請與 wipe | cohort allowlist、可稽核 invite、雙人覆核 wipe、resume／verify、歷史隔離 | `D05-S-01/02` | 部分完成：source/static contract 可驗證；真實 PostgreSQL、clear executor 與 staging wipe-resume drill 未完成。 |
| 環境與 secrets | staging／封測隔離、Owner、最小權限 principal、集中 secrets 與撤銷路徑 | `O01-S-01` | 外部決策阻擋 |
| CI/CD | 所有必要測試自動執行；failure 不得 promotion；rollback 可用 | `O02-S-01` | 部分完成：fail-closed workflows／evidence registry／migration scan 已實作；實際 CI 與 staging rollback 證據待相依 Story／O-01 |
| 可觀測性與復原 | correlation／audit、告警、backup restore、market/replay rebuild、wipe fail/resume 演練 | `O03-S-01` | 部分完成：最小 runbooks 與 fail-closed evidence gates 已建立；staging incident／restore／rebuild／wipe-resume drills 待 O-01、D-03、D-05 |

只有九項 Gate 都具備可查核證據，才可將狀態從「Architecture ready」改為「MVP closed-beta releasable」。

## 6. 延後且不得偷渡進 MVP

| 項目 | 時點 | 重新啟動條件 |
|---|---|---|
| `A01-S-01` AI cohort safety baseline | AI cohort 前 | 產品決定開啟開店設計師或營運顧問；先完成 provider、成本／速率熔斷、fallback、retention 與 audit。 |
| `A02-S-01` 公開 UGC 治理 | Beta | 任何公開圖片、Logo、菜單素材、評論、檢舉或申訴進入範圍前。 |
| 全域真實時間共享市場 | Beta／正式版 | 個人存檔營業日 market tick 已穩定且另有市場架構決策。 |
| 完整城市、供應鏈、股市與公司治理 | 正式版 | MVP／Beta 門檻完成並另行規劃。 |

## 7. 歷史主控派發順序（已被現況取代）

1. 立即平行派發 `E01-S-01`、`E04-S-01`、`E04-S-02`；同時取得 O-01 外部決策並開立 `O01-S-01`。
2. `E01-S-01` 後平行執行 `E02-S-01`、`E03-S-01`；`O01-S-01` 後執行 `D01-S-01`；E-04 完成後接 `E05-S-01/02`。
3. `D01-S-01` 後平行執行 `D02-S-01`、`D04-S-01`；再接 `D03-S-01/02`、`E02-S-02`、`E03-S-02`。
4. `D04-S-01` 後執行 `D05-S-01`；`D03-S-02`、`D05-S-01`、`O01-S-01` 齊備後執行 `D05-S-02`，再完成 `O03-S-01`。
5. 所有核心 P0 Story 齊備後執行 `O02-S-01`、`E05-S-03` 與 `P0-PLAT-01`，收集九項 Gate 證據。

每張 ticket 使用 [Codex task 路由 Prompt 模板](../skills/templates/codex-task-routing-prompts.md)，包含 Route、model／effort、Agent cap、權威輸入、禁止範圍、DoD、驗證與升級條件。

## 8. 主控停止條件

- 規格矛盾：交回 Architecture Decision Lab，不由 Executor 自行改規則。
- 缺 Owner／外部授權：保留 ticket 為 blocked，不建立資源、不讀 secrets。
- 驗證失敗兩次：停止盲目重試，改開診斷 Story。
- 任一 Gate 缺直接證據：不得宣稱可投放封測。
