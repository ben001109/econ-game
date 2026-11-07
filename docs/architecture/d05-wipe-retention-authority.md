# D05 Wipe Retention Authority (Closed-Beta / Post-Beta)

## Confirmed decisions

1. Save清理策略固定為 `COMPLETE_NON_HISTORICAL_SAVE_CLEAR`，採「先隔離後清除」。
2. 以 DB UTC `isolatedAt` 為準，需滿足 30 天 (`clearEligibleAt = isolatedAt + 30 days`) 才能進入清除階段。
3. `SAVE_CLEAR` 分類與保留行為為決定性分類結果（decision-complete，需版本化）：
   - **清除族群**（30 日後）：`MenuSelection`；以及 `OrderItem/Payment/TaxLine/Tip` 之 scoped 子資料（child-first）。
   - `CompetitiveSave`、`Employee`、`InventoryStock`、`Order`：以 `TOMBSTONE` 形式保留版本定位鍵、FK 參考、hash、locator、撤銷憑證；同時清除 live payload；`saveId null` 則完全保留不列入清除。
4. **保留族群**（保留且不清除）：`AuditLog`、`WageContract`、`EmployeeShift`、`RecipeVersion`、`InventoryTransaction`、`OrderServiceState`、`ReplayEvent`、`DayEndSnapshot`、`RiskState`、`ReputationDimensionHistory`、`Loan`、`LoanInstallment`、`LedgerTransaction`、`LedgerLine`、`Outbox*`、`SimulationVersionArtifact`、`SimulationJob`、`SimulationJobAudit`、`VersionedReplayExecution`、`MarketTick`、`ConsentDecision`、`RewardEligibility`。
5. **治理/共用族群保留**：`TestCohort`、`TestCohortInvite`、`TestCohortMembership`、`ConsentPolicy`、`WipeBatch`、`IdempotencyRecord`（保有 D-02 完整生命週期），`Restaurant`/`Catalog` 共享模型為 out-of-scope 不清除。

6. 未分類 / 未知 family 一律 fail-closed `RETAIN`，直到明確版本化 `WipeDataPolicy` 清單認可；不可推斷或清除未分類家族。
7. 帳號清理條件：僅在「所有受影響 save 已清除」且該 `Player` 無其他 active save、參與紀錄、tenant/restaurant membership 時，才可將本地 Player tombstone。此時計畫：
   - 保留本地 `Player` id，
   - 將 `clerkUserId` 替換為不可逆復原之唯一識別值，
   - 清理 local `IdentityLink` 與已消費 `DiscordLinkChallenge`，
   - tombstone `RestaurantMembership`。
   若條件未滿足則記錄 `ACCOUNT_RETAINED_GUARD`，僅阻擋帳號 tombstone，不阻擋 save 清除。
8. Wipe 過程不得呼叫/更新 Clerk API；外部身份平台為 non-effect。

## Guardrails

- Checkpoint states: `FROZEN → ISOLATED → CLEARED → VERIFIED`.
- 每個受控 restaurant/tenant 的兩位審核者（requester 與 approver）必須為不同且皆為 active OWNER RestaurantMembership（`revokedAt IS NULL`）。
- scope/policy 摘要為不可變欄位（`scopeHash`、`policyHash`）且以版本綁定；不可變更後重用同一 batch。
- 需保留 dry-run manifest、restore window 與證據；所有清除必需 child-first，並具 count/hash 前後一致驗證。
- no generic SimulationJob auto-retry；失敗僅可手動 forward resume 且只能從既有 checkpoint 往後推進（不得回頭重播 side-effect）。
- `ISOLATED` 之前不得轉入 `CLEARED`；`VERIFIED` 前不可解凍 cohort。
- `VERIFIED` 必須檢核留存 FK/replay/ledger/consent 及跨 tenant 與舊 live-state 不可讀性；不通過則維持原 checkpoint。

## Implementation boundary

The concrete per-model retention matrix is decision-complete (this document). 下一步是 `D05-A → B（可加法遷移）→ C（API/domain）→ D（專用 worker）→ E（evidence/drill）` 的落地順序，實作前仍需以 runbook 驗證對應證據。

### D05-D0 implementation boundary

D05-D0 只提供 additive execution-lease persistence、不可變 environment/nonce/authority 綁定與 fail-closed lease request。正常 production composition 不注入 lease service；本階段沒有 callable clear executor，也沒有刪除或遮蔽 app data 的 SQL。實際 clear/rollback 延後至 runner-created、nonce-bound disposable PostgreSQL fixture 完成 runtime target verification 並取得該 fixture 的另行授權；在此之前不得宣稱 D05-D clear 已完成。
