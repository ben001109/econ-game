# Current HTTP Surface for the Internal SDK

> **Status:** implementation snapshot, not an Architecture-approved public contract
>
> **Owner:** API owner for Node routes; Python preview owner for preview routes; Build/SDK owner for client packaging
>
> **Last checked:** 2026-08-01

This document makes the package boundary reviewable without treating runtime Swagger output or database models as a public contract. The source-only verifier at [`packages/econ-game-sdk/scripts/check-source-surface.mjs`](../../packages/econ-game-sdk/scripts/check-source-surface.mjs) compares these supported route sets with the actual route declarations. It never starts a server, reads an environment file, contacts a database, or calls a queue.

## Node/Fastify restaurant scaffold

Source: [`services/api/src/index.ts`](../../services/api/src/index.ts). Client module: `createRestaurantApiClient`.

| Method | Route | SDK method | Notes |
|---|---|---|---|
| GET | `/health` | `getHealth()` | Process health only in the current route. |
| GET | `/restaurants` | `listRestaurants()` | Returns restaurants with branches and tables. |
| POST | `/bootstrap` | `bootstrapDemo({ confirm })` | Explicit demo-data mutation; requires the exported confirmation constant. |
| GET | `/menus` | `listMenuItems()` | Returns current menu-item records. |
| POST | `/orders` | `createOrder(input)` | Current scaffold's POS order creation. |
| POST | `/orders/:id/items` | `addOrderItem(id, input)` | Current scaffold accepts an item payload. |
| POST | `/orders/:id/payments` | `addPayment(id, input)` | Current scaffold accepts a payment payload. |
| GET | `/orders/:id` | `getOrder(id)` | Returns order detail and related records. |
| GET | `/kds/tickets` | `listKdsTickets()` | Returns active tickets. |
| POST | `/kds/tickets/:id/start` | `startKdsTicket(id)` | Current KDS transition. |
| POST | `/kds/tickets/:id/serve` | `serveKdsTicket(id)` | Current KDS transition. |

The SDK preserves money-like fields as `ApiMoney = string | number`; it intentionally does not add rounding or price logic. It also performs no automatic retry of mutations. The Architecture plan requires a different, approved server-side contract before money, authorization, idempotency, or game state may be relied on.

## Python/uv preview player API

Source: [`python/services/api/src/econ_api/routes.py`](../../python/services/api/src/econ_api/routes.py). Client module: `createPythonPreviewApiClient`.

| Method | Route | SDK method | Preview status |
|---|---|---|---|
| GET | `/health` | `getHealth()` | Diagnostic response includes optional dependency status. |
| POST | `/players` | `createPlayer(input)` | Preview-only player route. |
| GET | `/players/{player_id}` | `getPlayer(id)` | Preview-only player route. |

Do not mix this client or its types with the Node product client. No code in this package moves or synchronizes data between the two stacks.

## Review when an endpoint changes

1. Update the service route and its server-side tests first; this SDK cannot validate behavior by static inspection.
2. Update the client method, input/output types, and `check-source-surface.mjs` expected route set in the same review.
3. Add or revise mock-fetch tests for method, path encoding, JSON payload, and non-2xx error behavior.
4. Amend this table and [`packages/econ-game-sdk/README.md`](../../packages/econ-game-sdk/README.md).
5. Run `npm run verify` from the package only after its dependencies are installed; run `git diff --check` from the repository root.
6. If compatibility, identity, authorization, money, idempotency, or product semantics change, stop for Architecture/API owner sign-off rather than inferring the contract.
