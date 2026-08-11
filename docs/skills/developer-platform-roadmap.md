# Developer Platform、Internal SDK 與 Shared-contract 路線圖

> **狀態：** 現有 HTTP surface SDK snapshot 已建立；正式 shared-contract／產品 SDK 仍準備中（不授權產品實作）
>
> **擁有者：** Build／CI、API consumer、Architecture contract authority
>
> **最後查核：** 2026-08-01（Asia/Taipei）
> **相關索引：** [技術棧 source map](source-map.md)

## 目的與邊界

本文件把現有工程事實、可安全重用的開發流程、已實作 HTTP route snapshot 與未來 SDK／shared-contract 的進入條件放在同一個可審查位置。`packages/econ-game-sdk` 只包裝目前 route source 並以 mock test／靜態 drift check 驗證；它不決定未來 endpoint、payload、資料 schema、遊戲規則、經濟公式、identity 流程或部署方案。

不得以本文件為由執行 `prisma db push`、建立或套用 migration、連線資料庫、讀取 `.env`，或把 Python／uv preview 視為已採用的替代技術棧。

## 現況 inventory

| 面向 | 已驗證的現況 | 缺口／風險 | 責任 owner | 不連線驗證 |
|---|---|---|---|---|
| Runtime | `.nvmrc` 與 CI 固定 Node 20；各 service 採 TypeScript `^5.9.3`；本次 preflight 的 local Node 是 `v22.23.1` | [Node 官方 release 表](https://nodejs.org/en/about/previous-releases) 顯示 v20 已於 2026-03-24 EOL，且 local／CI runtime 已漂移 | Build／CI | `node --version` |
| Node service | `api`、`worker`、`bot`、`frontend` 各有獨立 manifest 與 lockfile | 無 root workspace、單一 dependency policy 或跨服務 test gate | Build／CI | `node scripts/quality-gate.mjs`（預設 preflight） |
| CI | Ubuntu／Windows matrix 執行 install、Prisma generate（若有）、lint、build；Docker job 建 Node image | 沒有 test step；Bun 與 Python preview 沒有 CI matrix | Build／CI | `sed -n '1,260p' .github/workflows/ci.yml` |
| Runtime container | Node Dockerfiles、Compose prod/dev/Bun profiles、Pterodactyl Bun egg 均存在 | API deployment/startup 含 `db push`；此文件不修改其行為 | Platform／Database | 靜態審查 manifest |
| API documentation | Fastify 註冊 `@fastify/swagger` 與 UI，runtime route 是 `/docs` | 尚無受版本控制的 OpenAPI artifact；不是 stable SDK input | API owner | `rg -n 'swagger|openapi' services/api/src` |
| Internal SDK snapshot | `packages/econ-game-sdk` 是 dependency-free TypeScript package；Node restaurant scaffold 與 Python preview 有明確不同的 client；靜態比對 route source | 沒有 approved public contract、compatibility policy、consumer integration、release owner 或 CI gate | API／SDK consumer／Build | `cd packages/econ-game-sdk && npm run verify` |
| Observability | API／Worker／Bot 使用 Sentry Node 與 New Relic；Frontend 使用 Sentry Next.js | 未有 release／alert delivery runbook 或可重複 verification | Observability | manifest 與 source 靜態審查 |
| Parallel preview | Python／uv workspace、Compose、Pterodactyl eggs 為未追蹤的 parallel preview | 本任務沒有 adoption、遷移或重建授權 | Python preview／Architecture | `rg --files python pyproject.toml uv.lock` |

## 官方來源與查核規則

- 使用 [Node release lifecycle](https://nodejs.org/en/about/previous-releases)、[TypeScript project references](https://www.typescriptlang.org/docs/handbook/project-references.html)、[npm workspaces](https://docs.npmjs.com/cli/v11/using-npm/workspaces) 管理 runtime 與 package-topology 變更；不要以 source map 的查核日取代真正的升級決策。
- 使用 [OpenAPI Specification](https://spec.openapis.org/oas/latest.html) 與 [Fastify Swagger](https://github.com/fastify/fastify-swagger) 定義 HTTP contract artifact 的格式與產出路徑。只有 API／Architecture 完成 contract gate 後才可產生 artifact。
- 使用 [Docker Compose](https://docs.docker.com/compose/)、[GitHub Actions workflow syntax](https://docs.github.com/actions/using-workflows/workflow-syntax-for-github-actions)、[ESLint flat config](https://eslint.org/docs/latest/use/configure/configuration-files) 與 [npm `ci`](https://docs.npmjs.com/cli/v11/commands/npm-ci/) 管理開發與 CI workflow。
- 來源的版本、適用範圍或大版本行為變更時，更新 [source map](source-map.md) 的日期、manifest evidence、驗證命令與 owner。不要從 blog、第三方教學或 lockfile 推定產品決策。

## 已成熟的 reusable workflow

`scripts/quality-gate.mjs` 為四個目前 Node service 建立可重複的 quality-gate command inventory。預設是無程序執行的 preflight；它列出每個 service 既有的：

1. `prisma:generate --if-present`
2. `lint --if-present`
3. `build --if-present`
4. `test --if-present`

檢視而不執行（預設）：

```bash
node scripts/quality-gate.mjs
```

只有在使用者明確授權、Build／CI owner 已確認被呼叫的 script 不會讀取敏感設定或造成不允許的 side effect、且工作目錄允許產生 build artifact 時，才可執行：

```bash
node scripts/quality-gate.mjs --execute
```

Runner 本身不安裝 dependency，也不直接呼叫 `prisma db push`、migration、format 或 `lint:fix`。預設 preflight 不啟動子程序、不讀 `.env`，也不會連線。`--execute` 會委派給既有 npm scripts；它不替這些 scripts 的 transitive side effect 背書，因此不屬本任務的可執行驗證範圍。品質 gate 失敗時回報 service／step 與原始 exit code；修復責任仍屬相應 owner。

## Internal SDK 與 shared-contract 的分階段計畫

| 階段 | 僅在下列 gate 全數成立後進行 | 產物範圍 | 可驗證完成條件 | Owner |
|---|---|---|---|---|
| 0. Baseline／implementation snapshot（本次） | 只包裝已實作 route，不需要新增產品或資料決策 | source map、roadmap、Node quality-gate scaffold、`packages/econ-game-sdk`、SDK maintenance scaffold | `npm run verify`、`npm pack --dry-run`、文件／source route 對齊、`git diff --check` | Docs／Build／API consumer |
| 1. Contract source | Architecture 指定第一個跨 service HTTP/event contract、owner、compatibility policy 與 deprecation policy；API owner 批准 contract format | 受版本控制的 contract artifact 與其 validation command；尚不生成 SDK | CI 可驗證 artifact 結構與 breaking-change policy；不存取 DB／secrets | Architecture／API owner |
| 2. Package topology | Build owner 批准 npm workspace、獨立 package 或其他 distribution topology；consumer owner 同意 import boundary | 最小 `contracts` package，僅 export 已批准的 transport contract；不放 Prisma model、業務規則或秘密 | clean install、typecheck、`npm pack --dry-run`（若採 package）、consumer compile fixture | Build／API／consumer |
| 3. 正式 SDK generation | Contract source 穩定且有至少兩個相同型別 client consumer；版本策略與 release owner 已定 | generated or hand-written transport SDK、contract tests、release notes template | repeatable generation/check、compatibility test、consumer fixture；不改 server behavior | API／consumer／Build |
| 4. CI enforcement | 1–3 的 command 已被至少一次 PR 重複證實且 failure signal 可行動 | contract/SDK verification 加入 CI，必要時加 test gate | CI job 對 artifact drift 與 breaking change fail closed，並有 owner 路由 | Build／CI |

### 明確禁止的捷徑

- 不從 Prisma schema、資料庫 table 或尚未確認的 Zod type 自動衍生 public／internal contract。
- 不把 runtime Swagger UI 當成已版控、可相容判斷的 SDK source。
- 不建立 shared `models` 包來混合 DB persistence model、API payload、queue event 與 UI state。
- 不因存在 Python preview 而建立 Python SDK 或變更 Node package topology。

## Skill maturity gate

| 候選 workflow | 狀態 | 進入條件 |
|---|---|---|
| Node cross-service quality gate | **成熟：repo scaffold 已建立** | 維持四個現有 service 的 command 及無副作用 guardrails；審核後才安裝至 profile |
| Next.js／React 變更流程 | 未成熟 | 至少兩次相同 UI workflow、明確 UI test command、Frontend owner 確認 scope |
| Discord interaction lifecycle | 未成熟 | actor／identity contract 已由 Architecture 批准，Bot owner 提供重複驗證案例 |
| Supabase RLS／Prisma deployment | 未成熟 | migration/RLS ownership 與 production deployment gate 已批准；不得以 `db push` 代替 |
| Observability release／alert verification | 未成熟 | 已有可重複的 release、sampling、alert acknowledgement runbook，且不需要暴露 credential |
| Current-route SDK maintenance | **成熟：repo scaffold 已建立** | 僅維護 `packages/econ-game-sdk` 的已實作 route snapshot、mock test、static drift check 與參考文件；不得升格為產品 contract 或 publish |
| 正式 SDK generation／publish | 未成熟 | 上表第 1–3 階段全數完成，並已產生至少兩個 consumer 的真實重複需求 |

## 維護與 handoff

1. Build／CI owner 每當 Node、npm、Docker、CI matrix 或 service script 改變時，更新 inventory evidence 與 quality-gate service list。
2. API／consumer owner 每當已批准 contract 改變時，更新 Phase 1–4 的 gate 狀態；未批准的變更保持「待決」。
3. Docs owner 每次變更本區文件或 scaffold 後執行 `git diff --check`，並確認沒有 `.env`、secret、migration 或產品程式碼進入 diff。
4. 不把「文件完成」標示為 SDK 已可用；只有該階段的 artifact、驗證輸出與 owner sign-off 都存在，才可升級狀態。
