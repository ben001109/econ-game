export const API_BODY_LIMIT_BYTES = 64 * 1024;

export const JSON_RESOURCE_LIMITS = Object.freeze({
  maximumDepth: 32,
  maximumObjectKeys: 100,
  maximumArrayLength: 1_000,
  maximumStringLength: 16 * 1024,
  maximumNodes: 10_000,
  maximumCanonicalBytes: API_BODY_LIMIT_BYTES,
});

export type JsonResourceLimitKind =
  | 'ARRAY_LENGTH'
  | 'CANONICAL_BYTES'
  | 'DEPTH'
  | 'NODES'
  | 'OBJECT_KEYS'
  | 'STRING_LENGTH'
  | 'UNSUPPORTED_VALUE';

export class JsonResourceLimitError extends Error {
  constructor(readonly kind: JsonResourceLimitKind) {
    super(`JSON resource limit exceeded: ${kind}`);
    this.name = 'JsonResourceLimitError';
  }
}

/**
 * Iterative validation keeps hostile nesting away from recursive domain parsers.
 * The encoded-byte accounting also caps aggregate string/key complexity before
 * canonical serialization allocates its result.
 */
export function assertJsonWithinResourceLimits(value: unknown): void {
  const pending: Array<Readonly<{ value: unknown; depth: number }>> = [{ value, depth: 1 }];
  const ancestors = new WeakSet<object>();
  let nodes = 0;
  let encodedBytes = 0;

  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > JSON_RESOURCE_LIMITS.maximumNodes) fail('NODES');
    if (current.depth > JSON_RESOURCE_LIMITS.maximumDepth) fail('DEPTH');

    const nested = current.value;
    if (nested === null || typeof nested === 'boolean') {
      encodedBytes += nested === null ? 4 : nested ? 4 : 5;
    } else if (typeof nested === 'number') {
      if (!Number.isFinite(nested)) fail('UNSUPPORTED_VALUE');
      encodedBytes += JSON.stringify(Object.is(nested, -0) ? 0 : nested).length;
    } else if (typeof nested === 'string') {
      if (nested.length > JSON_RESOURCE_LIMITS.maximumStringLength) fail('STRING_LENGTH');
      encodedBytes += Buffer.byteLength(JSON.stringify(nested), 'utf8');
    } else if (Array.isArray(nested)) {
      if (nested.length > JSON_RESOURCE_LIMITS.maximumArrayLength) fail('ARRAY_LENGTH');
      if (ancestors.has(nested)) fail('UNSUPPORTED_VALUE');
      ancestors.add(nested);
      encodedBytes += 2 + Math.max(0, nested.length - 1);
      for (let index = nested.length - 1; index >= 0; index -= 1) {
        pending.push({ value: nested[index], depth: current.depth + 1 });
      }
    } else if (typeof nested === 'object' && isPlainObject(nested)) {
      if (ancestors.has(nested)) fail('UNSUPPORTED_VALUE');
      ancestors.add(nested);
      const entries = Object.entries(nested);
      if (entries.length > JSON_RESOURCE_LIMITS.maximumObjectKeys) fail('OBJECT_KEYS');
      encodedBytes += 2 + Math.max(0, entries.length - 1) + entries.length;
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const [key, child] = entries[index]!;
        if (key.length > JSON_RESOURCE_LIMITS.maximumStringLength) fail('STRING_LENGTH');
        encodedBytes += Buffer.byteLength(JSON.stringify(key), 'utf8');
        pending.push({ value: child, depth: current.depth + 1 });
      }
    } else {
      fail('UNSUPPORTED_VALUE');
    }

    if (encodedBytes > JSON_RESOURCE_LIMITS.maximumCanonicalBytes) fail('CANONICAL_BYTES');
  }
}

export function canonicalizeBoundedJson(value: unknown): string {
  assertJsonWithinResourceLimits(value);
  const serialized = canonicalizeValidated(value);
  if (Buffer.byteLength(serialized, 'utf8') > JSON_RESOURCE_LIMITS.maximumCanonicalBytes) {
    fail('CANONICAL_BYTES');
  }
  return serialized;
}

function canonicalizeValidated(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (Array.isArray(value)) return `[${value.map(canonicalizeValidated).join(',')}]`;
  return `{${Object.entries(value as Readonly<Record<string, unknown>>)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalizeValidated(nested)}`)
    .join(',')}}`;
}

function isPlainObject(value: object): value is Readonly<Record<string, unknown>> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function fail(kind: JsonResourceLimitKind): never {
  throw new JsonResourceLimitError(kind);
}
