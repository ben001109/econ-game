# B7-D supply-chain evidence and checker

## Scope

This batch refreshes only the supply-chain evidence, its deterministic
generator/checker, and checker tests. It does not alter application code,
schemas, migrations, package manifests, or any npm, uv, or Bun lockfile.

## Reproducible evidence

At `2026-08-16T16:14:24.639Z`,
`scripts/generate-supply-chain-evidence.mjs --write` obtained all online
inputs before replacing `docs/security/supply-chain-evidence.json`. The
generator fails before writing when a required npm audit, OSV batch response,
official Node lifecycle response, runtime identity check, Bun version check,
or static OCI enumeration is incomplete.

- npm source: `https://registry.npmjs.org/-/npm/v1/security/audits/quick` via
  `npm audit --package-lock-only --ignore-scripts --json`, once for each of
  the five existing npm locks. B8-A subsequently remediated the API Fastify
  chain; the regenerated report is authoritative for current audit results.
- Python source: `https://api.osv.dev/v1/querybatch`, querying all 54
  `uv.lock` name/version pairs. B8-B subsequently remediated the FastAPI /
  Starlette chain; the regenerated report is authoritative for current OSV
  results.
- Node source:
  `https://raw.githubusercontent.com/nodejs/Release/main/schedule.json`.
  The runtime evidence records `.nvmrc` `22`, executing `v22.23.1`, and the
  official Node 22 end date of `2027-04-30`.
- Bun evidence binds all four text locks, generated and frozen-verified in
  B7-B with Bun `1.3.14`.
- OCI evidence statically re-enumerates 47 occurrences and 13 unique
  `tag@sha256:` references. The authoritative registry manifest provenance is
  retained from B7-C at `2026-08-16T16:03:07Z`.
- B8-C Stage A is separately recorded at `2026-08-16T16:53:21Z`. Its one
  representative Docker Hub manifest request was unauthenticated and received
  HTTP 429; it is blocked evidence, not a successful manifest result.

The evidence binds SHA-256 values for all five npm locks, `uv.lock`, and all
four Bun locks. The checker recomputes those hashes, requires Bun text-lock
format version 1, validates frozen Bun contracts, and compares every current
image occurrence to the exact recorded immutable-reference set.

## Deliberately red findings

The checker is intentionally not green. It fails closed for:

- External OCI validation: B7-C/B7-D neither pulled, built, started, nor
  deployed an image, and no signature/attestation or layer-CVE scan result is
  available. The subsequent B8-C Stage A attempt is still 0/13 manifest
  reviews because Docker Hub returned unauthenticated HTTP 429. Digest
  provenance is static and registry-derived only.

## Validation

1. `node --test scripts/check-supply-chain.test.mjs` passed: 42 tests.
2. `node scripts/check-supply-chain.mjs --json` reports only the documented
   current npm and Python findings plus explicit evidence gaps; it reports no
   stale lock, Bun, OCI, or Node 22 evidence finding.
3. An online generation pass completed with official npm, OSV, and Node
   sources. The generator performed no dependency installation, image pull,
   build, container start, deployment, or secret-file read.
