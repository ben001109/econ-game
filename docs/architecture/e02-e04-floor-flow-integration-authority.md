# E02 → E04 Floor-Flow Integration Authority

## Scope and boundaries

- Domain: simulation floor planning and service-flow interaction for E02 and E04 only.
- In-scope: deterministic mapping of floor profile outputs into E04 admission/queue behavior, replay replayability, and cross-mode consistency.
- Out-of-scope: food quality, menu, inventory, pricing, money economy, RNG, NPC pathfinding, DB/client protocol changes, or migration scripts.

## Source inputs and replay/version binding

- Inputs are fixed at run start as immutable floor profile fields:
  - `version`
  - `layoutRevision`
  - `layoutHash`
  - `spaceCatalogVersion`
  - `seatCapacity`
  - `queueVisibility`
  - `frontServiceDelayTicks`
- Flow derivation and replay rehydration use only the immutable listed profile fields; no scenario-seed input is part of this profile contract.
- The profile is byte-stable serialized and persisted for E04 replay; a replay must deterministically rehydrate the same flow state and produce byte-identical flow outputs for the same replay hash.

## Confirmed policy

1. Admission uses actual guest party size, not seat/2 conversions.
2. Corridor distance/load affect only front-service delay; they do not change admission ceilings directly.
3. `queueVisibility` is fed into E04 queue-congestion calculation and affects congestion handling.
4. Floor service modifiers only affect E04 timing/visibility/path-limited behavior, not other simulation subsystems.

## Invariants

- `periodWeight = 1`
- E04 base constants remain unchanged:
  - `K_WORK = 12`
  - `F_WORK = 8`
- Flow risk condition is strict:
  - Risk when `queueDemandRatio > 1.2` for two consecutive ticks.
  - `ratio == 1.2` is not risk.
- AGED/E04 interaction:
  - `AGED` applies only once to E04 equipment capacity.
  - It is additive with no duplicate application across service stages.

## Explicit non-effects

- No impact on:
  - food quality
  - menu and ingredient model
  - inventory balances
  - pricing or demand elasticity controls
  - money/ledger updates
  - RNG outcomes
  - NPC pathfinding or movement policies
  - direct DB schema/API/client contract changes

## Acceptance evidence target

- 35/35 targeted tests passed (including ordering/party-size, deterministic identity, risk gating, AGED single-application, and cross-system non-effects).
- Decision reference: [decision-register](./decision-register.md) entry for E02.

## Verification status

- API typecheck/build in current branch is still unresolved in this non-final state and must be re-run before closure.
- No `.hermes` changes and no edits to:
  - `mvp-first-milestone.md`
  - tracked code/tests/schema/lockfiles
