# Econ Game Roadmap（Discord 優先）

> **狀態：** 生效中
>
> **最後更新：** 2026-11-08
>
> **相關決策：** [架構決策總表](architecture/decision-register.md)「主線調整（2026-11-08）」

## 方向

主線分支 `discord-first` 只做一件事：讓玩家在 Discord 上玩完一個營業日。M1 完成前，Discord Bot 是唯一的玩家介面。

主線包含：

| 路徑 | 用途 |
|---|---|
| `services/bot` | Discord slash commands（`/game status｜open｜advance｜settle｜replay`、`/ops health`） |
| `services/api` | Fastify＋Prisma；遊戲命令、身份、ledger、replay |
| `services/worker` | BullMQ；market tick、Day replay 驗證 |
| `packages/econ-game-sdk` | Bot 呼叫 API 的內部 client |
| `packages/econ-game-release-evidence` | API／worker 共用的 replay hash 模組 |

Runtime 只有 Node 22（`.nvmrc`）。前端、Bun、Python、Pterodactyl、Godot 已移到里程碑分支，見下方對照表。

## M1：Discord 上玩完第一天（進行中）

**目標：** 一位受邀玩家只用 Discord，就能從建立存檔、開店、營業、日結走到 replay 驗證，完成 Day 1。

### 已決定

- **身份：** 移除 Clerk，改用自有登入。Discord 是主要登入，email／密碼是選用的第二憑證，不在 M1 範圍。見 [ADR 0001](adr/0001-in-house-auth-discord-primary.md)。
- **存檔建立：** Bot 可以建立存檔。第一次使用 `/game` 時會建立 Player 與存檔。

### 還沒決定

- **跨端一致性 gate（PLAT-03）：** 原本要求「Web 與 Discord 雙端 hash 一致」。拿掉 Web 後改成「Discord 操作結果與 server 端 replay（`REQUEST_DAY_REPLAY`）hash 一致」。

### 工作項目

- 先修好 8 月留下的紅燈：API 1 個失敗測試、API／worker 的 TypeScript 錯誤、API／bot 的 lint error、三個服務的 format。
- 自有登入（ADR 0001 後續工作）：`clerkUserId` 改名為 `authSubject`（forward migration）、verifier 改驗自有 issuer、`CLERK_*` 設定改為 `AUTH_*`、bootstrap 允許 Bot、移除 Discord↔Clerk 綁定 challenge。
- `/game` 子命令背後的遊戲命令全部接上 durable handler（handoff 文件列為「六個遊戲命令尚未全部接入 durable handler」）。
- PostgreSQL runtime 實跑：migration、RLS、延遲約束（`services/api` 的 `test:d0x:postgres` 系列）。
- 日結 evidence producer：產生 `ReplayEvent`／`DayEndSnapshot`，讓 replay 驗證有上游資料。
- Bot 部署方式。原本的 Pterodactyl eggs 只有 Bun／Python 版，需要新增 Node 版或改用其他部署方式。
- 移除 Bot 裡未註冊的舊 POS／KDS 指令模組。
- 處理供應鏈檢查目前的兩個 finding：`services/bot/package-lock.json` 的 lock evidence 過期，以及 OCI 簽章／attestation evidence 缺失。

### 完成條件

- 在本機 Postgres／Redis 上，用 Discord 走完 Day 1，replay 結果為 `MATCH`。
- CI 綠燈，`node scripts/check-supply-chain.mjs` 沒有新的 finding。

## 之後的里程碑

| 里程碑 | 內容 | 程式碼在哪 |
|---|---|---|
| M2：Web 前端 | Next.js POS／KDS、玩家與管理 UI | `milestone/web-frontend` |
| M3：Godot 客戶端 | Steam 主客戶端；game-core 規劃見該分支的 `docs/superpowers/` | `milestone/godot-client`；開始寫 Godot 引擎專案時另開新 repo |
| 開發體驗 | ESLint 9 flat config、issue／PR 範本 | `milestone/oss-readiness`（建議 M1 期間先合回主線） |
| 其他 runtime | Bun 執行與 Pterodactyl Bun eggs | `milestone/bun-runtime` |
| 其他 runtime | Python／uv 服務與 Python eggs | `milestone/python-port` |
| 待評估 | Rust 模擬核心（WASM／gdext） | 等 M1 規則穩定後再評估 |

## 分支對照

| 分支 | 內容 |
|---|---|
| `discord-first` | 目前主線 |
| `snapshot/2026-08-wip` | 2026-08-07～18 未 commit 工作的完整快照，所有東西都在 |
| `milestone/web-frontend`、`milestone/bun-runtime`、`milestone/python-port` | 都指向 snapshot；恢復時從主線拿回對應目錄 |
| `milestone/godot-client` | 原 `godot-first-foundation` |
| `milestone/oss-readiness` | 原 `agent/oss-readiness` |
| `archive/malformed-main-2` | 2025 年的舊封存 |

要恢復某個移出的部分（例如前端），在主線上開新分支後執行：

```bash
git restore --source milestone/web-frontend -- services/frontend
```
