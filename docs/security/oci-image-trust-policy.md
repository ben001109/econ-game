# OCI image trust policy

- **Status:** adopted 2026-11-08
- **Machine-readable policy:** [`oci-image-trust-policy.json`](oci-image-trust-policy.json)
- **Evidence:** [`oci-image-trust-evidence.json`](oci-image-trust-evidence.json), written by `node scripts/collect-oci-image-evidence.mjs --write`
- **Enforced by:** `scripts/check-supply-chain.mjs` (`auditImageTrust`)

## Why signatures are not required

The standard verification flow (`cosign verify` against a named signing identity) needs the publisher to sign. On 2026-11-08 none of the pinned images had a Sigstore signature (`cosign tree` found no artifacts). Docker Official Images publish none, and Sigstore signing for them is still an open roadmap item (docker/roadmap#562). Docker Content Trust (Notary v1) is being retired, so it is not used either.

Until upstream signs, an image is trusted when all of the following hold:

1. **Digest pinning.** Every `FROM` and Compose `image:` uses `@sha256:`, and Stage A confirms that each reference resolves in its registry.
2. **Provenance.** The image carries BuildKit SLSA provenance. Its builder is `https://github.com/docker-library`, and its source is the repository the policy lists for that image. These attestations are **not signed**. They prove only that the provenance stored next to the pinned digest names the expected source, so they detect a wrong image but not a compromised registry.
3. **A current scan.** trivy scanned the image for `linux/amd64` at most `maxScanAgeDays` (30) days ago.

## Production images

`node:22-alpine` (runtime base for api, worker and bot), `postgres:16-alpine` and `redis:7-alpine` must also meet these rules:

- No CRITICAL or HIGH OS-package finding that has a fix. Fix these by moving the digest to the patched upstream build.
- The image OS is still supported (trivy `EOSL` is false).
- Every CRITICAL or HIGH language-package finding sits under an accepted risk:

| Image | Location | Reason |
|---|---|---|
| `node:22-alpine` | `usr/local/lib/node_modules/npm/` | Dependencies bundled inside the npm CLI that ships with Node. The services run `node` directly; npm only runs during image builds. |
| `postgres:16-alpine` | `usr/local/bin/gosu` | Go standard-library findings in gosu, which docker-library builds with an older Go toolchain. gosu only drops privileges once at container start. |

Each accepted risk has a `reviewBy` date, and the checker fails once that date passes. Review means rescanning and confirming that the findings are still confined to that location. Then move the date, or drop the entry if upstream has fixed it.

## Development and tool images

`node:22-bookworm-slim` (the dev profile) and `adminer:4` (the tools profile) need digest pinning and matching provenance. Their scan results are recorded but do not block, because they never run in production.

An image without listed provenance fails as `IMAGE_NOT_ALLOWED`. This is why `rediscommander/redis-commander` was removed on 2026-11-08: it had no provenance, it runs on Alpine 3.12 (end of life since 2022), and it carried 12 critical findings with no newer upstream build. Redis Insight (`redis/redisinsight`) is the candidate replacement if a Redis UI is needed again.

## Refreshing the evidence

```bash
docker login            # optional; anonymous Docker Hub pulls are limited to 100 per hour
node scripts/collect-oci-image-evidence.mjs --write
node scripts/generate-supply-chain-evidence.mjs --write
node scripts/check-supply-chain.mjs
```

Run it whenever a digest changes and at least every 30 days. trivy downloads image layers into its own cache, which the evidence records as `sideEffects.imageLayersPulled`; nothing is built, run or deployed.

## Moving to signed images later

Docker Hardened Images (`dhi.io`) are free under Apache 2.0 and cover node, postgres and redis, including `-dev` variants with a package manager. They are signed with a Docker-published cosign key rather than a keyless identity, and pulling requires a Docker login. Chainguard images are signed keylessly, but the free tier only offers `latest`. If the project moves to either, set `signatures.required` to `true`, record the verified signature in the evidence, and pin the expected key or identity in the policy.
