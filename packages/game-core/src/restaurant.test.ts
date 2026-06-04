import assert from 'node:assert/strict';
import test from 'node:test';

import { simulateBusinessPeriod } from './restaurant.js';

test('simulateBusinessPeriod sells beef noodles and updates totals and inventory', () => {
  const result = simulateBusinessPeriod({
    cash: 1000,
    menuItems: [
      {
        id: 'beef-noodles',
        name: 'Beef noodles',
        price: 180,
        demand: 3,
        recipe: [{ ingredientId: 'noodles', quantity: 2 }],
      },
    ],
    inventory: [{ ingredientId: 'noodles', quantity: 10, unitCost: 12 }],
  });

  assert.deepEqual(result, {
    cash: 1540,
    soldItems: 3,
    revenue: 540,
    costOfGoods: 72,
    grossProfit: 468,
    inventory: [{ ingredientId: 'noodles', quantity: 4, unitCost: 12 }],
  });
});

test('simulateBusinessPeriod caps fried rice sales by available ingredients', () => {
  const result = simulateBusinessPeriod({
    cash: 500,
    menuItems: [
      {
        id: 'fried-rice',
        name: 'Fried rice',
        price: 120,
        demand: 5,
        recipe: [{ ingredientId: 'rice', quantity: 2 }],
      },
    ],
    inventory: [{ ingredientId: 'rice', quantity: 3, unitCost: 8 }],
  });

  assert.deepEqual(result, {
    cash: 620,
    soldItems: 1,
    revenue: 120,
    costOfGoods: 16,
    grossProfit: 104,
    inventory: [{ ingredientId: 'rice', quantity: 1, unitCost: 8 }],
  });
});

test('simulateBusinessPeriod aggregates duplicate recipe entries before capping sales', () => {
  const result = simulateBusinessPeriod({
    cash: 0,
    menuItems: [
      {
        id: 'double-noodle-soup',
        name: 'Double noodle soup',
        price: 100,
        demand: 3,
        recipe: [
          { ingredientId: 'noodles', quantity: 2 },
          { ingredientId: 'noodles', quantity: 2 },
        ],
      },
    ],
    inventory: [{ ingredientId: 'noodles', quantity: 6, unitCost: 5 }],
  });

  assert.deepEqual(result, {
    cash: 100,
    soldItems: 1,
    revenue: 100,
    costOfGoods: 20,
    grossProfit: 80,
    inventory: [{ ingredientId: 'noodles', quantity: 2, unitCost: 5 }],
  });
});

test('simulateBusinessPeriod rejects negative demand', () => {
  assert.throws(
    () =>
      simulateBusinessPeriod({
        cash: 0,
        menuItems: [
          {
            id: 'fried-rice',
            name: 'Fried rice',
            price: 120,
            demand: -1,
            recipe: [{ ingredientId: 'rice', quantity: 1 }],
          },
        ],
        inventory: [{ ingredientId: 'rice', quantity: 3, unitCost: 8 }],
      }),
    { name: 'RangeError', message: 'Menu item fried-rice demand cannot be negative' },
  );
});
