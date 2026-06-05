export interface BaseIngredient {
  readonly id: string;
  readonly name: string;
  readonly unit: 'gram' | 'portion' | 'piece';
}

export interface BaseSupplier {
  readonly id: string;
  readonly name: string;
  readonly leadTimeDays: number;
  readonly catalog: readonly {
    readonly ingredientId: string;
    readonly unitCost: number;
    readonly availableQuantity: number;
  }[];
}

export interface BaseMenuItem {
  readonly id: string;
  readonly name: string;
  readonly price: number;
  readonly recipe: readonly {
    readonly ingredientId: string;
    readonly quantity: number;
  }[];
}

export const baseIngredients = [
  { id: 'noodles', name: 'Noodles', unit: 'portion' },
  { id: 'rice', name: 'Rice', unit: 'portion' },
  { id: 'tea', name: 'Tea', unit: 'portion' },
  { id: 'beef', name: 'Beef', unit: 'portion' },
] as const satisfies readonly BaseIngredient[];

export const baseSuppliers = [
  {
    id: 'morning-market',
    name: 'Morning Market',
    leadTimeDays: 0,
    catalog: [
      { ingredientId: 'noodles', unitCost: 12, availableQuantity: 100 },
      { ingredientId: 'rice', unitCost: 8, availableQuantity: 120 },
      { ingredientId: 'tea', unitCost: 5, availableQuantity: 80 },
      { ingredientId: 'beef', unitCost: 45, availableQuantity: 60 },
    ],
  },
] as const satisfies readonly BaseSupplier[];

export const baseMenuItems = [
  {
    id: 'beef-noodles',
    name: 'Beef Noodles',
    price: 180,
    recipe: [
      { ingredientId: 'noodles', quantity: 2 },
      { ingredientId: 'beef', quantity: 1 },
    ],
  },
  {
    id: 'fried-rice',
    name: 'Fried Rice',
    price: 120,
    recipe: [{ ingredientId: 'rice', quantity: 2 }],
  },
  {
    id: 'iced-tea',
    name: 'Iced Tea',
    price: 40,
    recipe: [{ ingredientId: 'tea', quantity: 1 }],
  },
] as const satisfies readonly BaseMenuItem[];
