# Godot-first Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorient the existing monorepo toward a Godot-first game with BOT companion support by updating roadmap docs and adding the first shared package boundaries for game rules, content, and API types.

**Architecture:** Keep the monorepo and introduce `packages/game-core`, `packages/content`, and `packages/shared` as buildable TypeScript packages. Do not move existing API/BOT behavior yet; create a tested game-core action surface that future API, worker, BOT, and Godot integration can call.

**Tech Stack:** TypeScript 5.9, Node 20, npm package scripts, built-in `node:test`, existing ESLint/Prettier conventions, existing Fastify/Prisma services.

---

## Tasks

1. Update `todo.md` so roadmap direction is Godot-first, BOT companion, and staged supply-chain expansion.
2. Add buildable `packages/game-core` with a tested `simulateBusinessPeriod` restaurant simulation function.
3. Add `packages/content` with base ingredients, NPC supplier data, and menu item content.
4. Add `packages/shared` with Godot/BOT-facing DTOs for restaurant status and restock operations.
5. Add the three packages to CI lint/build matrices.
6. Update `README.md` with Godot-first architecture and shared package boundaries.
7. Run package and service verification.

## Execution Notes

Each task should be implemented with focused commits and verification. The first slice intentionally does not implement Godot UI, cloud sync, Discord identity linking, player markets, DLC packaging, or API endpoint extraction; those should be separate follow-up plans after this foundation exists.
