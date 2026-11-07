# Econ Game Internal SDK

`@econ-game/sdk` is a dependency-free, TypeScript-first client package for the HTTP routes that exist in this repository today. It is intentionally **internal** and **0.x**: it is not a published public API and it must not be used to infer future game rules, identity, money, authorization, idempotency, or deployment behavior.

## Contract boundary

The repository currently contains two incompatible HTTP surfaces. The architecture record identifies the Node/TypeScript line as the product direction; the Python/uv surface remains an isolated preview. The SDK therefore exposes two deliberately separate clients rather than hiding a choice behind a common `EconGameClient`.

| Client | Source of truth | Current routes | Status |
|---|---|---|---|
| `createGameplayApiClient` | P0 gameplay composition | bootstrap, active save, scoped projection, replay recovery/polling, and six typed mutations | Supported Node production gameplay surface; server derives actor, tenant, membership, role, seeds, and authority. |
| `createGameCommandClient` | D02 command composition | `POST /saves/:saveId/actions/:commandType` | Supported Node production command surface; server derives actor, tenant, membership, and role. |
| `createPythonPreviewApiClient` | `python/services/api/src/econ_api/routes.py` | health, create/read player | Preview only; do not use for new product work |

`createRestaurantApiClient` is retained only as a legacy compatibility client while callers migrate. Its restaurant/POS/KDS routes are not registered by the production composition and must not be used for new work. The static `check:surface` command compares the SDK's P0 gameplay constants, D02 command route, and Python preview route list. It is not a complete production API route inventory; production composition integration tests remain the authority for that surface.

`GameplayApiClient` is the typed P0 client surface. Bootstrap is Web-only.
Active-save discovery is readable by Discord Bot only when the linked player
already has an active, authorized save; a Bot can never receive or execute the
bootstrap projection. Callers supply the approved Web Bearer/JWT or Bot headers,
and the SDK neither creates nor interprets them. Its scoped read surface is `GET
/saves/:saveId/gameplay`, `GET
/saves/:saveId/preopen/configuration-choices`, `GET
/saves/:saveId/replay-jobs/latest?businessDay=1`, and `GET
/saves/:saveId/replay-jobs/:jobId`. `getLatestReplayJob(saveId, 1)` only recovers
the single existing first-day job after reload; it never creates one and fails
if the server finds an ambiguous job set. Replay recovery and polling keep a
`202` pending result distinct from a terminal `200` result. Its mutation helpers are `initializeCompetitiveSave`,
`configurePreopenDay`, `openBusinessDay`, `advanceServicePeriod`,
`settleBusinessDay`, and `requestDayReplay`. A projection's `expectedVersion`
or a preceding command receipt's `aggregateVersion` is passed unchanged to the
next helper. The client never creates actor, player, tenant, save, role, seed,
money, or other server-authoritative values.

`getPreopenConfigurationChoices(saveId)` is **Web-only**. It reads exact,
server-authoritative Day 1 choices for a `CONFIGURE_PREOPEN_DAY` form and
strictly rejects private simulation, identity, snapshot, accounting, and
transaction fields. It does not build a configuration or change a save.
Discord Bot must not call this route; Bot supports only post-bootstrap
active-save play.

Discord is not a bootstrap client. A Discord interaction can discover and
operate only on a linked active save after the server has established it;
authentication, linking, membership, active scope, D05 eligibility, and Bot
read auditing remain server-enforced. The SDK only forwards caller-provided
headers and never constructs a Discord identity or authorization context.

## Use from a Node or browser consumer

The package relies only on standard `fetch`, `Headers`, `RequestInit`, and `Response`; pass a fetch implementation when a runtime does not provide one. Supply configuration through the consumer's approved configuration boundary, never by placing credentials in source code.

```ts
import {
  EconGameApiError,
  createGameplayApiClient,
} from '@econ-game/sdk';

const api = createGameplayApiClient({
  baseUrl: apiBaseUrl,
  headers: requestHeaders,
});

try {
  const projection = await api.getGameplayProjection(saveId);
  const result = await api.advanceServicePeriod(saveId, {
    commandId,
    idempotencyKey,
    expectedVersion: projection.expectedVersion,
    payload: { businessDay: 1, expectedPeriodKey: 'LUNCH', ownerAssignment: 'NONE' },
  });
  // Render the server-authoritative command result.
} catch (error) {
  if (error instanceof EconGameApiError) {
    console.error(error.status, error.code, error.path);
  }
  throw error;
}
```

`ApiMoney` is `string | number` because the current Prisma response serialization must not be guessed by clients. Keep the original value until the owning product contract specifies money semantics and rounding.

## Mutations

`GameplayApiClient` and `GameCommandClient` require a caller-provided idempotency key and expected aggregate version. The server, not the client, derives the actor, tenant, membership, role, and allowed save scope. The SDK does not retry mutations automatically.

```ts
import {
  COMMAND_ENVELOPE_VERSION,
  createGameCommandClient,
} from '@econ-game/sdk';

const api = createGameCommandClient({ baseUrl: apiBaseUrl });
await api.executeSaveAction(saveId, commandType, {
  schemaVersion: COMMAND_ENVELOPE_VERSION,
  commandId,
  idempotencyKey,
  commandType,
  aggregateId: saveId,
  expectedVersion,
  payload,
});
```

The SDK never reads `.env` files, opens a database connection, starts a service, invokes Prisma, or deploys anything.

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

Whenever a supported route source changes, update the client types, source-surface list, tests, this README, `docs/sdk/current-http-surface.md`, the SDK skill reference, and the technology source map in one review. Legacy compatibility routes are not a production contract. If a change touches any undecided Architecture contract (especially identity, money, permission, idempotency, or game rules), stop and obtain the relevant decision first.
