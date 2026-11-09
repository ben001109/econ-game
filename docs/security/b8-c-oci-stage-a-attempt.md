# B8-C Stage A OCI manifest attempt

## Scope

This record preserves the single approved Stage A manifest-inspection attempt.
It changes only supply-chain evidence and its checker. It does not pull image
layers, build or run containers, scan images, deploy anything, install tools,
or read secret files.

## Result

The representative immutable reference
`node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32`
was submitted to `docker buildx imagetools inspect` through the `orbstack`
context. Docker Hub answered unauthenticated HTTP 429 (`Too Many Requests`).
The handoff did not retain the command-start timestamp or exit code; the exact
evidence-recording timestamp is `2026-08-16T16:53:21Z` and the distinction is
preserved in the machine-readable record.

No registry retry was made. Consequently, none of the 13 unique immutable
references has a Stage A manifest result. `cosign` and `oras` are not
installed, and a trusted publisher identity policy has not been selected.

## Fail-closed status

This is failed/blocked attempt evidence, not a successful manifest, signature,
attestation, runtime, or layer-CVE result. The supply-chain checker continues
to report both blocking OCI evidence gaps.

## Validation

- `node --test scripts/check-supply-chain.test.mjs`
- `node scripts/check-supply-chain.mjs --json` (expected failure from explicit
  OCI evidence gaps)
- `git diff --check`
