export type RestaurantStatusDto = {
  restaurantId: string;
  name: string;
  day: number;
  cash: number;
  alerts: string[];
};

export type RestockRequestDto = {
  restaurantId: string;
  supplierId: string;
  items: { ingredientId: string; quantity: number }[];
};

export type RestockResponseDto = {
  restaurantId: string;
  supplierId: string;
  totalCost: number;
  cashAfterPurchase: number;
  inventory: { ingredientId: string; quantity: number }[];
};
