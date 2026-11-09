# MVP 封測 Backup／Restore／Replay Rebuild Runbook

- **狀態：** draft；待 O-01 環境、D-01 persistence 與 D-03 replay 完成後演練
- **Owner：** `release-ops`＋`data-platform`
- **最後更新：** 2026-08-07
- **最後演練：** 尚未演練

本 runbook 的目標是在隔離 staging recovery target 證明資料可恢復與 deterministic rebuild；不得覆寫 active closed-beta、不得讀取或輸出 credential，也不得執行 `prisma db push`。

## 必要前提

1. O-01 已指定 source／recovery project、region、platform owner、backup owner 與 secret access audit。
2. 備份 retention、PITR／snapshot 能力與成本已由 billing owner 核准。
3. D-01 migration 可審查且 release manifest 記錄 schema migration set。
4. D-03 保存 append-only ledger／outbox／ReplayEvent、不可變 DayEndSnapshot 與歷史 rule／catalog versions。
5. 測試資料集包含至少兩個 tenant、已結算營業日、market tick、outbox delivery 與一個已完成 wipe fixture。

## 停止條件

- recovery target 指向 active staging／closed-beta；
- backup checksum、migration manifest 或 candidate SHA 不明；
- 需要不可逆 schema rollback、跳過 migration 或直接修改 append-only history；
- restore 後跨租戶隔離、ledger 平衡或任一 hash 驗證失敗。

命中停止條件即保留隔離 target 與證據，升級 Incident Commander，不得把 recovery target 接回流量。

## Backup／Restore 演練

1. 建立 `drillId`，記錄 source environment ID、backup ID／時間、candidate SHA、schema migration head、simulation／catalog registry versions；敏感 locator 只保存受管引用。
2. 由兩人確認 recovery target 為全新隔離 staging resource，網路與 service principals 不可連到 closed-beta write path。
3. 透過供應商受管 restore 流程回復指定 backup；不得在應用啟動時自動變更 schema。
4. 依 release manifest 執行已審查、向前相容的 migration deploy。若 backup 已位於相同 head，步驟必須是 no-op 並留證。
5. 只使用 recovery principal 啟動 API／worker，保持 Discord、email、webhook、reward 與外部 side effect feature flags 關閉。
6. 驗證：
   - tenant／aggregate／ledger／ReplayEvent／DayEndSnapshot／outbox／audit 的 count 與 backup manifest 相符；
   - ledger transaction 每筆 debit＝credit；
   - `(saveId,businessDay,sequence)` 與 market tick 唯一約束無重複；
   - sample games 的 eventHash、snapshotHash 與 backup manifest 相符；
   - Player A 無法讀取 Player B；service role 不在 client；
   - 未送出的 outbox 保持可重送，已送出的 outbox 不重複 side effect。
7. 記錄實測 RPO、RTO、資料差異與未涵蓋範圍。MVP 封測只要求有成功演練與已知邊界；正式公開版的 RPO≤15 分鐘／RTO≤4 小時承諾仍屬後續門檻。

## Market／Replay Rebuild 演練

1. 從已驗證 snapshot 選定 `saveId` 與 business-day range，凍結 recovery target 的 mutation。
2. 載入 snapshot 所引用的精確 simulation、catalog、currency、market rule versions；任一版本缺失即 fail closed。
3. 依 `(businessDay,sequence)` 重放 ReplayEvent；依 `(saveId,businessDay,tickKind)` 恢復 market tick。不得以目前最新規則替代歷史版本。
4. 重新計算 eventHash 與 snapshotHash，兩者都必須與 authoritative manifest 一致；其中一層相符不得掩蓋另一層差異。
5. 驗證 outbox／job redelivery 不造成重複 ledger、market tick、reward 或 notification。
6. 保存 rebuild report：輸入版本、event count、first／last sequence、hash before／after、耗時與錯誤摘要。

## 成功證據

- provider restore job 的不可變 ID／artifact；
- source backup time、restore start／finish、observed RPO／RTO；
- migration head before／after；
- count／ledger／RLS／outbox verification report；
- market／replay rebuild report與雙層 hash；
- 執行者、approver 與 cleanup owner。

演練完成前，closed-beta evidence 的 `backup-restore` 與 `market-replay-rebuild` 必須維持 `blocked`。
