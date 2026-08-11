import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEMO_BOOTSTRAP_CONFIRMATION,
  createRestaurantApiClient,
} from '../dist/index.js';

test('restaurant client serializes a create-order request', async () => {
  let received;
  const client = createRestaurantApiClient({
    baseUrl: 'https://api.example.test',
    fetch: async (url, init) => {
      received = { url, init };
      return json({ id: 'order-1', status: 'OPEN' }, 201);
    },
  });

  const order = await client.createOrder({ branchId: 'branch-1', type: 'takeout' });

  assert.equal(order.id, 'order-1');
  assert.equal(received.url, 'https://api.example.test/orders');
  assert.equal(received.init.method, 'POST');
  assert.equal(received.init.body, '{"branchId":"branch-1","type":"takeout"}');
});

test('restaurant client encodes a KDS ticket identifier', async () => {
  let requestedUrl;
  const client = createRestaurantApiClient({
    baseUrl: 'https://api.example.test',
    fetch: async (url) => {
      requestedUrl = url;
      return json({ id: 'ticket/1', status: 'SERVED' });
    },
  });

  await client.serveKdsTicket('ticket/1');
  assert.equal(requestedUrl, 'https://api.example.test/kds/tickets/ticket%2F1/serve');
});

test('demo bootstrap needs an explicit confirmation token', async () => {
  let called = false;
  const client = createRestaurantApiClient({
    baseUrl: 'https://api.example.test',
    fetch: async () => {
      called = true;
      return json({});
    },
  });

  assert.throws(
    () => client.bootstrapDemo({ confirm: 'incorrect-confirmation' }),
    /confirm must equal/
  );
  assert.equal(called, false);

  await client.bootstrapDemo({ confirm: DEMO_BOOTSTRAP_CONFIRMATION });
  assert.equal(called, true);
});

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
