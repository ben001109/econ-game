# Architecture Decision Records（ADR）

ADR 用來保存**已確認**且具有長期影響的架構／治理決定，包括背景、取捨、後果與取代關係。它不是待辦事項、會議逐字稿或完整規格的副本。

## 命名與生命週期

- 檔名：`NNNN-short-title.md`，從 `0001` 依序遞增，不重編號。
- 狀態：`proposed`、`accepted`、`superseded` 或 `deprecated`。
- 替代既有決策時，保留舊 ADR 並雙向連結；不得覆寫歷史理由。
- 建立 accepted ADR 時，同步更新完整規格與 [architecture/decision-register.md](../architecture/decision-register.md) 的索引。

## 模板

複製 [template.md](template.md) 建立下一份 ADR。

## 何時建立 ADR

適用於身份真相來源、資料寫入邊界、帳本不可變性、RLS／授權策略、replay 策略、營運可靠性等跨多個元件且難以回復的決策。單純的實作細節與短期 task 不建立 ADR。
