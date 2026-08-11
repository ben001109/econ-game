export interface IngredientQuantity {
  ingredientId: string;
  quantity: number;
}

export interface InventoryItem extends IngredientQuantity {
  unitCost: number;
}

export interface MenuItem {
  id: string;
  name: string;
  price: number;
  demand: number;
  recipe: IngredientQuantity[];
}

export interface BusinessPeriodInput {
  cash: number;
  menuItems: MenuItem[];
  inventory: InventoryItem[];
}

export interface BusinessPeriodResult {
  cash: number;
  soldItems: number;
  revenue: number;
  costOfGoods: number;
  grossProfit: number;
  inventory: InventoryItem[];
}

type InventoryLedger = Map<string, InventoryItem>;

const assertFinite = (value: number, label: string): void => {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${label} must be finite`);
  }
};

const assertNonNegativeFinite = (value: number, label: string): void => {
  assertFinite(value, label);

  if (value < 0) {
    throw new RangeError(`${label} cannot be negative`);
  }
};

const assertNonNegativeInteger = (value: number, label: string): void => {
  assertNonNegativeFinite(value, label);

  if (!Number.isInteger(value)) {
    throw new RangeError(`${label} must be an integer`);
  }
};

const assertPositiveFinite = (value: number, label: string): void => {
  assertFinite(value, label);

  if (value <= 0) {
    throw new RangeError(`${label} must be positive`);
  }
};

const validateBusinessPeriodInput = (input: BusinessPeriodInput): void => {
  assertNonNegativeFinite(input.cash, 'Cash');

  input.inventory.forEach((item) => {
    assertNonNegativeFinite(item.quantity, `Inventory item ${item.ingredientId} quantity`);
    assertNonNegativeFinite(item.unitCost, `Inventory item ${item.ingredientId} unitCost`);
  });

  input.menuItems.forEach((menuItem) => {
    assertNonNegativeFinite(menuItem.price, `Menu item ${menuItem.id} price`);
    assertNonNegativeInteger(menuItem.demand, `Menu item ${menuItem.id} demand`);

    menuItem.recipe.forEach((ingredient) => {
      assertPositiveFinite(
        ingredient.quantity,
        `Menu item ${menuItem.id} recipe ingredient ${ingredient.ingredientId} quantity`,
      );
    });
  });
};

const createInventoryLedger = (inventory: InventoryItem[]): InventoryLedger => {
  const ledger: InventoryLedger = new Map();

  inventory.forEach((item) => {
    const existingItem = ledger.get(item.ingredientId);

    if (existingItem === undefined) {
      ledger.set(item.ingredientId, { ...item });
      return;
    }

    const totalQuantity = existingItem.quantity + item.quantity;
    const totalValue = existingItem.quantity * existingItem.unitCost + item.quantity * item.unitCost;

    ledger.set(item.ingredientId, {
      ingredientId: item.ingredientId,
      quantity: totalQuantity,
      unitCost: totalQuantity === 0 ? 0 : totalValue / totalQuantity,
    });
  });

  return ledger;
};

const aggregateRecipe = (recipe: IngredientQuantity[]): IngredientQuantity[] => {
  const ingredientQuantities = recipe.reduce((quantities, ingredient) => {
    const existingQuantity = quantities.get(ingredient.ingredientId) ?? 0;
    quantities.set(ingredient.ingredientId, existingQuantity + ingredient.quantity);

    return quantities;
  }, new Map<string, number>());

  return [...ingredientQuantities.entries()].map(([ingredientId, quantity]) => ({
    ingredientId,
    quantity,
  }));
};

const getAvailableSales = (menuItem: MenuItem, inventory: InventoryLedger): number => {
  const recipe = aggregateRecipe(menuItem.recipe);

  if (recipe.length === 0) {
    return menuItem.demand;
  }

  const ingredientCaps = recipe.map((ingredient) => {
    const inventoryItem = inventory.get(ingredient.ingredientId);

    if (inventoryItem === undefined || ingredient.quantity <= 0) {
      return 0;
    }

    return Math.floor(inventoryItem.quantity / ingredient.quantity);
  });

  return Math.min(menuItem.demand, ...ingredientCaps);
};

const applySalesToInventory = (
  menuItem: MenuItem,
  soldQuantity: number,
  inventory: InventoryLedger,
): number =>
  aggregateRecipe(menuItem.recipe).reduce((costOfGoods, ingredient) => {
    const inventoryItem = inventory.get(ingredient.ingredientId);

    if (inventoryItem === undefined) {
      return costOfGoods;
    }

    const consumedQuantity = ingredient.quantity * soldQuantity;
    inventory.set(ingredient.ingredientId, {
      ...inventoryItem,
      quantity: inventoryItem.quantity - consumedQuantity,
    });

    return costOfGoods + consumedQuantity * inventoryItem.unitCost;
  }, 0);

export const simulateBusinessPeriod = (input: BusinessPeriodInput): BusinessPeriodResult => {
  validateBusinessPeriodInput(input);

  const inventory = createInventoryLedger(input.inventory);

  const totals = input.menuItems.reduce(
    (currentTotals, menuItem) => {
      const soldQuantity = getAvailableSales(menuItem, inventory);
      const costOfGoods = applySalesToInventory(menuItem, soldQuantity, inventory);
      const revenue = soldQuantity * menuItem.price;

      return {
        soldItems: currentTotals.soldItems + soldQuantity,
        revenue: currentTotals.revenue + revenue,
        costOfGoods: currentTotals.costOfGoods + costOfGoods,
      };
    },
    { soldItems: 0, revenue: 0, costOfGoods: 0 },
  );

  return {
    cash: input.cash + totals.revenue,
    soldItems: totals.soldItems,
    revenue: totals.revenue,
    costOfGoods: totals.costOfGoods,
    grossProfit: totals.revenue - totals.costOfGoods,
    inventory: [...inventory.values()],
  };
};
