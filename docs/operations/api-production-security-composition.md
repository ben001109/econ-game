# Production API security composition

The formal Fastify process now has one production composition boundary:
`services/api/src/production-api-composition.ts`. It always uses the durable
PostgreSQL command store. D04 trusted context and the D05 closed-beta gate are
enabled together only when all deployment metadata below is present and valid:

| Runtime key                | Non-secret contract                                            |
| -------------------------- | -------------------------------------------------------------- |
| `CLERK_ISSUER`             | Exact HTTPS issuer accepted in Clerk JWTs.                     |
| `CLERK_JWKS_URL`           | HTTPS JWKS endpoint on the same origin as the issuer.          |
| `CLERK_AUDIENCES`          | Comma-separated API audiences; at least one is required.       |
| `CLERK_AUTHORIZED_PARTIES` | Comma-separated Web origins/parties; at least one is required. |

Bot-originated D02 commands are disabled unless all of the following Bot-only
configuration is present and valid. `BOT_SERVICE_CREDENTIAL_SHA256` is a secret
digest; never place the raw service credential or its digest in client code,
logs, tickets, or this document.

| Runtime key                      | Contract                                                         |
| -------------------------------- | ---------------------------------------------------------------- |
| `BOT_SERVICE_CREDENTIAL_SHA256`  | Lowercase SHA-256 digest of the server-to-server Bot credential. |
| `BOT_SERVICE_PRINCIPAL_ID`       | Stable non-empty server-owned Bot principal identifier.          |
| `BOT_SERVICE_SCOPES`             | Comma-separated server-owned scopes; must include `game:command`. |

The API never accepts Bot scopes from request headers or bodies. Complete Bot
configuration creates the digest verifier and durable actor-resolution audit
sink together. Missing, partial, malformed, or insufficient Bot configuration
leaves Bot requests at the normal unauthenticated (`401`) boundary while leaving
valid Clerk/D04/D05 Web configuration unchanged.

Missing, partial, malformed, cross-origin, or non-HTTPS metadata does not select
an in-memory adapter. Commands remain unauthenticated/fail-closed and D05 routes
return the stable not-configured envelope. The legacy restaurant/POS/KDS routes
are not part of the formal production composition; their remaining adapter is
test-only and must never be passed by the production entrypoint.

## O01 evidence still required

This local wiring does not complete O01 and does not authorize a cloud resource
or secret operation. Before closed-beta promotion, the platform owner must bind
the four keys above in the approved secrets/configuration system and record:

1. deployment/environment identity and immutable candidate commit;
2. issuer, JWKS origin, audience names, and authorized-party names (never token,
   private key, service-role credential, or full secret values);
3. ownership, least-privilege access, rotation, revocation, and access-audit
   evidence for the API principal;
4. a deployment probe showing anonymous `401`, cross-scope `403`, ineligible
   closed-beta `403`, and configured eligible traffic reaching the durable D03
   boundary without any legacy route being registered.

Until that evidence exists, O01 and closed-beta promotion remain blocked even
though the local production composition and its leak-free failure behavior are
testable.
