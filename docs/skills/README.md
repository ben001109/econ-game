# Skills Governance 與 Acceptance

> **狀態：** active
>
> **擁有者：** Docs；各 skill 的 engineering owner
>
> **最後更新：** 2026-08-01
>
> **相關文件：** [source map](source-map.md)、[developer-platform roadmap](developer-platform-roadmap.md)、[開發環境與安全驗證 runbook](../runbooks/development-environment-and-safe-validation.md)、[Codex 模型路由與 quota 政策](../runbooks/codex-model-routing-and-quota.md)、[task prompt 模板](templates/codex-task-routing-prompts.md)

## 目的與文件責任

本區只治理可重複的工程 workflow。Skill 不是產品規格、Architecture 決策、遊戲規則、資料 schema、API contract 或部署授權；遇到這些範圍，停止 skill 化並交由相應 owner。

| 文件 | 唯一責任 |
|---|---|
| [source map](source-map.md) | 現有 profile skill 與 repo scaffold 的 inventory、官方來源、適用版本／查核日、驗證命令與 owner |
| 本文件 | skill 的成熟度門檻、acceptance、修改與淘汰治理 |
| [developer-platform roadmap](developer-platform-roadmap.md) | 現有 SDK snapshot 與尚未具備正式 contract／shared-contract 條件的 developer-platform gate |
| [安全 runbook](../runbooks/development-environment-and-safe-validation.md) | 不讀設定檔或 credential 的開發環境 preflight 與 CI-parity 執行界線 |
| [acceptance review template](templates/skill-acceptance-review.md) | 新增、修訂或淘汰 skill 時可審查的證據格式 |

文件衝突時，source map 管「實際 inventory 與來源」，roadmap 管「未成熟項目的進入 gate」；任何產品或 Architecture 問題都不由本文件裁決。

## Skill 類型與儲存位置

| 類型 | 位置與狀態 | 能否自動載入 | 維護規則 |
|---|---|---|---|
| Profile-installed skill | `~/.hermes/skills/econ-game/` 下的已安裝 skill；repo 只記錄其索引 | 由該 profile 的 skill system 決定 | 不在 repo 內直接寫入、更新或移除；先更新 source map 與 review evidence，再由對應 profile owner 執行受控安裝 |
| Repo-local scaffold | `docs/skills/scaffolds/<skill-name>/`；例如 `econ-game-node-quality-gate` | 否；它是可審查、可移植的候選 artifact | 保持版本控制、保留 guardrails 與驗證；經 owner acceptance 後才可由 profile owner 安裝 |
| Review template | `docs/skills/templates/` | 否 | 只保存 review 程序；不含可執行 workflow 或 product knowledge |

不要把 scaffold 的存在描述為已安裝、已啟用或已獲 production 授權。不要因 profile path 存在而假設其內容已與 repo source map 同步。

## 何時可建立 skill

一個 workflow 必須同時滿足下列 acceptance gate，才可從 review proposal 進入 repo scaffold：

1. **可重複：** 已有至少兩個相同類型的工程任務，或有明確且穩定的 CI／runbook workflow；不能只因一次性需求建立 skill。
2. **範圍已定：** 輸入、完成條件、停止條件與擁有者清楚；未決 Architecture、產品、經濟、identity、schema 或 API contract 不得被 skill 代為決定。
3. **官方依據：** 每個外部技術行為都有 vendor／project 官方來源、適用版本或查核日，並在 source map 中可追溯。
4. **可驗證：** 有不需 credential 的 verification command、fixture 或 review evidence；若真正執行有副作用，提供 default-safe preflight 並把 real run 留給明確授權的 owner。
5. **安全界線：** 不讀取或要求貼出 `.env`、secret、token、連線字串或個資；不把 `db push`、migration、service start、deployment 或 destructive command 包裝成預設行為。
6. **維護可行：** 指定 engineering owner、Docs owner、版本／查核日與更新觸發條件；若無 owner，保持為 roadmap gap。

## 何時不應固化成 skill

保持為文件、runbook、issue 或 roadmap，直到下列情況解除：

- workflow 只執行過一次，或每次輸入／決策都大幅不同。
- 需要選擇產品規則、經濟公式、資料模型、RLS、身份權限或 API compatibility policy。
- 唯一驗證方式需要資料庫、外部系統、credential 或 production side effect，但尚未有隔離環境與 owner 授權。
- 現有指令包含未處理的 deployment risk；目前 API 的 `db push` paths 就屬此類，不能被視為可重複的安全 skill。
- 尚無明確 service／platform owner，或官方來源和實際 manifest／CI 已不一致。
- 只是在規避測試、CI、review 或 Architecture gate。

例如，Next.js/React workflow、Discord interaction lifecycle、Supabase RLS／migration deployment、observability release verification 與正式 SDK generation／publish 都應維持 roadmap 的未成熟狀態，直到各自的 gate 與重複證據齊備。只維護既有 route snapshot 的 `econ-game-sdk-maintenance` scaffold 不等同於批准未來遊戲 contract 或 publish。

## Lifecycle 與 acceptance

```text
提出候選 → 收集重複任務與官方來源 → review acceptance
  → repo-local scaffold → 安全 preflight／驗證 → owner 核准
  → profile owner 受控安裝（如需要） → 定期查核／修訂 → retired
```

1. 使用 [template](templates/skill-acceptance-review.md) 建立 review；先選擇「新增 scaffold」、「修訂」或「淘汰」，不直接新增 profile skill。
2. 在 review 中記錄適用範圍、排除範圍、官方來源、版本／查核日、owner、重複證據與不含敏感資料的驗證輸出。
3. Docs owner 更新 source map；engineering owner 確認 workflow 與 service manifest/CI/runbook 的事實一致。
4. 對 repo scaffold，直接讀回 `SKILL.md` 與 interface metadata；若 `quick_validate.py` 可用，執行它。對已安裝 profile skill，僅在其工具可用時用 `skill_view` 讀回。兩者都不替代 workflow 的實際 acceptance evidence。
5. 僅在 profile owner 明確核准後安裝。安裝位置、profile 與啟用方式必須記錄在 review；repo 不執行這個動作。
6. 每次文件或 scaffold 修改後執行 `git diff --check`；對未追蹤的 candidate 也執行等價 whitespace 檢查。不要為通過檢查而重寫無關產品檔案。

## 新增／修訂／淘汰審查清單

### 新增

- [ ] 已填寫 acceptance review，並有重複 workflow 證據。
- [ ] 名稱使用小寫 hyphen-case，且描述包含可辨識的觸發情境。
- [ ] `SKILL.md` 僅保存必要 procedure；長篇參考資料放一層深度的 `references/`，必要時才建立 scripts/assets。
- [ ] source map 有官方來源、適用版本或查核日、驗證方式與 owner。
- [ ] guardrails 明確拒絕未授權的 secret、環境檔、DB、migration、deployment 或產品決策。
- [ ] default-safe preflight 與 real-run authorization boundary 已寫清楚。
- [ ] repo scaffold 已完成 metadata／frontmatter validation 和直接讀回；profile 安裝仍待 owner 核准。

### 修訂

- [ ] 先比對現有 skill、source map、roadmap、runbook 與實際 manifest/CI；不要只根據過期摘要修改。
- [ ] 說明觸發條件、官方來源、版本、owner、驗證或 guardrail 的哪一項改變。
- [ ] 保留原有的產品／Architecture boundary；若 boundary 改變，停止並取得相應決策。
- [ ] 再驗證 metadata、內部連結、官方來源、default-safe path 與 `git diff --check`。
- [ ] profile 與 repo scaffold 若有不同，記錄差異並交由 profile owner 同步；不要假設一方自動更新另一方。

### 淘汰

- [ ] 說明觸發因素：官方來源 EOL、runtime/CI 不再採用、替代 skill、長期未使用或 unsafe workflow。
- [ ] 指定替代文件／skill、資料遷移需要（若有）與 owner；不能直接刪除唯一的操作知識。
- [ ] 將 source map 狀態改為 retired 或明確移除，並保留 review evidence 的位置。
- [ ] 由 profile owner 執行任何 profile 移除；repo 只更新 scaffold/docs，不刪除外部 profile 檔案。
- [ ] 執行 `git diff --check`，確認沒有秘密、產品碼、CI、schema 或無關變更進入 diff。

## 定期維護

- 每次 manifest、CI、runtime、vendor major version 或安全 boundary 改變時，重新查核受影響的 source map row 和 skill。
- 每個 skill 至少在官方來源、適用版本或 owner 任一變更時重新 review；不設定未經驗證的固定週期。
- 失去 owner、無法驗證或與安全 runbook 衝突的 skill，先標為待審查／retired，不得繼續宣稱可安全使用。
- Docs owner 只維護可審查索引與 governance；engineering owner 維護 workflow 正確性；Architecture owner 保留對產品與 boundary 的決定權。
