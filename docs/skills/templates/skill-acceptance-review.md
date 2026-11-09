# Skill Acceptance、Revision 或 Retirement Review

- **變更類型：** 新增 scaffold | 修訂 | 淘汰
- **Skill 名稱：** `<lowercase-hyphen-case>`
- **狀態：** draft | accepted | rejected | retired
- **Engineering owner：** `<role/team>`
- **Docs owner：** `<role/team>`
- **Profile owner：** `<role/team>`
- **建立／查核日期：** YYYY-MM-DD
- **相關 source map row：** `<link>`
- **相關 roadmap/runbook：** `<link or not applicable>`

## 1. 候選 workflow 與重複證據

- **觸發情境：**
- **至少兩個相同類型任務或穩定 workflow 的證據：**
- **預期輸入與完成條件：**
- **不屬本 skill 的範圍：**

若這段無法具體填寫，停止；候選應維持文件、runbook、issue 或 roadmap，而不是建立 skill。

## 2. Boundary 與安全

- [ ] 不決定產品、經濟、Architecture、schema、API compatibility、identity 或 deployment policy。
- [ ] 不讀取／要求貼出 `.env`、secret、token、連線字串或個資。
- [ ] 不將 database connection、migration、`db push`、service start、deployment、format 或 destructive action 設為預設。
- [ ] 若 real run 有 side effect，已有 default-safe preflight、停止條件與明確授權 owner。
- [ ] 與 [安全 runbook](../../runbooks/development-environment-and-safe-validation.md) 相容。

## 3. 官方來源與版本

| 技術／行為 | 官方來源 URL | 適用版本或查核日 | 為何適用 |
|---|---|---|---|
| `<item>` | `<official URL>` | `<version/date>` | `<reason>` |

## 4. Artifact 與 distribution

- **位置：** repo-local scaffold | profile-installed skill
- **Repo path：** `docs/skills/scaffolds/<skill-name>/` | 不適用
- **Profile path（僅核准後）：** `<profile-managed path>`
- **包含資源：** `SKILL.md` | `references/` | `scripts/` | `assets/` | 無
- **為何需要這些資源：**
- **Profile installation approval：** pending | approved | not needed

不要在 review 中貼出 credential、環境檔內容或 connection string。repo scaffold 不會自動安裝到任何 profile。

## 5. Verification 與 evidence

| 驗證 | 預期結果 | 實際結果／evidence 連結 | 執行者／日期 |
|---|---|---|---|
| Frontmatter／metadata | 合法、無 TODO、名稱與描述可觸發 |  |  |
| Default-safe preflight | 無設定檔、credential、DB 或 deployment side effect |  |  |
| Workflow-specific verification | 明確、可行動的成功／失敗訊號 |  |  |
| `git diff --check` | 無 whitespace error |  |  |
| Profile readback（如適用） | 已安裝內容與 accepted artifact 一致 |  |  |

## 6. 審查結果與後續

- **結論：** accept scaffold | approve profile installation | revise | reject | retire
- **理由與未解風險：**
- **Source map／roadmap／runbook 更新：**
- **Profile owner action（如適用）：**
- **下次重新查核觸發條件：**

## Reviewer checklist

- [ ] Engineering owner 確認 workflow 正確且可重複。
- [ ] Docs owner 確認 source map、官方來源、版本、owner 與文件連結完整。
- [ ] Architecture owner 僅在 boundary 需要決策時參與；未把未決決策藏入 skill。
- [ ] Profile owner 已同意或明確拒絕 installation／removal。
- [ ] 無 secret、環境檔、連線字串、個資、產品碼、CI、schema 或無關檔案變更。
