# <測試規格標題>

- **狀態：** draft | active | superseded
- **擁有者：** <角色或團隊>
- **最後更新：** YYYY-MM-DD
- **相關規格／ADR：** <連結>
- **測試層次：** unit | property | integration | authorization | E2E | load | resilience

## 目標

<要證明的規則、保護邊界或可用性目標。>

## 前提與測試資料

- <固定 seed、simulation rule version、角色、環境與資料建立方式>
- <不得使用真實個資、正式憑證或 production 資料>

## 不變量／驗收條件

- <無論輸入排列或重送行為如何都必須成立的規則>
- <明確成功與失敗語意>

## 情境矩陣

| ID | Given | When | Then | 層次 | 自動化狀態 |
|---|---|---|---|---|---|
| T-01 | <前提> | <動作> | <可驗證結果> | integration | planned |

## 可觀測性與證據

- <assertion、audit record、metric、trace 或演練輸出>

## 失敗處理

- <flaky test、資料清理、失敗升級與缺陷追蹤方式>
