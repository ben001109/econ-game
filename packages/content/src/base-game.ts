export interface BaseIngredient {
  id: string;
  name: string;
  unit: 'gram' | 'portion' | 'piece';
}

export interface BaseSupplier {
  id: string;
  name: string;
  leadTimeDays: number;
  catalog: {
    ingredientId: string;
    unitCost: number;
    availableQuantity: number;
  }[];
}

export interface BaseMenuItem {
  id: string;
  name: string;
  price: number;
  recipe: {
    ingredientId: string;
    quantity: number;
  }[];
}

export const baseIngredients: BaseIngredient[] = [
  { id: 'noodles', name: 'Noodles', unit: 'portion' },
  { id: 'rice', name: 'Rice', unit: 'portion' },
  { id: 'tea', name: 'Tea', unit: 'portion' },
];

export const baseSuppliers: BaseSupplier[] = [
  {
    id: 'morning-market',
    name: 'Morning Market',
    leadTimeDays: 0,
    catalog: [
      { ingredientId: 'noodles', unitCost: 12, availableQuantity: 100 },
      { ingredientId: 'rice', unitCost: 8, availableQuantity: 120 },
      { ingredientId: 'tea', unitCost: 5, availableQuantity: 80 },
    ],
  },
];

export const baseMenuItems: BaseMenuItem[] = [
  {
    id: 'beef-noodles',
    name: 'Beef Noodles',
    price: 180,
    recipe: [{ ingredientId: 'noodles', quantity: 2 }],
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
];
