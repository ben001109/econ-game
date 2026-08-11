# Runbooks

本區保存可由值班／營運人員依序執行並留下證據的操作流程。Runbook 不得依賴個人記憶，也不得包含可用 secret、token 或未遮蔽的個資。

## 建檔規則

- 一份 runbook 對應一個明確觸發條件與操作目標。
- 先在 staging 演練；正式環境動作必須有明確授權、停止條件與稽核紀錄。
- 不可逆或高風險步驟必須標示核准人、雙人覆核需求與 rollback／compensation 路徑。
- 演練後更新最後演練日期、結果、差異與後續工作。

## 可用 runbook

| 主題 | 用途 | 入口 |
|---|---|---|
| 開發環境與安全驗證 | Node service tooling、CI parity 與安全 preflight；不啟動服務或資料庫 | [development-environment-and-safe-validation.md](development-environment-and-safe-validation.md) |
| 事故應變 | 事故分級、feature flag freeze、證據與解除條件 | [incident-response.md](../operations/incident-response.md) |
| Backup／restore／rebuild | 隔離 restore、market／replay rebuild 與雙 hash 驗證 | [backup-restore.md](../operations/backup-restore.md) |
| 封測與 wipe | cohort rollout、每日檢查、wipe fail／resume | [beta-runbook.md](../operations/beta-runbook.md) |

## 預定 runbook

| 主題 | 建檔時機 | 建議檔名 |
|---|---|---|
| migration promotion／rollback | 環境與 CI/CD 設計定稿時 | `migration-operations.md` |

## 模板

複製 [template.md](template.md) 建立新 runbook。
