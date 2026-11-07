# Current HTTP Surface for the Internal SDK

> **Status:** implementation snapshot, not an Architecture-approved public contract
>
> **Owner:** API owner for Node routes; Python preview owner for preview routes; Build/SDK owner for client packaging
>
> **Last checked:** 2026-08-01

This document makes the package boundary reviewable without treating runtime Swagger output or database models as a public contract. The source-only verifier at [`packages/econ-game-sdk/scripts/check-source-surface.mjs`](../../packages/econ-game-sdk/scripts/check-source-surface.mjs) compares the D02 command route used by this SDK and the Python preview route list with their designated source modules. It is not a complete production API route inventory; server integration tests are authoritative for production composition. The verifier never starts a server, reads an environment file, contacts a database, or calls a queue.

## Node/Fastify D02 command surface supported by this SDK

Route source: [`services/api/src/commands/command-routes.ts`](../../services/api/src/commands/command-routes.ts). The production composition is assembled in [`services/api/src/app-composition.ts`](../../services/api/src/app-composition.ts). Client module: `createGameCommandClient`.

| Method | Route | SDK method | Notes |
|---|---|---|---|
| POST | `/saves/:saveId/actions/:commandType` | `executeSaveAction(saveId, commandType, envelope)` | D02 command envelope; the server derives trusted actor/scope and rejects legacy client context. |

`GameCommandClient` exposes the approved D02 transport envelope, but it does not create trusted identity or authorization context; D04 does that server-side. The Architecture plan remains authoritative for game rules and money semantics.

## Legacy restaurant/POS/KDS compatibility

`createRestaurantApiClient` and the underlying restaurant/POS/KDS scaffold are migration-only compatibility code. They are never registered by the default or production API composition, where every corresponding path returns `404`. They are excluded from this supported route list and must not be used by new clients or treated as a production public contract.

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
