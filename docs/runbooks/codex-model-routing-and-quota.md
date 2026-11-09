# Codex 模型路由與 quota 效率政策

> **狀態：** active
>
> **擁有者：** MVP 封測主控
>
> **最後更新：** 2026-08-07
>
> **依據：** `codex-model-routing-strategy.pdf` 與全域 `route-model-effort` skill

## 目的

以最少但足夠的模型能力、上下文與 Agent 數完成可驗證成果。本政策不能增加帳號 quota，也不承諾精確 token 帳單；它控制的是路由、推理強度、上下文、工具輸出、重試與委派數量。

## 角色與預設路由

| 角色／工作 | 等級 | 建議模型與 effort | 邊界 |
|---|---:|---|---|
| MVP 封測主控 | T1 | `gpt-5.6-sol / low` | 維護依賴、派發、進度、門檻與交接；不親自收斂架構或實作產品。 |
| Architecture Decision Lab | T3 | `gpt-5.6-sol / high` | 一次一題做推薦、替代方案、grill 與定案；身份、安全、ledger、wipe 最終覆核才升 `xhigh`。 |
| 單檔文件／機械整理 | T0–T1 | `gpt-5.6-terra / low-medium` | 不另開 Agent；以局部讀取與單次驗證完成。 |
| 一般有界實作 | T1–T2 | `gpt-5.6-terra / medium` 或 `sol / high` | 依跨檔程度、失敗成本與驗證需求選擇；不得只因檔案多就升級。 |
| 核心經濟、身份、權限、安全 | T3 | `gpt-5.6-sol / high-xhigh` | 使用單一專項 task 與強制驗證；不得降低驗證換取省額度。 |
| 大量獨立低風險項目 | Batch | `gpt-5.6-terra / low-medium` | 僅在使用者授權委派後平行，且每個輸出有獨立目標與整合 owner。 |
| 極難探索／多 Agent 自主協作 | T4–T5 | `sol / max-ultra` | 預設停用；必須先說明為何 high/xhigh 不足並取得使用者授權。 |

模型不可用時選擇最接近的可用設定並揭露差異；不得默默縮小需求或驗證範圍。

## quota guardrails

1. T0／T1 由當前 task 直接處理；預設不建立 Agent。
2. T2／T3 預設最多一個專項 task 或 Agent。只有任務互不依賴、輸出不重疊且主控已有整合方式時才平行化。
3. 專項 task 使用精簡 handoff：目標、權威檔案、已確認決策、限制、DoD。除非缺少完整歷史會直接造成錯誤，否則不傳整段對話。
4. 搜尋先用 `rg`；先讀命中區段，再按需要擴大。一般工具輸出預設控制在 8,000 tokens 內；只有確定需要完整長文件時才提高。
5. 決策與驗收結果寫回權威文件，後續 task 從文件讀取，不反覆從聊天歷史重建。
6. 一個實作 story 至少有一次與風險相稱的驗證；同一失敗最多重試一次，第二次仍失敗就先重新診斷，不盲目提高 effort 或新增 Agent。
7. 互動式架構確認不建立自動續跑 goal。詢問使用者後直接 idle；不得在沒有新輸入時重複發問、輪詢或產生等待回合。
8. 只有可自主收斂的封閉工作才使用 token-budgeted goal；長 context task 不設定低於既有 context footprint 的小額 budget。
9. 背景 task 以 cursor 進行有界 wait；狀態未變不回報、不重讀完整 thread。
10. `priority`／Fast 屬速度選擇，不等於更高推理品質；只有使用者明確要求時限或互動速度時使用。

## 升級與降級條件

只有下列情況可升一級模型或 effort：高風險 invariant 尚未證明、第一次驗證失敗且診斷顯示推理不足、範圍實際跨越多個 aggregate／服務，或需要獨立安全覆核。

下列情況應保持或降級：工作已收斂為機械修改、只需整理既有結論、驗證程序完全確定，或剩餘工作只是等待使用者／外部狀態。

## 每次派發記錄

主控在派發時使用一行記錄，不輸出隱藏推理：

```text
T級｜direct / task / agent｜model / effort｜Agent 上限｜主要驗證｜升級條件
```

完成後追蹤：是否通過 DoD、重開次數、驗證失敗次數、額外 Agent 數與不必要的大型讀取。以「每個通過 DoD 的 story」及「每個已確認決策」作為效率單位。

## 禁止事項

- 不以 skill 取代產品、Architecture、安全或 schema 決策 owner。
- 不為節省 quota 跳過授權、測試、RLS、安全或 replay 驗證。
- 不讓主控與專項 task 同時修改同一範圍。
- 不宣稱 skill 可以在既有 task 內原地切換模型、effort 或 service tier。
- 不在等待人類確認時持續消耗 goal 回合。
