import type { FastifyServerOptions } from 'fastify';

import { createApiComposition } from './app-composition.js';
import { CommandError } from './commands/command-contract.js';
import {
  RoleMatrixAuthorizationPolicy,
  mergeCommandRoleMatrices,
} from './auth/authorization.js';
import { CachingJwksProvider, ClerkJwtVerifier, type JwksDocument } from './auth/jwt-verifier.js';
import {
  HashedBotServiceCredentialVerifier,
  PrismaBotActorAuditSink,
  PrismaIdentityScopeRepository,
  type D01BotAuditDatabase,
  type D01IdentityDatabase,
} from './auth/trusted-command-context.js';
import { ClosedBetaService } from './closed-beta/closed-beta.js';
import {
  PrismaClosedBetaRepository,
  type D05Database,
} from './closed-beta/prisma-closed-beta-repository.js';
import { PrismaWipeBatchRepository } from './closed-beta/prisma-wipe-batch-repository.js';
import { WipeBatchService } from './closed-beta/wipe-batch.js';
import type { D03Database } from './domains/ledger/postgres-ledger-store.js';
import {
  COMPENSATE_LEDGER_TRANSACTION,
  POST_LEDGER_TRANSACTION,
} from './domains/ledger/ledger-command.js';
import {
  createBootstrapWebIdentityResolver,
  type DurableBootstrapInitializer,
} from './gameplay/initialize-competitive-save-routes.js';
import { InitializeCompetitiveSaveError } from './gameplay/initialize-competitive-save.js';
import {
  assertMvpBootstrapIntent,
  createMvpServerBootstrapPlan,
} from './gameplay/mvp-bootstrap-plan.js';
import { PrismaDurableBootstrapInitializer } from './gameplay/prisma-durable-bootstrap-initializer.js';
import type { BootstrapSerializableDatabase } from './gameplay/prisma-initialize-competitive-save-repository.js';
import { gameplaySaveScopedCommandRoleMatrix } from './gameplay/gameplay-command-authorization-policy.js';

export type ProductionApiDatabase = D01IdentityDatabase &
  D01BotAuditDatabase &
  D03Database &
  D05Database &
  BootstrapSerializableDatabase;

export type ProductionBotServiceConfiguration = Readonly<{
  credentialSha256: string;
  principalId: string;
  scopes: readonly string[];
}>;

export type ProductionIdentityConfiguration = Readonly<{
  issuer: string;
  jwksUrl: string;
  audiences: readonly string[];
  authorizedParties: readonly string[];
  botService?: ProductionBotServiceConfiguration;
}>;

export type ProductionIdentityEnvironment = Readonly<{
  CLERK_ISSUER?: string;
  CLERK_JWKS_URL?: string;
  CLERK_AUDIENCES?: string;
  CLERK_AUTHORIZED_PARTIES?: string;
  BOT_SERVICE_CREDENTIAL_SHA256?: string;
  BOT_SERVICE_PRINCIPAL_ID?: string;
  BOT_SERVICE_SCOPES?: string;
}>;

export type ProductionApiCompositionOptions = Readonly<{
  database: ProductionApiDatabase;
  identityConfiguration?: ProductionIdentityConfiguration;
  bootstrapInitializer?: DurableBootstrapInitializer;
  logger?: FastifyServerOptions['logger'];
  loadJwks?: (url: string) => Promise<JwksDocument>;
}>;

/**
 * Converts deployment metadata into the all-or-nothing D04 configuration.
 * Missing, partial, or malformed values intentionally produce no identity
 * configuration so the formal command and D05 surfaces stay fail-closed.
 */
export function productionIdentityConfigurationFromEnvironment(
  source: ProductionIdentityEnvironment,
): ProductionIdentityConfiguration | undefined {
  const issuer = nonEmpty(source.CLERK_ISSUER);
  const jwksUrl = nonEmpty(source.CLERK_JWKS_URL);
  const audiences = commaSeparated(source.CLERK_AUDIENCES);
  const authorizedParties = commaSeparated(source.CLERK_AUTHORIZED_PARTIES);
  if (!issuer || !jwksUrl || !audiences || !authorizedParties) return undefined;
  return validatedIdentityConfiguration({
    issuer,
    jwksUrl,
    audiences,
    authorizedParties,
    botService: productionBotServiceConfigurationFromEnvironment(source),
  });
}

/**
 * Formal production composition. D03 always uses the durable database. D04
 * and D05 are enabled together only when the complete Clerk configuration is
 * available; there is no memory or compatibility fallback.
 */
export function createProductionApiComposition(options: ProductionApiCompositionOptions) {
  const common = {
    logger: options.logger,
    durableCommandDatabase: options.database,
  };
  const identity = options.identityConfiguration
    ? validatedIdentityConfiguration(options.identityConfiguration)
    : undefined;
  if (!identity) return createApiComposition(common);

  const jwtVerifier = new ClerkJwtVerifier({
    issuer: identity.issuer,
    audiences: identity.audiences,
    authorizedParties: identity.authorizedParties,
    signingKeys: new CachingJwksProvider({
      fetchJwks: () => (options.loadJwks ?? loadJwksDocument)(identity.jwksUrl),
    }),
  });
  const identityRepository = new PrismaIdentityScopeRepository(options.database);
  const bootstrapInitializer = guardMvpBootstrapInitializer(
    options.bootstrapInitializer ??
      new PrismaDurableBootstrapInitializer(
        options.database,
        createMvpServerBootstrapPlan,
        assertMvpBootstrapIntent,
      ),
  );
  return createApiComposition({
    ...common,
    identitySecurity: {
      jwtVerifier,
      repository: identityRepository,
      authorization: new RoleMatrixAuthorizationPolicy(
        mergeCommandRoleMatrices(
          {
            [POST_LEDGER_TRANSACTION]: ['OWNER', 'MANAGER'],
            [COMPENSATE_LEDGER_TRANSACTION]: ['OWNER', 'MANAGER'],
          },
          gameplaySaveScopedCommandRoleMatrix,
        ),
      ),
      ...(identity.botService
        ? {
            botServiceCredentialVerifier: new HashedBotServiceCredentialVerifier(
              identity.botService.credentialSha256,
              Object.freeze({
                id: identity.botService.principalId,
                scopes: identity.botService.scopes,
              }),
            ),
            botActorAuditSink: new PrismaBotActorAuditSink(options.database),
          }
        : {}),
    },
    closedBetaService: new ClosedBetaService({
      jwtVerifier,
      repository: new PrismaClosedBetaRepository(options.database),
    }),
    wipeBatchService: new WipeBatchService({
      jwtVerifier,
      repository: new PrismaWipeBatchRepository(options.database),
    }),
    bootstrapInitializer,
    bootstrapWebIdentityResolver: createBootstrapWebIdentityResolver({
      jwtVerifier,
      repository: identityRepository,
    }),
  });
}

/**
 * DI is supported for production composition tests and alternative durable
 * adapters, but it must not expand the closed-beta bootstrap contract.
 */
function guardMvpBootstrapInitializer(
  initializer: DurableBootstrapInitializer,
): DurableBootstrapInitializer {
  return Object.freeze({
    durability: 'durable' as const,
    async initialize(input) {
      try {
        assertMvpBootstrapIntent(input.intent);
      } catch (error) {
        if (error instanceof InitializeCompetitiveSaveError) {
          throw new CommandError(error.status, error.code);
        }
        throw error;
      }
      return initializer.initialize(input);
    },
  });
}

async function loadJwksDocument(url: string): Promise<JwksDocument> {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error('JWKS endpoint unavailable');
  return (await response.json()) as JwksDocument;
}

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function commaSeparated(value: string | undefined): readonly string[] | undefined {
  if (!value) return undefined;
  const entries = value.split(',').map((entry) => entry.trim());
  if (entries.length === 0 || entries.some((entry) => !entry || entry.length > 2_000)) {
    return undefined;
  }
  return Object.freeze([...new Set(entries)]);
}

function secureUrl(value: string): URL {
  const parsed = new URL(value);
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    parsed.search
  ) {
    throw new Error('production identity URLs must be plain HTTPS URLs');
  }
  return parsed;
}

function validatedIdentityConfiguration(
  input: ProductionIdentityConfiguration,
): ProductionIdentityConfiguration | undefined {
  const audiences = normalizedEntries(input.audiences);
  const authorizedParties = normalizedEntries(input.authorizedParties);
  if (!audiences || !authorizedParties) return undefined;
  try {
    const issuerUrl = secureUrl(input.issuer);
    const signingKeysUrl = secureUrl(input.jwksUrl);
    if (issuerUrl.origin !== signingKeysUrl.origin) return undefined;
    const botService = input.botService
      ? validatedBotServiceConfiguration(input.botService)
      : undefined;
    return Object.freeze({
      issuer: issuerUrl.toString().replace(/\/$/, ''),
      jwksUrl: signingKeysUrl.toString(),
      audiences,
      authorizedParties,
      ...(botService ? { botService } : {}),
    });
  } catch {
    return undefined;
  }
}

/**
 * Bot service credentials are configured independently of Clerk so a missing
 * Bot-only key cannot weaken web authentication. The all-or-nothing result is
 * deliberately omitted from production composition when incomplete or invalid,
 * leaving Bot requests at the stable 401 boundary.
 */
function productionBotServiceConfigurationFromEnvironment(
  source: ProductionIdentityEnvironment,
): ProductionBotServiceConfiguration | undefined {
  const credentialSha256 = nonEmpty(source.BOT_SERVICE_CREDENTIAL_SHA256);
  const principalId = nonEmpty(source.BOT_SERVICE_PRINCIPAL_ID);
  const scopes = commaSeparated(source.BOT_SERVICE_SCOPES);
  if (!credentialSha256 || !principalId || !scopes) return undefined;
  return validatedBotServiceConfiguration({ credentialSha256, principalId, scopes });
}

function validatedBotServiceConfiguration(
  input: ProductionBotServiceConfiguration,
): ProductionBotServiceConfiguration | undefined {
  const principalId = input.principalId.trim();
  const scopes = normalizedEntries(input.scopes);
  if (
    !/^[0-9a-f]{64}$/.test(input.credentialSha256) ||
    !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/.test(principalId) ||
    !scopes ||
    !scopes.includes('game:command')
  ) {
    return undefined;
  }
  return Object.freeze({
    credentialSha256: input.credentialSha256,
    principalId,
    scopes,
  });
}

function normalizedEntries(entries: readonly string[]): readonly string[] | undefined {
  const normalized = entries.map((entry) => entry.trim());
  if (normalized.length === 0 || normalized.some((entry) => !entry || entry.length > 2_000)) {
    return undefined;
  }
  return Object.freeze([...new Set(normalized)]);
}
