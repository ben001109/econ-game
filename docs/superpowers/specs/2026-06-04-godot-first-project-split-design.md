# Godot-first Econ Game Project Split & Roadmap

## Direction

The project is an economic and industry-chain simulation game. Restaurants are the first playable business, but the long-term design expands into surrounding supply-chain industries.

Godot is the primary Steam game client. Discord BOT is a companion interface for lightweight operations, notifications, leaderboards, and Discord community activity. The web frontend remains admin/dev tooling.

## Architecture

Keep the monorepo and split responsibilities inside it first:

```text
packages/game-core  gameplay rules, state transitions, economy calculations
packages/content    base game data and DLC-style content packs
packages/shared     DTOs, status codes, and shared types
services/api        persistence, auth, sync, Godot/BOT API
services/worker     settlement, events, supplier prices, leaderboards
services/bot        Discord companion commands and notifications
services/frontend   admin/dev tooling
clients/godot       primary Steam client
```

## Product Boundaries

Godot owns the main player experience: 2D management UI first, then storefront visualization later. BOT supports low-frequency actions such as `/status`, `/daily`, `/inventory low`, `/supplier deals`, `/restock`, `/leaderboard`, and `/event join`.

BOT should not own complete POS/KDS flows, recipe editing, building/layout controls, market trading UI, or full industry-chain management.

## MVP Loop

1. Create or load a restaurant.
2. Select menu items.
3. Buy ingredients from NPC suppliers.
4. Receive inventory.
5. Run a business period automatically.
6. Consume ingredients based on demand.
7. Earn revenue.
8. Run daily settlement.
9. Review profit, costs, inventory, and unlocks.
10. Upgrade or unlock new menu items and suppliers.

## Supply-chain Roadmap

Phase 1 uses NPC suppliers to stabilize the core loop. Phase 2 adds supplier variation, delays, freshness, shortages, and regional availability. Phase 3 adds player markets. Phase 4 adds playable industry roles such as farms, fisheries, logistics, wholesalers, and central kitchens.

## DLC Boundary

DLC should primarily be content and system expansion: regions, cuisines, supplier networks, industries, events, seasonal mechanics, central kitchens, chain stores, automation, staff systems, and later visual storefront cosmetics.

## Recommended First Slice

Implement the foundation before Godot UI work: update roadmap/docs, add `packages/game-core`, `packages/content`, and `packages/shared`, add one tested restaurant simulation action, then wire future API/BOT/Godot work through those boundaries.
