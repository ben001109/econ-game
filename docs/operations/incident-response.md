# MVP 封測事故應變 Runbook

- **狀態：** draft；待 O-01 owner／聯絡路徑與 staging 演練後啟用
- **Owner：** `release-ops`（最終 platform owner 由 O-01 指定）
- **最後更新：** 2026-08-07
- **最後演練：** 尚未演練
- **適用環境：** staging、受邀 closed-beta

本文件只定義可審查流程，不授權部署、讀取 secret、直接修改資料庫或執行 wipe。

## 事故分級

| 等級 | 判定 | 初始動作 |
|---|---|---|
| `SEV-0` | 跨租戶資料暴露、身份繞過、secret 外洩、不可控重複入帳或歷史資料破壞 | 立即凍結所有 mutation 與邀請；保留 read-only 狀態；通知 platform owner、security owner、billing owner |
| `SEV-1` | 日結／ledger／replay hash 不一致、wipe 卡住、主要 Web 與 Discord 流程同時不可用 | 停用受影響功能；停止 cohort 擴大；建立 incident timeline |
| `SEV-2` | 單一 client 降級、非經濟性顯示錯誤、可安全 fallback 的 worker 延遲 | 保留核心流程；停用受影響 feature flag；於當日 health review 追蹤 |

無法判定時向較高等級處理。正式聯絡人與替補不得硬編碼於 repo，應由 O-01 的受管 owner registry 提供。

## 角色與稽核

- `Incident Commander`：唯一決策窗口；宣告等級、scope、解除與事後檢討。
- `Operator`：依核准步驟操作 feature flag、traffic freeze 或 restore；不得同時擔任高風險動作 approver。
- `Communications`：更新受邀 cohort 與內部狀態頁，不揭露 secret、個資或可利用細節。
- `Scribe`：記錄 UTC 時間線、correlation ID、變更、核准、查核結果與 artifact URL。

每次事件必須建立穩定 `incidentId`。所有變更記錄 `incidentId`、actor、approver、環境、before／after、reason、correlation ID 與時間。

## 前提與禁止事項

1. 只使用受管 feature flag 與平台控制面；不得修改 client bundle 來假裝停用 server capability。
2. 不得使用 `prisma db push`、未審查 migration、直接刪除歷史資料或覆寫 append-only event。
3. 不得將 service-role key、Discord token、Clerk secret、資料庫 URL 或完整玩家資料貼入 ticket／聊天。
4. `SEV-0`、restore、wipe resume 與人工經濟補償需要兩人覆核。

## 應變流程

1. 建立 `incidentId`，保存第一個告警、候選 commit SHA、環境、受影響 cohort 與 correlation IDs。
2. 依分級選擇最小封鎖面：
   - 身份／RLS 疑慮：凍結所有 mutation、邀請、link／relink。
   - 經濟／replay 疑慮：凍結開日、訂單推進、日結與 reward；保留讀取與 evidence export。
   - wipe 疑慮：維持 cohort freeze，不啟動新 `WipeBatch`，轉入 beta runbook 的 fail/resume 流程。
   - 單一 client 故障：只停用該 client mutation，另一 client 不得改用本地計算繞過 API。
3. 保存診斷證據：API request ID、job ID、aggregate version、idempotency key hash、eventHash、snapshotHash、worker attempt／DLQ ID；不得保存 raw token。
4. 由 Commander 選擇：安全 rollback、forward fix、backup restore、replay rebuild 或持續 freeze。資料庫 migration 不得隨 application rollback 靜默回退。
5. 在 staging 重現並通過相應 Gate 後，才可由兩人覆核解除 closed-beta freeze。
6. 24 小時內建立 follow-up：根因、影響範圍、偵測缺口、補償事件、owner 與期限。

## 解除條件

- 身份／RLS：跨租戶與未連結 Discord 測試重新通過。
- 經濟：重送／併發測試通過，ledger 平衡，eventHash 與 snapshotHash 均一致。
- restore／rebuild：依 backup runbook 完成 count、hash、版本與 audit 驗證。
- wipe：同一 `WipeBatch` 從 checkpoint 安全續跑且 verify phase 通過。
- client：Web／Discord 使用相同 API state machine 的 E2E 重新通過。

## 演練證據

演練結果必須寫入 closed-beta evidence registry，包含 candidate SHA、`incidentId`、環境、開始／結束 UTC、參與角色、觸發、freeze flag audit、復原方式、驗證結果與不可變 artifact URL。未演練或 artifact 缺失時，promotion 必須失敗。
