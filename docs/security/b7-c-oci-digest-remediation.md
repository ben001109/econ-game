# B7-C OCI immutable digest remediation

## Scope and provenance

This batch pins all 47 mutable image occurrences across 12 Node/Bun/Python
Dockerfiles, both Compose files, and eight Pterodactyl egg JSON files. No
application dependency, Bun lock/install policy, schema, migration, or
runtime behavior was changed.

At `2026-08-16T16:03:07Z`, each source tag was read from its authoritative
Docker Hub or GHCR registry with:

```sh
docker buildx imagetools inspect IMAGE --format '{{json .}}'
```

For manifest indexes, the index digest is pinned so every platform previously
advertised by the tag remains selectable. `rediscommander/redis-commander` is
an authoritative single Docker v2 manifest rather than a platform index.

## Exact tag-to-digest mappings

| Source tag | Immutable reference | Registry media type | Advertised platform(s) |
| --- | --- | --- | --- |
| `adminer:4` | `adminer:4@sha256:c1c24d89d06fcb8fc0fb5a049240dc292ff4a121ae05d7e74d64b58c421d2921` | OCI index | linux/386, amd64, arm/v6, arm/v7, arm64/v8, ppc64le, riscv64, s390x |
| `ghcr.io/astral-sh/uv:python3.12-bookworm-slim` | `ghcr.io/astral-sh/uv:python3.12-bookworm-slim@sha256:e5b65587bce7de595f299855d7385fe7fca39b8a74baa261ba1b7147afa78e58` | OCI index | linux/amd64, arm64 |
| `ghcr.io/parkervcp/installers:debian` | `ghcr.io/parkervcp/installers:debian@sha256:1806d6b09c010098075114b08e40cb0d38be2c68026dbca62ef13abd03946dc3` | OCI index | linux/amd64, arm64 |
| `ghcr.io/parkervcp/yolks:bun_canary` | `ghcr.io/parkervcp/yolks:bun_canary@sha256:9b1f27040825f8780e29fe9a23af4e5a1e6877e38a4efb35388cfc2f90a25169` | OCI index | linux/amd64, arm64 |
| `ghcr.io/parkervcp/yolks:bun_latest` | `ghcr.io/parkervcp/yolks:bun_latest@sha256:4966f0b03e3d702844c03b39ae5375f282ee3dd23a23b1c96b2ed89a797fca4f` | OCI index | linux/amd64, arm64 |
| `ghcr.io/parkervcp/yolks:python_3.12` | `ghcr.io/parkervcp/yolks:python_3.12@sha256:6d63db2d155cee53f3cf82ba6dea8d0a46a21dd0e0fb445b88d89af0a4222eed` | OCI index | linux/amd64, arm64 |
| `node:22-alpine` | `node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32` | OCI index | linux/amd64, arm/v6, arm/v7, arm64/v8, s390x |
| `node:22-bookworm-slim` | `node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436` | OCI index | linux/amd64, arm/v7, arm64/v8, ppc64le |
| `node:22-bullseye-slim` | `node:22-bullseye-slim@sha256:97924c8c7170c7a4c4464a281cc1f9569816496e546afbac17c4f2723397e116` | OCI index | linux/amd64, arm/v7, arm64/v8 |
| `oven/bun:1.1-alpine` | `oven/bun:1.1-alpine@sha256:ae1ee3f0e326ad8ae886bd500929e7f4fcb4986a1455d6d6ab2f3c2498036aad` | OCI index | linux/amd64, arm64 |
| `postgres:16-alpine` | `postgres:16-alpine@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685` | OCI index | linux/386, amd64, arm/v6, arm/v7, arm64/v8, ppc64le, riscv64, s390x |
| `redis:7-alpine` | `redis:7-alpine@sha256:e7723ff73d963f5cc6d9c4643ea3d989527a402a319239054e9472a7fb9219a2` | OCI index | linux/386, amd64, arm/v6, arm/v7, arm64/v8, ppc64le, riscv64, s390x |
| `rediscommander/redis-commander:latest` | `rediscommander/redis-commander:latest@sha256:19cd0c49f418779fa2822a0496c5e6516d0c792effc39ed20089e6268477e40a` | Docker v2 manifest | Registry did not publish a manifest index |

## Verification completed

1. A static parser enumerated exactly 47 image occurrences before the change
   and 13 unique source tags.
2. Each occurrence was replaced with the matching `tag@sha256:` reference;
   the replacement operation asserted exactly 47 substitutions.
3. A static parser confirmed the Dockerfile `FROM`, Compose `image:`, and
   Pterodactyl `docker_images` plus installer-container fields contain 47
   pinned occurrences and 13 unique immutable references.
4. Both Compose files pass `docker compose config -q` with environment-file
   resolution and interpolation disabled; YAML and all Pterodactyl egg JSON
   syntax also pass. The only warning is the pre-existing obsolete Compose
   `version` attribute in `docker-compose.python.yml`.

## Residual risks

- No image was pulled, built, started, or scanned for layer CVEs in this batch.
- Digest pinning preserves the registry state at the provenance timestamp but
  does not establish publisher signature or attestation verification.
- The single-manifest Redis Commander tag has no manifest-list platform data;
  deployment platform compatibility is therefore not independently expanded
  beyond the behavior of the original tag.
