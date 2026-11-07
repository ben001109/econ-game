# B7-B Bun reproducibility remediation

## Scope

This batch creates Bun text lockfiles for the API, bot, frontend, and worker,
and makes their existing Pterodactyl Bun eggs fail closed unless a matching
`bun.lock` is present. It does not modify package manifests, npm lockfiles,
Dockerfiles, OCI references, Python, evidence/checker code, schemas, or
migrations.

## Generation provenance

- Bun version: `1.3.14`.
- Command per service: `bun install --lockfile-only --ignore-scripts
  --save-text-lockfile`.
- Bun migrated each lock from that service's existing `package-lock.json`; no
  dependency lifecycle scripts ran. The lockfile-only operation performed no
  package installation; pre-existing workspace `node_modules` directories were
  left untouched.
- The workspace invocation emitted only `.env`/`.env.local` filenames during
  Bun environment discovery; no environment contents were exposed or recorded.
- The package manifests and npm lockfiles retained their pre-generation SHA-256
  values.

| Service | Migrated package count | `bun.lock` SHA-256 |
| --- | ---: | --- |
| api | 612 | `4d6f47c8648ef540358b848b7f80fc2ebcf087ab8439efd3a426c6a174f2bf1f` |
| bot | 522 | `00363ca90078437c990ce82acf935122bed0d5b5d0492b7490ffd784349e9c73` |
| frontend | 565 | `865a3987e698db27ae490699f6388daeb059628dfe0b504fbe1df8666397428f` |
| worker | 560 | `f6517524b1562557d7bd118097911bf47b3249903670e6e03d903e0b54d3aa7f` |

## Runtime contract

Each `pterodactyl/eggs/econ_*_bun.json` startup command now performs:

```sh
test -f bun.lock
bun install --production --frozen-lockfile --ignore-scripts
```

The existing four Bun Dockerfiles were intentionally unchanged; each already
copies `package.json bun.lock*` and installs with `--frozen-lockfile`.

## Verification completed

1. In a clean `/private/tmp` copy containing only each `package.json` and
   `bun.lock`, with no `.env*` files, each service completed
   `bun install --frozen-lockfile --ignore-scripts` using Bun 1.3.14.
2. SHA-256 comparisons confirmed every lock in the temporary verification copy
   exactly matches its workspace lock.
3. Structural checks confirmed all four Dockerfiles retain the frozen-copy
   contract and all four eggs require `bun.lock`, `--frozen-lockfile`, and
   `--ignore-scripts`.
4. The egg JSON files and the scoped diff pass `git diff --check`.

## Residual risks

- This batch does not build the Bun Docker images or start Pterodactyl. Those
  runtime checks remain for a later authorized container/runtime batch.
- Egg deployments must include the corresponding service `bun.lock`; the new
  fail-closed command intentionally prevents an unlocked panel deployment.
- Dependency CVEs are not re-audited here; B7-D remains responsible for fresh
  supply-chain evidence.
