# MVP 受邀封測營運與 Wipe Runbook

- **狀態：** draft；待 O-01、D-05 與 staging drill 完成後啟用
- **Owner：** `release-ops`
- **最後更新：** 2026-08-07
- **最後演練：** 尚未演練

## 開放與擴大條件

1. candidate workflow 綁定精確 commit SHA，所有 closed-beta evidence 為 `verified`。
2. O-01 account、billing、platform／backup owner、region、secrets rotation／revocation 均已確認。
3. invite cohort 有固定名額、時窗、功能旗標與 eligibility policy version。
4. staging 完成 incident、backup restore、market／replay rebuild、rollback 與 wipe fail/resume 演練。
5. AI feature flag 預設關閉；MVP 不開放公開 UGC。

任一條件不成立時不得新增玩家。封測採分批 allowlist，只有前一批完成 health review 才能擴大。

## 每日 health review

- API／worker／Web／Discord availability 與 error rate；
- mutation conflict、idempotency replay、outbox retry／DLQ；
- ledger imbalance 必須為 0；
- replay eventHash／snapshotHash mismatch 必須為 0；
- cross-tenant denial、未連結 Discord denial 與 auth anomaly；
- backup freshness、restore drill 到期日與 secret rotation 到期日；
- cohort active／consumed invites、withdrawn consent 與 reward eligibility audit。

任何經濟、身份、RLS 或 hash 異常依 incident runbook 至少視為 `SEV-1`。

## Feature flag 與 rollout

- flag 由 server-side environment policy 控制，保存 actor／approver／reason／before／after。
- 可獨立停用：new invites、Discord mutations、Web mutations、open-day、day-end、market tick、reward、AI。
- client 不得以隱藏 UI 取代 server-side deny。
- closed-beta 不得用 feature flag 開啟未通過 Gate 的 Beta／正式版功能。

## Wipe 前置

1. 只有已核准的 `WipeBatch` 可啟動 wipe；禁止 raw SQL／手動逐表刪除。
2. 記錄 scope、公告時點、freeze 時點、保留／清除 family、expected counts／hash、requester 與不同 approver。
3. 公告後凍結新 invite；執行前凍結 scope 內 mutation、worker job 與 reward settlement。
4. 建立可驗證 backup 與 pre-wipe manifest；保留 identity、Discord link、invite eligibility、non-economic preference、audit 與依 D-05 指定的 append-only history。

## Wipe fail／resume

1. `WipeBatch` 以 immutable scope 與階段 checkpoint 執行：`APPROVED → FROZEN → ISOLATED → CLEARED → VERIFIED → COMPLETED`；失敗記錄目前 checkpoint、attempt、error code 與 count/hash evidence。
2. 任一階段失敗時維持 freeze，不建立新 batch、不從頭重做已完成 side effect。
3. Operator 與 approver 依相同 `WipeBatch` resume；每個步驟必須具 idempotency key，已完成 checkpoint 回原結果。
4. `VERIFIED` 必須證明：
   - 舊 live state 無法由新 session 讀取；
   - 清除／保留 counts 與 manifest 相符；
   - 保留身份／link／eligibility／audit 可讀且 tenant isolation 正常；
   - 新 save 不引用舊 aggregate version、market tick 或 replay sequence；
   - pre-wipe evidence 可供 audit，但不重新掛回 live state。
5. 未到 `COMPLETED` 前不得解除 cohort freeze。驗證失敗轉 `SEV-1`，依 backup runbook 決定 recovery，不直接修改 checkpoint。

## Rollback 與停止封測

- application rollback 只切回已記錄 image digest；不得反向執行未設計的 database migration。
- 破壞性或非向後相容 migration 無已演練 forward-fix／restore 路徑時，不得 promotion。
- `SEV-0`、重複經濟 side effect、跨租戶暴露、無法重現雙 hash 或無法 resume wipe 時，停止整個 cohort。

## 演練與證據

staging 至少注入一次 wipe 中途失敗，證明同一 batch 可從 checkpoint resume 且最終 verify 通過。artifact 必須包含 batch ID、candidate SHA、兩位核准者、階段時間線、失敗注入點、每階段 counts／hash 與解除 freeze audit。完成前 `wipe-resume` evidence 維持 `blocked`。
