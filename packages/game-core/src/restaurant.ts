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

const createInventoryLedger = (inventory: InventoryItem[]): InventoryLedger =>
  new Map(inventory.map((item) => [item.ingredientId, { ...item }]));

const getAvailableSales = (menuItem: MenuItem, inventory: InventoryLedger): number => {
  if (menuItem.recipe.length === 0) {
    return menuItem.demand;
  }

  const ingredientCaps = menuItem.recipe.map((ingredient) => {
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
  menuItem.recipe.reduce((costOfGoods, ingredient) => {
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
    inventory: input.inventory.map((item) => inventory.get(item.ingredientId) ?? { ...item }),
  };
};
