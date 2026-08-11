import assert from 'node:assert/strict';
import test from 'node:test';

import { EconGameApiError, EconGameHttpClient, encodePathSegment } from '../dist/index.js';

test('transport combines the base URL, headers, and JSON body without reading configuration', async () => {
  class TestClient extends EconGameHttpClient {
    call(options) {
      return this.request(options);
    }
  }

  let received;
  const client = new TestClient({
    baseUrl: 'https://api.example.test/root/',
    headers: { 'x-client': 'sdk-test' },
    fetch: async (url, init) => {
      received = { url, init };
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });

  const value = await client.call({
    method: 'POST',
    path: 'resource',
    body: { value: 1 },
  });

  assert.deepEqual(value, { ok: true });
  assert.equal(received.url, 'https://api.example.test/root/resource');
  assert.equal(received.init.method, 'POST');
  assert.equal(received.init.headers.get('x-client'), 'sdk-test');
  assert.equal(received.init.headers.get('content-type'), 'application/json');
  assert.equal(received.init.body, '{"value":1}');
});

test('transport exposes structured server errors', async () => {
  class TestClient extends EconGameHttpClient {
    call() {
      return this.request({ method: 'GET', path: '/missing' });
    }
  }

  const client = new TestClient({
    baseUrl: 'https://api.example.test',
    fetch: async () => new Response(JSON.stringify({ code: 'NOT_FOUND' }), { status: 404, statusText: 'Not Found' }),
  });

  await assert.rejects(client.call(), (error) => {
    assert.ok(error instanceof EconGameApiError);
    assert.equal(error.status, 404);
    assert.equal(error.code, 'NOT_FOUND');
    assert.equal(error.path, '/missing');
    return true;
  });
});

test('path segments are encoded before being interpolated into a route', () => {
  assert.equal(encodePathSegment('a/b c'), 'a%2Fb%20c');
});
