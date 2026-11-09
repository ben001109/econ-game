import {
  createPublicKey,
  createHash,
  timingSafeEqual,
  verify as verifySignature,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto';

const compactSegmentPattern = /^[A-Za-z0-9_-]+$/;

export class JwtVerificationError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'JwtVerificationError';
    this.code = code;
  }
}

export type VerifiedJwtIdentity = Readonly<{
  subject: string;
  issuer: string;
  audience: readonly string[];
  authorizedParty: string;
  issuedAt?: number;
  expiresAt: number;
}>;

export interface JwtVerifier {
  verify(
    token: string,
    options?: Readonly<{ expectedNonce?: string }>,
  ): Promise<VerifiedJwtIdentity>;
}

export interface SigningKeyProvider {
  getSigningKey(kid: string, algorithm: string): Promise<KeyObject>;
}

export type JwksDocument = Readonly<{ keys: readonly JsonWebKey[] }>;

export type CachingJwksProviderOptions = Readonly<{
  fetchJwks: () => Promise<JwksDocument>;
  cacheTtlMs?: number;
  minimumRefreshIntervalMs?: number;
  now?: () => number;
}>;

type CachedSigningKey = Readonly<{ algorithm?: string; key: KeyObject }>;

/**
 * Bounded JWKS cache. A new kid may trigger one throttled refresh for rotation;
 * a missing/duplicate/incompatible kid always fails closed.
 */
export class CachingJwksProvider implements SigningKeyProvider {
  private readonly fetchJwks: () => Promise<JwksDocument>;
  private readonly cacheTtlMs: number;
  private readonly minimumRefreshIntervalMs: number;
  private readonly now: () => number;
  private keys = new Map<string, CachedSigningKey>();
  private expiresAt = 0;
  private lastRefreshAttemptAt = Number.NEGATIVE_INFINITY;
  private refreshInFlight: Promise<void> | undefined;

  constructor(options: CachingJwksProviderOptions) {
    this.fetchJwks = options.fetchJwks;
    this.cacheTtlMs = options.cacheTtlMs ?? 5 * 60_000;
    this.minimumRefreshIntervalMs = options.minimumRefreshIntervalMs ?? 1_000;
    this.now = options.now ?? Date.now;
    if (this.cacheTtlMs <= 0 || this.minimumRefreshIntervalMs < 0) {
      throw new Error('JWKS cache policy must use positive TTL and non-negative refresh interval');
    }
  }

  async getSigningKey(kid: string, algorithm: string): Promise<KeyObject> {
    if (!kid || kid.length > 200) throw new JwtVerificationError('JWT_KID_INVALID');
    const now = this.now();
    const cached = this.keys.get(kid);
    if (cached && now < this.expiresAt) return this.assertAlgorithm(cached, algorithm);

    const mayRefresh = now - this.lastRefreshAttemptAt >= this.minimumRefreshIntervalMs;
    if (mayRefresh) await this.refresh();

    const rotated = this.keys.get(kid);
    if (!rotated) throw new JwtVerificationError('JWT_KID_UNKNOWN');
    if (now >= this.expiresAt) throw new JwtVerificationError('JWKS_REFRESH_THROTTLED');
    return this.assertAlgorithm(rotated, algorithm);
  }

  private assertAlgorithm(entry: CachedSigningKey, algorithm: string): KeyObject {
    if (entry.algorithm !== undefined && entry.algorithm !== algorithm) {
      throw new JwtVerificationError('JWT_KEY_ALGORITHM_MISMATCH');
    }
    return entry.key;
  }

  private async refresh(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.performRefresh();
    try {
      await this.refreshInFlight;
    } finally {
      this.refreshInFlight = undefined;
    }
  }

  private async performRefresh(): Promise<void> {
    const fetchedAt = this.now();
    this.lastRefreshAttemptAt = fetchedAt;
    let document: JwksDocument;
    try {
      document = await this.fetchJwks();
    } catch {
      throw new JwtVerificationError('JWKS_FETCH_FAILED');
    }
    if (!document || !Array.isArray(document.keys)) {
      throw new JwtVerificationError('JWKS_DOCUMENT_INVALID');
    }

    const nextKeys = new Map<string, CachedSigningKey>();
    for (const jwk of document.keys) {
      if (
        typeof jwk.kid !== 'string' ||
        !jwk.kid ||
        jwk.kty !== 'RSA' ||
        (jwk.use !== undefined && jwk.use !== 'sig') ||
        (jwk.key_ops !== undefined && !jwk.key_ops.includes('verify'))
      ) {
        continue;
      }
      if (nextKeys.has(jwk.kid)) throw new JwtVerificationError('JWKS_DUPLICATE_KID');
      try {
        const key = createPublicKey({ key: jwk, format: 'jwk' });
        if (
          key.asymmetricKeyType !== 'rsa' ||
          (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
        ) {
          throw new Error('RSA signing key is too weak');
        }
        nextKeys.set(
          jwk.kid,
          Object.freeze({
            ...(typeof jwk.alg === 'string' ? { algorithm: jwk.alg } : {}),
            key,
          }),
        );
      } catch {
        throw new JwtVerificationError('JWKS_KEY_INVALID');
      }
    }
    if (nextKeys.size === 0) throw new JwtVerificationError('JWKS_NO_USABLE_KEYS');
    this.keys = nextKeys;
    this.expiresAt = fetchedAt + this.cacheTtlMs;
  }
}

export type ClerkJwtVerifierOptions = Readonly<{
  issuer: string;
  audiences: readonly string[];
  authorizedParties: readonly string[];
  signingKeys: SigningKeyProvider;
  allowedAlgorithms?: readonly string[];
  clockToleranceSeconds?: number;
  now?: () => number;
}>;

type JwtHeader = Readonly<{ alg?: unknown; kid?: unknown; typ?: unknown }>;
type JwtClaims = Readonly<Record<string, unknown>>;

export class ClerkJwtVerifier implements JwtVerifier {
  private readonly issuer: string;
  private readonly audiences: ReadonlySet<string>;
  private readonly authorizedParties: ReadonlySet<string>;
  private readonly signingKeys: SigningKeyProvider;
  private readonly allowedAlgorithms: ReadonlySet<string>;
  private readonly clockToleranceSeconds: number;
  private readonly now: () => number;

  constructor(options: ClerkJwtVerifierOptions) {
    if (
      !options.issuer ||
      options.audiences.length === 0 ||
      options.authorizedParties.length === 0
    ) {
      throw new Error('Clerk JWT issuer, audience, and authorized-party configuration is required');
    }
    this.issuer = options.issuer;
    this.audiences = new Set(options.audiences);
    this.authorizedParties = new Set(options.authorizedParties);
    this.signingKeys = options.signingKeys;
    this.allowedAlgorithms = new Set(options.allowedAlgorithms ?? ['RS256']);
    this.clockToleranceSeconds = options.clockToleranceSeconds ?? 5;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1_000));
    if (
      this.allowedAlgorithms.size === 0 ||
      [...this.allowedAlgorithms].some((algorithm) => algorithm !== 'RS256') ||
      this.clockToleranceSeconds < 0 ||
      this.clockToleranceSeconds > 300
    ) {
      throw new Error(
        'JWT verifier supports an explicit RS256 allowlist and bounded clock tolerance',
      );
    }
  }

  async verify(
    token: string,
    options: Readonly<{ expectedNonce?: string }> = {},
  ): Promise<VerifiedJwtIdentity> {
    if (!token || token.length > 16_384) throw new JwtVerificationError('JWT_COMPACT_INVALID');
    const segments = token.split('.');
    if (segments.length !== 3 || segments.some((segment) => !compactSegmentPattern.test(segment))) {
      throw new JwtVerificationError('JWT_COMPACT_INVALID');
    }

    const header = decodeJson<JwtHeader>(segments[0], 'JWT_HEADER_INVALID');
    if (
      typeof header.alg !== 'string' ||
      !this.allowedAlgorithms.has(header.alg) ||
      header.alg === 'none'
    ) {
      throw new JwtVerificationError('JWT_ALGORITHM_REJECTED');
    }
    if (typeof header.kid !== 'string' || !header.kid) {
      throw new JwtVerificationError('JWT_KID_INVALID');
    }
    if (header.typ !== undefined && header.typ !== 'JWT') {
      throw new JwtVerificationError('JWT_TYPE_INVALID');
    }

    const key = await this.signingKeys.getSigningKey(header.kid, header.alg);
    const signingInput = `${segments[0]}.${segments[1]}`;
    const signature = decodeBase64Url(segments[2], 'JWT_SIGNATURE_INVALID');
    const validSignature = verifySignature(
      'RSA-SHA256',
      Buffer.from(signingInput, 'ascii'),
      key,
      signature,
    );
    if (!validSignature) throw new JwtVerificationError('JWT_SIGNATURE_INVALID');

    const claims = decodeJson<JwtClaims>(segments[1], 'JWT_CLAIMS_INVALID');
    return this.validateClaims(claims, options.expectedNonce);
  }

  private validateClaims(claims: JwtClaims, expectedNonce?: string): VerifiedJwtIdentity {
    const now = this.now();
    const subject = boundedStringClaim(claims.sub, 'JWT_SUBJECT_INVALID');
    if (claims.iss !== this.issuer) throw new JwtVerificationError('JWT_ISSUER_INVALID');

    const audience = normalizeAudience(claims.aud);
    if (!audience.some((entry) => this.audiences.has(entry))) {
      throw new JwtVerificationError('JWT_AUDIENCE_INVALID');
    }
    const authorizedParty = boundedStringClaim(claims.azp, 'JWT_AUTHORIZED_PARTY_INVALID');
    if (!this.authorizedParties.has(authorizedParty)) {
      throw new JwtVerificationError('JWT_AUTHORIZED_PARTY_INVALID');
    }
    const expiresAt = numericDate(claims.exp, 'JWT_EXPIRY_INVALID');
    if (now - this.clockToleranceSeconds >= expiresAt) {
      throw new JwtVerificationError('JWT_EXPIRED');
    }
    if (claims.nbf !== undefined) {
      const notBefore = numericDate(claims.nbf, 'JWT_NOT_BEFORE_INVALID');
      if (now + this.clockToleranceSeconds < notBefore) {
        throw new JwtVerificationError('JWT_NOT_ACTIVE');
      }
    }
    const issuedAt =
      claims.iat === undefined ? undefined : numericDate(claims.iat, 'JWT_ISSUED_AT_INVALID');
    if (issuedAt !== undefined && issuedAt > now + this.clockToleranceSeconds) {
      throw new JwtVerificationError('JWT_ISSUED_AT_INVALID');
    }
    if (expectedNonce !== undefined) {
      if (
        !expectedNonce ||
        typeof claims.nonce !== 'string' ||
        !constantTimeEqualString(claims.nonce, expectedNonce)
      ) {
        throw new JwtVerificationError('JWT_NONCE_INVALID');
      }
    }

    return Object.freeze({
      subject,
      issuer: this.issuer,
      audience: Object.freeze(audience),
      authorizedParty,
      ...(issuedAt === undefined ? {} : { issuedAt }),
      expiresAt,
    });
  }
}

function decodeJson<T>(segment: string, code: string): T {
  const decoded = decodeBase64Url(segment, code);
  if (decoded.byteLength > 12_288) throw new JwtVerificationError(code);
  try {
    const json = decoded.toString('utf8');
    assertJsonHasUniqueKeys(json);
    const value: unknown = JSON.parse(json);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error();
    return value as T;
  } catch {
    throw new JwtVerificationError(code);
  }
}

function decodeBase64Url(value: string, code: string): Buffer {
  if (!value || !compactSegmentPattern.test(value) || value.length % 4 === 1) {
    throw new JwtVerificationError(code);
  }
  try {
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.toString('base64url') !== value) throw new Error('noncanonical base64url');
    return decoded;
  } catch {
    throw new JwtVerificationError(code);
  }
}

function constantTimeEqualString(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left, 'utf8').digest();
  const rightDigest = createHash('sha256').update(right, 'utf8').digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function assertJsonHasUniqueKeys(json: string): void {
  let position = 0;
  const skipWhitespace = () => {
    while (position < json.length && /\s/u.test(json[position])) position += 1;
  };
  const parseString = (): string => {
    if (json[position] !== '"') throw new Error('expected string');
    const start = position;
    position += 1;
    while (position < json.length) {
      const character = json[position];
      if (character === '"') {
        position += 1;
        return JSON.parse(json.slice(start, position)) as string;
      }
      if (character === '\\') {
        position += 1;
        if (json[position] === 'u') position += 4;
      }
      position += 1;
    }
    throw new Error('unterminated string');
  };
  const parseValue = (): void => {
    skipWhitespace();
    const character = json[position];
    if (character === '{') {
      position += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (json[position] === '}') {
        position += 1;
        return;
      }
      while (position < json.length) {
        const key = parseString();
        if (keys.has(key)) throw new Error('duplicate JSON key');
        keys.add(key);
        skipWhitespace();
        if (json[position] !== ':') throw new Error('expected colon');
        position += 1;
        parseValue();
        skipWhitespace();
        if (json[position] === '}') {
          position += 1;
          return;
        }
        if (json[position] !== ',') throw new Error('expected comma');
        position += 1;
        skipWhitespace();
      }
      throw new Error('unterminated object');
    }
    if (character === '[') {
      position += 1;
      skipWhitespace();
      if (json[position] === ']') {
        position += 1;
        return;
      }
      while (position < json.length) {
        parseValue();
        skipWhitespace();
        if (json[position] === ']') {
          position += 1;
          return;
        }
        if (json[position] !== ',') throw new Error('expected comma');
        position += 1;
      }
      throw new Error('unterminated array');
    }
    if (character === '"') {
      parseString();
      return;
    }
    const remainder = json.slice(position);
    const primitive = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(
      remainder,
    )?.[0];
    if (!primitive) throw new Error('invalid JSON primitive');
    position += primitive.length;
  };
  parseValue();
  skipWhitespace();
  if (position !== json.length) throw new Error('trailing JSON input');
}

function boundedStringClaim(value: unknown, code: string): string {
  if (typeof value !== 'string' || !value || value.length > 500) {
    throw new JwtVerificationError(code);
  }
  return value;
}

function numericDate(value: unknown, code: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new JwtVerificationError(code);
  }
  return value;
}

function normalizeAudience(value: unknown): string[] {
  const entries = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
  if (
    entries.length === 0 ||
    entries.length > 20 ||
    entries.some((entry) => typeof entry !== 'string' || !entry || entry.length > 500)
  ) {
    throw new JwtVerificationError('JWT_AUDIENCE_INVALID');
  }
  return entries as string[];
}
