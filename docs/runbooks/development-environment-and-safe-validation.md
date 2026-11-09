# 開發環境與安全驗證

- **狀態：** active
- **擁有者：** Build／CI owner
- **最後更新：** 2026-08-01
- **最後演練：** 2026-08-01（只完成無程序執行的 preflight）
- **相關 ADR／決策：** 不適用；本 runbook 不建立或變更 Architecture 決策
- **相關文件：** [developer-platform roadmap](../skills/developer-platform-roadmap.md)、[技術棧 source map](../skills/source-map.md)

## 目的與適用範圍

在變更 Node service 工具、manifest、quality-gate 或 CI 設定前，建立一條可重複且不需讀取 `.env`、secret 或連線字串的開發環境 preflight。此 runbook 只驗證工具鏈與既有 command inventory；它不驗證產品行為、資料庫、queue、Discord、telemetry、身份驗證或部署。

本文件不授權 service 啟動、Docker Compose、Bun、Pterodactyl、Prisma migration、`prisma db push`、schema 變更或任何 Architecture／遊戲規則決策。

## 觸發條件

- 要修改或審查 `.nvmrc`、service manifest、lockfile、ESLint/TypeScript 設定、quality-gate 或 CI workflow。
- 本機與 CI 使用的 Node runtime 不一致，或 CI 的 lint／build 結果無法重現。
- 在尚未取得受管設定與環境 owner 授權前，需要確認可安全執行的下一步。

## 前提與權限

- 使用已授權的 checkout；保留他人未提交的工作樹變更。
- 只檢視 manifest、lockfile、CI 與文件。不要開啟、列出、複製或貼出 `.env`、secret、token 或連線字串。
- 預設只執行本 runbook 的 preflight。任何 dependency 安裝、build、test、Prisma generate、service 啟動或 Docker 操作，都需由使用者或 Build／CI owner 明確授權。
- 與受管設定、外部服務、資料庫、queue 或 bot credential 有關的問題，交由相應 Platform／Database／Bot owner 處理；只記錄「設定不可用」，不要記錄值或檔案內容。

## 服務啟動前置條件

| Service | 已知 runtime／script | 啟動前必須確認 | 本 runbook 的界線 |
|---|---|---|---|
| API | Node/TypeScript；`dev`、`build`、`start`、`test`、`prisma:generate` | 依賴已由核准方式安裝；受管資料庫／Redis 設定可由 owner 提供；API owner 已批准本次執行目的 | 不啟動；不執行 Prisma migration 或 `db push` |
| Worker | Node/TypeScript；`dev`、`build`、`start` | 依賴已由核准方式安裝；受管資料庫／queue 設定可用；Worker owner 已確認 job side effect | 不啟動；不排程或處理工作 |
| Bot | Node/TypeScript；`dev`、`build`、`start` | 依賴已由核准方式安裝；Bot owner 已在受管設定系統確認外部平台 credential 與 target scope | 不啟動；不讀取或顯示 credential |
| Frontend | Next.js/React；`dev`、`build`、`start` | 依賴已由核准方式安裝；Frontend owner 已確認 public runtime configuration 與 API target | 不啟動或 build；避免間接載入環境檔 |

Python／uv 是 untracked parallel preview，不是本 runbook 的服務啟動範圍。若要採用、重建或驗證它，先取得獨立授權與 owner。

## 安全 preflight

1. 記錄目前工具版本，不要修改 runtime：

   ```bash
   node --version
   npm --version
   sed -n '1,20p' .nvmrc
   ```

2. 確認 CI 仍從 `.nvmrc` 取得 Node 版本，且識別 CI 實際包含的 quality steps：

   ```bash
   rg -n 'node-version-file|npm ci|prisma:generate|npm run (lint|build|test)' .github/workflows/ci.yml
   ```

3. 以 default-safe runner 列出四個 service 的 command inventory。此指令不啟動子程序：

   ```bash
   node scripts/quality-gate.mjs
   ```

4. 檢查文件或允許範圍內的變更是否含有 whitespace error：

   ```bash
   git diff --check
   ```

5. 將輸出記為「preflight evidence」。只保留 Node/npm 版本、service 名稱、命令名稱、exit code 與時間；不要附上環境變數、設定檔內容或外部 endpoint。

## 受限的 CI-parity 執行

CI 在 Ubuntu 與 Windows 對每個 Node service 執行 install、Prisma generate（若 script 存在）、lint、build，然後在 Ubuntu 建 Docker image。它目前不執行 test step；API 有 test script，其他三個 service 沒有 test script。

只有同時符合下列條件時，Build／CI owner 才能在乾淨、已批准的環境執行 CI-parity commands：

1. 使用者明確授權該執行，且 workspace 允許產生 dependency／generated／build artifacts。
2. Owner 已審核被呼叫 script 的間接 side effect，特別是 environment-file 讀取與外部連線。
3. 失敗輸出不會包含 secret、token、連線字串或個資。
4. API 的 Prisma generate 僅限 client generation；migration 與 `db push` 不在此流程。

若以上任一條件不成立，停在 preflight，不要使用 `scripts/quality-gate.mjs --execute`，也不要以手動 `npm run` 繞過。

## Node runtime／CI drift 診斷

| 現象 | 已知事實 | 安全診斷 | 停止與升級 |
|---|---|---|---|
| 本機 Node 與 `.nvmrc` 不同 | 本次 preflight 本機是 Node `v22.23.1`，CI 與 `.nvmrc` 是 Node 20 | 比對 `node --version`、`.nvmrc` 與 CI 的 `node-version-file`；只記錄版本 | 不自行改 `.nvmrc`、CI、Dockerfile 或 lockfile；交由 Build／CI owner 提出相容性與升級計畫 |
| Node 20 lifecycle 風險 | [Node 官方 release 表](https://nodejs.org/en/about/previous-releases) 顯示 v20 已 EOL | 將其記為 runtime support gap；確認是否已有核准計畫 | 沒有 owner／Architecture gate 時，不自行升級 runtime |
| 本機成功但 CI 失敗 | CI 有 OS matrix；本機只代表單一 runtime/OS | 取得 CI job、service、step 與 exit code；比對 manifest 與 lockfile 是否一致 | 不把本機結果當成跨平台通過；升級 Build／CI owner |

## 常見阻塞與安全處置

| 阻塞 | 可收集的非敏感證據 | 安全處置 | 禁止動作／升級 |
|---|---|---|---|
| 依賴不存在或 lockfile 不一致 | service 名稱、Node/npm 版本、`npm ci` 的 exit code | 在乾淨且已核准環境由 Build／CI owner 重現；保持 lockfile 不變直到原因確認 | 不以 `npm install`、刪除 lockfile 或修改版本繞過 |
| `prisma:generate` 無法執行 | service、script 是否存在、exit code | 確認 CI 的 `--if-present` 行為與已安裝依賴；交給 API/Database owner | 不執行 `db push`、migration 或資料庫連線診斷 |
| ESLint 警告或失敗 | service、rule/檔案路徑、exit code | 依 manifest 的 `lint` script 在核准環境重現；區分 warning 與 error | 不執行 `lint:fix` 或 formatter 造成大量無關 diff |
| TypeScript/Next build 失敗 | service、build command、exit code | 交給 service owner 在已批准環境重現；確認是否與 runtime drift 有關 | 不因 build 而開啟或貼出環境檔；不把 build 當產品測試 |
| Test coverage 不足 | API 有 test script；Bot/Worker/Frontend 沒有，CI 也未跑 test | 報告缺口與 owner；不要將 `--if-present` 的 skipped 視為 pass | 不新增測試、CI step 或產品程式碼；交由 Build／CI 與 service owner 排程 |
| Docker/Compose/Bun/Pterodactyl API path | 目前 API startup/deployment path 含 `db push` | 停止部署或啟動程序，記錄 manifest 路徑與 owner | 不把該路徑寫為 production-safe；交由 Platform／Database owner 設計 versioned migration flow |
| 設定或 credential 不可用 | 「受管設定不可用」及 owner/時間 | 請 owner 透過受管流程修復；驗證時只保留成功/失敗狀態 | 不讀取 `.env`、不要求貼出 secret、token 或連線字串 |
| Python/uv preview 與 Node stack 混用 | 被要求的命令與所屬 stack | 停止並確認是否有獨立 adoption 授權 | 不遷移、重建或修改 Python/uv 工具鏈 |

## 風險、停止條件與回復策略

- **停止條件：** 任何步驟要求讀取環境檔、揭露 secret、連線資料庫、啟動服務、執行 migration／`db push`、或修改 CI/runtime／lockfile。
- **回復／補償：** preflight 沒有 runtime side effect；若後續已授權的 CI-parity run 產生本地 artifact，依 owner 指示清理該受控工作目錄，不在本 runbook 中執行刪除。
- **升級：** runtime/CI 問題交 Build／CI owner；資料庫與 deployment 問題交 Platform／Database owner；service 行為問題交 API／Worker／Bot／Frontend owner；Architecture gate 未明確時停止。

## 驗證與證據

- 成功的最低標準：`node scripts/quality-gate.mjs` 列出四個 service 的 command inventory，且 `git diff --check` 通過。
- 將 evidence 寫成下表；不要附 command full output、環境設定、endpoint 或 token。

| 時間 | 環境 | Node/npm | 範圍 | 結果 | Owner／後續 |
|---|---|---|---|---|---|
| YYYY-MM-DDThh:mm:ssZ | local/CI | major versions only | preflight | pass/block | role + issue link |

## 事故／演練紀錄

| 日期 | 環境 | 執行者 | 結果 | 差異與後續工作 |
|---|---|---|---|---|
| 2026-08-01 | local | Docs | pass | Node/npm version、quality-gate preflight、Markdown whitespace 已驗證；未執行 install/build/test/Prisma/Docker/service |
