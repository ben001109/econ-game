# ADR 0001：移除 Clerk，改用自有登入（Discord 為主）

- **狀態：** accepted
- **日期：** 2026-11-08
- **決策者：** 專案擁有者
- **相關決策：** D-04、D-05、PLAT-01、PLAT-02（[決策總表](../architecture/decision-register.md)）
- **取代／被取代：** 取代 D-04 中「Clerk 為唯一 end-user identity」的部分；D-04 其餘規則（server 推導 scope、Bot 為受限 service principal、RLS 只開放必要 read model）保留

## 背景

原架構以 Clerk User 為唯一身份。Discord 要綁定時，玩家必須先在瀏覽器登入 Clerk，再完成一次性 IdentityLink。主線改為 Discord 優先後，這代表玩家在 M1 就需要一個網頁，與「只用 Discord 就能玩」的目標衝突。

現況（2026-11-08）：

- 程式沒有依賴 Clerk SDK。API 自行用 JWKS 驗證 JWT（`ClerkJwtVerifier`、`CachingJwksProvider`），Clerk 只是一組 issuer／audience／authorized-party 設定。
- `Player.clerkUserId` 是身份欄位，`IdentityLink` 以 `(playerId, clerkUserId)` 參照 Player。
- RLS 透過 `d01_clerk_subject()` 讀取 `request.jwt.claim.sub`。
- Bot 路徑本來就不需要 Clerk：Bot 用 service credential 加 `x-discord-user-id` 呼叫 API，API 再以 Discord ID 查出 Player。
- 存檔建立（bootstrap）目前只限 Web principal。

## 決策

1. **移除 Clerk。** 身份的唯一真相是 server 管理的 `Player`，識別欄位改為 server 產生、不透明的 `authSubject`，取代 `clerkUserId`。
2. **Discord 是主要登入。**
   - Bot：Discord user ID 由 Discord gateway 交給 Bot，Bot 帶 service credential 轉給 API，沿用現有路徑。
   - 第一次使用 `/game` 時，API 在同一個 transaction 裡建立 `Player`、`IdentityLink(provider=discord)` 與存檔。Bot principal 可以執行 bootstrap（PLAT-01）。
   - Web（M2）：使用「以 Discord 登入」（OAuth2 authorization code＋PKCE＋state）。API 簽發自有的短效 access JWT（非對稱簽章、自有 JWKS，沿用現有 verifier），refresh token 以雜湊保存並輪替。
3. **Email／密碼是選用的第二憑證。** 只能由已經用 Discord 登入的 Player 綁定，不能單獨註冊。需要 argon2id、登入速率限制、email 驗證與密碼重設。不在 M1 範圍。
4. **RLS 語意不變。** `request.jwt.claim.sub` 改為代表 `authSubject`，由 API 設定。M1 沒有 client 直連資料庫；是否保留 Supabase 改由 O-01 決定。
5. **D-05 調整。** 邀請改由一位 Player 兌換。Wipe 改為替換 `authSubject`，且不呼叫任何外部身份平台。

## 考慮過的替代方案

| 方案 | 不採用／採用原因 |
|---|---|
| 保留 Clerk，另做極簡綁定頁 | 不採用。M1 仍需網頁，而且多一個外部依賴與帳單 |
| 只有 Discord，完全不做 email／密碼 | 部分採用。M1 只有 Discord；email／密碼保留為選用的第二憑證，給想在 Discord 之外保有帳號的玩家 |
| Email／密碼為主，Discord 綁定 | 不採用。M1 無法只用 Discord 玩，而且密碼系統的維護成本最高 |
| 換成其他代管身份服務（Auth0、Supabase Auth 等） | 不採用。跟 Clerk 一樣是外部依賴，也解決不了 Discord 優先的問題 |

## 後果

### 正面

- M1 完全不需要網頁，玩家在 Discord 上就能從建立存檔玩到日結。
- 少一個外部服務與帳單，也不再受 Clerk 的 token 格式綁住。
- 現有 JWT／JWKS 驗證程式碼可以改成驗自己的 issuer，不用重寫。

### 代價與風險

- 身份安全變成自己的責任：簽章金鑰的保管與輪替、OAuth 流程的正確性、session 撤銷、帳號復原。
- 只用 Discord 的玩家，Discord 帳號遺失就等於遊戲帳號遺失，除非另外綁了 email。
- 選用 email／密碼之後，就要負擔密碼雜湊、暴力破解防護、email 寄送與重設流程的長期維護。

### 後續工作

- Schema：用新的 forward migration 把 `clerkUserId` 改名為 `authSubject`，並同步更新 `d01_clerk_subject()`、RLS policy 與相關 SQL fixture。
- `services/api/src/auth`：`ClerkJwtVerifier` 改為自有 issuer 的 verifier；`runtime-env.ts` 的 `CLERK_*` 改為自有的 `AUTH_*` 設定。
- `services/api/src/gameplay`：bootstrap route 允許 Bot principal，第一次 `/game` 時建立 Player 與存檔。
- `services/api/src/identity`：Discord 成為主要身份後，原本「Discord ↔ Clerk User」的瀏覽器綁定 challenge 流程不再需要，需要移除或改寫。
- `services/api/src/closed-beta`：邀請、wipe 中的 Clerk 識別改為 `authSubject`。
- 文件：D-04、D-05、`api-production-security-composition.md`、`d05-wipe-retention-authority.md` 與 handoff 文件同步更新。

## 驗證與連結

- API 測試改用自有 issuer 簽出的測試 token，不再出現 Clerk 設定。
- Postgres 整合測試（`test:d04:postgres`、`test:d05:postgres`）在改名後通過，RLS 仍以 `request.jwt.claim.sub` 隔離。
- 端到端：新 Discord 使用者第一次執行 `/game status` 會建立 Player 與存檔；同一使用者重複執行不會重複建立。
- [Roadmap](../roadmap.md) M1。
