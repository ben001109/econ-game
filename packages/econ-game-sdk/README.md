# Econ Game Internal SDK

`@econ-game/sdk` is a dependency-free, TypeScript-first client package for the HTTP routes that exist in this repository today. It is intentionally **internal** and **0.x**: it is not a published public API and it must not be used to infer future game rules, identity, money, authorization, idempotency, or deployment behavior.

## Contract boundary

The repository currently contains two incompatible HTTP surfaces. The architecture record identifies the Node/TypeScript line as the product direction; the Python/uv surface remains an isolated preview. The SDK therefore exposes two deliberately separate clients rather than hiding a choice behind a common `EconGameClient`.

| Client | Source of truth | Current routes | Status |
|---|---|---|---|
| `createRestaurantApiClient` | `services/api/src/index.ts` | health, restaurant/menu browse, demo bootstrap, POS orders/payments, KDS | Current Node scaffold; not the future authoritative game contract |
| `createPythonPreviewApiClient` | `python/services/api/src/econ_api/routes.py` | health, create/read player | Preview only; do not use for new product work |

The static `check:surface` command compares those route declarations with the SDK's supported route lists. It is a drift alarm, not a replacement for API integration tests or an OpenAPI compatibility policy.

## Use from a Node or browser consumer

The package relies only on standard `fetch`, `Headers`, `RequestInit`, and `Response`; pass a fetch implementation when a runtime does not provide one. Supply configuration through the consumer's approved configuration boundary, never by placing credentials in source code.

```ts
import {
  EconGameApiError,
  createRestaurantApiClient,
} from '@econ-game/sdk';

const api = createRestaurantApiClient({
  baseUrl: apiBaseUrl,
  headers: requestHeaders,
});

try {
  const tickets = await api.listKdsTickets();
  // Render or transform the returned ticket read model.
} catch (error) {
  if (error instanceof EconGameApiError) {
    console.error(error.status, error.code, error.path);
  }
  throw error;
}
```

`ApiMoney` is `string | number` because the current Prisma response serialization must not be guessed by clients. Keep the original value until the owning product contract specifies money semantics and rounding.

## Mutations and demo data

All mutating methods call the current server exactly once; the SDK does not retry them. In particular, it cannot add idempotency or authorization to an API that has not yet defined those contracts. `bootstrapDemo` has a required confirmation token to avoid accidentally creating sample rows:

```ts
import {
  DEMO_BOOTSTRAP_CONFIRMATION,
  createRestaurantApiClient,
} from '@econ-game/sdk';

const api = createRestaurantApiClient({ baseUrl: apiBaseUrl });
await api.bootstrapDemo({ confirm: DEMO_BOOTSTRAP_CONFIRMATION });
```

Only use the demo bootstrap in an explicitly disposable environment. The SDK never reads `.env` files, opens a database connection, starts a service, invokes Prisma, or deploys anything.

## Development and verification

Install the package's pinned development toolchain in this package directory before invoking npm scripts in a clean checkout. The repository-wide quality gate does not currently include this package, so run its verification explicitly:

```bash
cd packages/econ-game-sdk
npm ci
npm run verify
npm run pack:dry-run
```

`verify` performs a source-only route check, compiles with TypeScript, and runs mock-fetch tests. It requires neither a running service nor credentials. Do not substitute this for a server-backed contract test once an approved product API contract exists.

## Maintenance rule

Whenever either route source changes, update the client types, source-surface list, tests, this README, `docs/sdk/current-http-surface.md`, the SDK skill reference, and the technology source map in one review. If the change touches any undecided Architecture contract (especially identity, money, permission, idempotency, or game rules), stop and obtain the relevant decision first.
