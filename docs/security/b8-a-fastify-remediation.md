# B8-A Fastify/find-my-way remediation

## Scope

This batch updates only the API Fastify dependency chain, its error-boundary
type compatibility, a focused route-contract regression test, and the
generated supply-chain evidence. It does not change schemas, migrations,
Python dependencies, Bun/OCI inputs, or deployment configuration.

## Minimal compatible resolution

Official npm audit evidence identified Fastify `<=5.8.4` and find-my-way
`<=9.6.0` as the two API high findings. The minimum Fastify fix is `5.8.5`.
The existing Fastify 5 range permits find-my-way 9, and the locked
`find-my-way@9.8.0` clears the current advisory without a Fastify major
upgrade.

- Direct constraint: `fastify` `^5.6.1` -> `^5.8.5`.
- Resolved lock: Fastify `5.6.1` -> `5.8.5`; find-my-way `9.3.0` -> `9.8.0`.
- Provenance: official npm registry metadata and
  `npm audit --package-lock-only --ignore-scripts --json`.

Fastify's newer error-handler typing exposes its error as `unknown`. The
composition now narrows only `code` and `statusCode` through a local metadata
guard. This preserves the existing 413/4xx/500 response envelopes; the added
route test verifies a 422 error never leaks its internal message.

## Validation

In an isolated temporary API copy that excluded every `.env*` path:

1. `npm ci --ignore-scripts` passed.
2. `npm run lint` passed with 0 errors and 14 pre-existing warnings.
3. `npm run typecheck` passed.
4. `npm test` passed: 153/153, including the new Fastify error-boundary test.
5. `npm run build` passed.
6. `npm audit --package-lock-only --ignore-scripts --json` reported 0
   vulnerabilities.

The B7 evidence generator is rerun after this change; no evidence counts are
edited by hand.
