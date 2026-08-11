import assert from 'node:assert/strict';
import test from 'node:test';

import { createPythonPreviewApiClient } from '../dist/index.js';

test('Python preview client keeps the preview player route separate', async () => {
  let received;
  const client = createPythonPreviewApiClient({
    baseUrl: 'https://preview.example.test',
    fetch: async (url, init) => {
      received = { url, init };
      return new Response(
        JSON.stringify({ id: 'player-1', username: 'demo', created_at: '2026-08-01T00:00:00Z' }),
        { status: 201 }
      );
    },
  });

  const player = await client.createPlayer({ username: 'demo' });

  assert.equal(player.username, 'demo');
  assert.equal(received.url, 'https://preview.example.test/players');
  assert.equal(received.init.body, '{"username":"demo"}');
});
