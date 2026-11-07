import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, type JsonWebKey, type KeyObject } from 'node:crypto';
import test from 'node:test';

import { CachingJwksProvider, ClerkJwtVerifier, JwtVerificationError } from './jwt-verifier.js';

const nowSeconds = 2_000_000_000;
const issuer = 'https://clerk.test.example';
const audience = 'econ-game-api';
const authorizedParty = 'https://game.test.example';

function createSigner(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  return {
    kid,
    privateKey,
    jwk: { ...jwk, kid, alg: 'RS256', use: 'sig', key_ops: ['verify'] } satisfies JsonWebKey,
  };
}

const signerOne = createSigner('key-one');
const signerTwo = createSigner('key-two');

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function jwt(
  signer: Readonly<{ kid: string; privateKey: KeyObject }>,
  claimOverrides: Readonly<Record<string, unknown>> = {},
  headerOverrides: Readonly<Record<string, unknown>> = {},
): string {
  const header = encode({ alg: 'RS256', kid: signer.kid, typ: 'JWT', ...headerOverrides });
  const payload = encode({
    sub: 'clerk-user-1',
    iss: issuer,
    aud: audience,
    azp: authorizedParty,
    iat: nowSeconds - 60,
    nbf: nowSeconds - 60,
    exp: nowSeconds + 60,
    ...claimOverrides,
  });
  const signature = sign(
    'RSA-SHA256',
    Buffer.from(`${header}.${payload}`, 'ascii'),
    signer.privateKey,
  ).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

function jwtFromJson(
  signer: Readonly<{ privateKey: KeyObject }>,
  headerJson: string,
  claimsJson: string,
): string {
  const header = Buffer.from(headerJson, 'utf8').toString('base64url');
  const payload = Buffer.from(claimsJson, 'utf8').toString('base64url');
  const signature = sign(
    'RSA-SHA256',
    Buffer.from(`${header}.${payload}`, 'ascii'),
    signer.privateKey,
  ).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

function noncanonicalEquivalent(value: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const unusedBits = value.length % 4 === 2 ? 4 : value.length % 4 === 3 ? 2 : 0;
  assert.ok(unusedBits > 0);
  const last = alphabet.indexOf(value.at(-1)!);
  const replacement = (last & ~((1 << unusedBits) - 1)) | 1;
  const result = `${value.slice(0, -1)}${alphabet[replacement]}`;
  assert.deepEqual(Buffer.from(result, 'base64url'), Buffer.from(value, 'base64url'));
  return result;
}

function verifier(fetchJwks = async () => ({ keys: [signerOne.jwk] })) {
  return new ClerkJwtVerifier({
    issuer,
    audiences: [audience],
    authorizedParties: [authorizedParty],
    signingKeys: new CachingJwksProvider({
      fetchJwks,
      cacheTtlMs: 60_000,
      minimumRefreshIntervalMs: 0,
      now: () => nowSeconds * 1_000,
    }),
    now: () => nowSeconds,
    clockToleranceSeconds: 0,
  });
}

async function rejectsCode(action: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof JwtVerificationError);
    assert.equal(error.code, code);
    return true;
  });
}

test('accepts a locally signed RS256 Clerk-shaped JWT without secrets or network', async () => {
  assert.deepEqual(await verifier().verify(jwt(signerOne)), {
    subject: 'clerk-user-1',
    issuer,
    audience: [audience],
    authorizedParty,
    issuedAt: nowSeconds - 60,
    expiresAt: nowSeconds + 60,
  });
});

test('rejects alg=none and symmetric-algorithm confusion before key use', async () => {
  const unsignedHeader = encode({ alg: 'none', kid: signerOne.kid, typ: 'JWT' });
  const validPayload = jwt(signerOne).split('.')[1];
  await rejectsCode(
    verifier().verify(`${unsignedHeader}.${validPayload}.unsigned`),
    'JWT_ALGORITHM_REJECTED',
  );
  await rejectsCode(
    verifier().verify(jwt(signerOne, {}, { alg: 'HS256' })),
    'JWT_ALGORITHM_REJECTED',
  );
});

test('rejects signature tampering, unknown kid, and JWK algorithm mismatch', async () => {
  const token = jwt(signerOne);
  const [header, payload, signature] = token.split('.');
  const tamperedPayload = encode({
    sub: 'attacker',
    iss: issuer,
    aud: audience,
    azp: authorizedParty,
    exp: nowSeconds + 60,
  });
  await rejectsCode(
    verifier().verify(`${header}.${tamperedPayload}.${signature}`),
    'JWT_SIGNATURE_INVALID',
  );
  await rejectsCode(verifier().verify(jwt(signerTwo)), 'JWT_KID_UNKNOWN');
  await rejectsCode(
    verifier(async () => ({ keys: [{ ...signerOne.jwk, alg: 'PS256' }] })).verify(token),
    'JWT_KEY_ALGORITHM_MISMATCH',
  );
  assert.ok(payload);
});

test('rejects invalid issuer, audience, authorized party, expiry, nbf, iat, and nonce', async () => {
  const cases: readonly [Readonly<Record<string, unknown>>, string][] = [
    [{ iss: 'https://attacker.example' }, 'JWT_ISSUER_INVALID'],
    [{ aud: 'another-api' }, 'JWT_AUDIENCE_INVALID'],
    [{ azp: 'https://attacker.example' }, 'JWT_AUTHORIZED_PARTY_INVALID'],
    [{ exp: nowSeconds }, 'JWT_EXPIRED'],
    [{ nbf: nowSeconds + 1 }, 'JWT_NOT_ACTIVE'],
    [{ iat: nowSeconds + 1 }, 'JWT_ISSUED_AT_INVALID'],
  ];
  for (const [claims, code] of cases) {
    await rejectsCode(verifier().verify(jwt(signerOne, claims)), code);
  }
  await rejectsCode(
    verifier().verify(jwt(signerOne, { nonce: 'wrong' }), { expectedNonce: 'expected' }),
    'JWT_NONCE_INVALID',
  );
  assert.equal(
    (await verifier().verify(jwt(signerOne, { nonce: 'expected' }), { expectedNonce: 'expected' }))
      .subject,
    'clerk-user-1',
  );
});

test('refreshes once for key rotation and replaces expired key material', async () => {
  let fetches = 0;
  const rotating = verifier(async () => {
    fetches += 1;
    return { keys: fetches === 1 ? [signerOne.jwk] : [signerTwo.jwk] };
  });
  assert.equal((await rotating.verify(jwt(signerOne))).subject, 'clerk-user-1');
  assert.equal((await rotating.verify(jwt(signerTwo))).subject, 'clerk-user-1');
  assert.equal(fetches, 2);
  await rejectsCode(rotating.verify(jwt(signerOne)), 'JWT_KID_UNKNOWN');
});

test('rejects duplicate header/claim keys and noncanonical base64url before trust', async () => {
  const validClaims = JSON.stringify({
    sub: 'clerk-user-1',
    iss: issuer,
    aud: audience,
    azp: authorizedParty,
    exp: nowSeconds + 60,
  });
  await rejectsCode(
    verifier().verify(
      jwtFromJson(
        signerOne,
        `{"alg":"RS256","alg":"RS256","kid":"${signerOne.kid}","typ":"JWT"}`,
        validClaims,
      ),
    ),
    'JWT_HEADER_INVALID',
  );
  await rejectsCode(
    verifier().verify(
      jwtFromJson(
        signerOne,
        `{"alg":"RS256","kid":"${signerOne.kid}","typ":"JWT"}`,
        `{"sub":"clerk-user-1","sub":"attacker","iss":"${issuer}","aud":"${audience}","azp":"${authorizedParty}","exp":${nowSeconds + 60}}`,
      ),
    ),
    'JWT_CLAIMS_INVALID',
  );
  const valid = jwt(signerOne);
  const [header, payload, signature] = valid.split('.');
  await rejectsCode(
    verifier().verify(`${noncanonicalEquivalent(header)}.${payload}.${signature}`),
    'JWT_HEADER_INVALID',
  );
});

test('throttles refresh failures and unknown-kid floods by refresh attempt time', async () => {
  let nowMs = nowSeconds * 1_000;
  let failedFetches = 0;
  const failing = new CachingJwksProvider({
    async fetchJwks() {
      failedFetches += 1;
      throw new Error('offline');
    },
    minimumRefreshIntervalMs: 1_000,
    now: () => nowMs,
  });
  await rejectsCode(failing.getSigningKey('unknown-1', 'RS256'), 'JWKS_FETCH_FAILED');
  await rejectsCode(failing.getSigningKey('unknown-2', 'RS256'), 'JWT_KID_UNKNOWN');
  assert.equal(failedFetches, 1);
  nowMs += 1_000;
  await rejectsCode(failing.getSigningKey('unknown-3', 'RS256'), 'JWKS_FETCH_FAILED');
  assert.equal(failedFetches, 2);

  let successfulFetches = 0;
  const cached = new CachingJwksProvider({
    async fetchJwks() {
      successfulFetches += 1;
      return { keys: [signerOne.jwk] };
    },
    minimumRefreshIntervalMs: 1_000,
    now: () => nowMs,
  });
  await cached.getSigningKey(signerOne.kid, 'RS256');
  await rejectsCode(cached.getSigningKey('flood-1', 'RS256'), 'JWT_KID_UNKNOWN');
  await rejectsCode(cached.getSigningKey('flood-2', 'RS256'), 'JWT_KID_UNKNOWN');
  assert.equal(successfulFetches, 1);

  let staleNow = nowSeconds * 1_000;
  let staleFetches = 0;
  const stale = new CachingJwksProvider({
    async fetchJwks() {
      staleFetches += 1;
      if (staleFetches > 1) throw new Error('rotation endpoint offline');
      return { keys: [signerOne.jwk] };
    },
    cacheTtlMs: 100,
    minimumRefreshIntervalMs: 1_000,
    now: () => staleNow,
  });
  await stale.getSigningKey(signerOne.kid, 'RS256');
  staleNow += 100;
  await rejectsCode(stale.getSigningKey(signerOne.kid, 'RS256'), 'JWKS_REFRESH_THROTTLED');
  assert.equal(staleFetches, 1);
  staleNow += 900;
  await rejectsCode(stale.getSigningKey(signerOne.kid, 'RS256'), 'JWKS_FETCH_FAILED');
  await rejectsCode(stale.getSigningKey(signerOne.kid, 'RS256'), 'JWKS_REFRESH_THROTTLED');
  assert.equal(staleFetches, 2);
});
