import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertJsonWithinResourceLimits,
  canonicalizeBoundedJson,
  JsonResourceLimitError,
} from './json-resource-limits.js';

test('bounded canonical JSON remains order-independent within the production budget', () => {
  assert.equal(
    canonicalizeBoundedJson({ z: 2, a: { y: true, x: 'value' } }),
    '{"a":{"x":"value","y":true},"z":2}',
  );
});

test('iterative JSON validation caps depth, object keys, arrays, strings, and total nodes', () => {
  let nested: unknown = null;
  for (let depth = 0; depth < 40; depth += 1) nested = { nested };
  const cases: readonly Readonly<{ value: unknown; kind: string }>[] = [
    { value: nested, kind: 'DEPTH' },
    {
      value: Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`key${index}`, index])),
      kind: 'OBJECT_KEYS',
    },
    { value: Array.from({ length: 1_001 }, () => null), kind: 'ARRAY_LENGTH' },
    { value: 'x'.repeat(16 * 1024 + 1), kind: 'STRING_LENGTH' },
    {
      value: Array.from({ length: 1_000 }, () => Array.from({ length: 10 }, () => null)),
      kind: 'NODES',
    },
  ];
  for (const entry of cases) {
    assert.throws(
      () => assertJsonWithinResourceLimits(entry.value),
      (error: unknown) => error instanceof JsonResourceLimitError && error.kind === entry.kind,
      entry.kind,
    );
  }
});
