# P0-PLAT isolated onboarding command catalog

**Contract version:** `p0-gameplay-command-catalog/v1`
**Status:** supplementary implementation contract; temporarily not reflected in the dirty decision register.

## Isolated invitee invariant

A qualifying closed-beta invitee is associated with exactly one isolated restaurant, one
server-audited active `OWNER` membership, and one competitive save. A client may request a
target `saveId`, but that identifier is non-authoritative. The server derives and validates
the actor, tenant, membership, restaurant, and save scope before a D02 command can execute.
Operational `MANAGER` roles, when present, are server-provisioned additional active operators.
Clients cannot create them; they never replace or alter the invitee's active audited `OWNER`
ownership, and the server validates them against the same scoped save.

## Fixed canonical command order

| Order | D02 command type | Minimal roles | Response semantics | Server-derived projection |
|---:|---|---|---|---|
| 1 | `INITIALIZE_COMPETITIVE_SAVE` | `OWNER` | synchronous `200` | competitive save, opening snapshot, active membership audit |
| 2 | `CONFIGURE_PREOPEN_DAY` | `OWNER`, `MANAGER` | synchronous `200` | save, server-authoritative versioned pre-open menu/prices/prep/layout snapshot |
| 3 | `OPEN_BUSINESS_DAY` | `OWNER`, `MANAGER` | synchronous `200` | save, business day, consumed pre-open snapshot, demand forecast |
| 4 | `ADVANCE_SERVICE_PERIOD` | `OWNER`, `MANAGER` | synchronous `200` | save, business day, service period/state, reputation |
| 5 | `SETTLE_BUSINESS_DAY` | `OWNER`, `MANAGER` | synchronous `200` | save, day-end snapshot, ledger summary, risk state, reputation |
| 6 | `REQUEST_DAY_REPLAY` | `OWNER`, `MANAGER` | accepted `202`; projected `DAY_REPLAY` job | save, replay availability, event hash, snapshot hash |

The order is canonical, not a UI sequence. `REQUEST_DAY_REPLAY` is the only listed command
that requires a job projection; all other commands must produce a synchronous server-derived
projection. Whether a command can proceed still depends on D02 idempotency/version checks and
the server-derived active scope.

## Client authority boundary

Clients may provide command-specific intent plus a target `saveId` and D02 `expectedVersion`
concurrency precondition. Neither input establishes authority: the server derives and
validates actor, tenant, membership, restaurant, and save scope, and validates version against
current aggregate state. Clients cannot authoritatively set actor, player, tenant, restaurant,
membership, role, permission, seed, rule/aggregate version, money, risk, forecast, customer
schedule, capacity, pre-open snapshot, menu, prices, prep, layout, or deterministic E02/E04
derived state. `CONFIGURE_PREOPEN_DAY` accepts only client intent; the server validates and
persists the versioned menu/prices/prep/layout snapshot. `OPEN_BUSINESS_DAY` consumes that
server-authoritative snapshot, after which it is immutable for that business day. In particular, server output owns
demand forecasts and scheduled parties, flow/queue/congestion and front-service delay,
flow-risk flags, food quality, service speed, reputation, ledger summary, and risk state. This
catalog declares the authority boundary only; it does not yet implement runtime rejection.

## Deliberate non-implementation boundary

This catalog is data only. It does **not** yet add D02 registration, an endpoint, persistence
or invitee provisioning, Web/Bot reachability, or gameplay execution. It cannot by itself
make a command callable, persist or enforce pre-open snapshot immutability, or satisfy the
P0-PLAT Web/Discord E2E gate.
