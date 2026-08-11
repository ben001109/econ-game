import { z } from 'zod';

export const IngredientQuantityDtoSchema = z
  .object({
    ingredientId: z.string(),
    quantity: z.number(),
  })
  .strict();

export type IngredientQuantityDto = z.infer<typeof IngredientQuantityDtoSchema>;

export const RestaurantStatusDtoSchema = z
  .object({
    restaurantId: z.string(),
    name: z.string(),
    day: z.number(),
    cash: z.number(),
    alerts: z.array(z.string()),
  })
  .strict();

export type RestaurantStatusDto = z.infer<typeof RestaurantStatusDtoSchema>;

export const RestockRequestDtoSchema = z
  .object({
    restaurantId: z.string(),
    supplierId: z.string(),
    items: z.array(IngredientQuantityDtoSchema),
  })
  .strict();

export type RestockRequestDto = z.infer<typeof RestockRequestDtoSchema>;

export const RestockResponseDtoSchema = z
  .object({
    restaurantId: z.string(),
    supplierId: z.string(),
    totalCost: z.number(),
    cashAfterPurchase: z.number(),
    inventory: z.array(IngredientQuantityDtoSchema),
  })
  .strict();

export type RestockResponseDto = z.infer<typeof RestockResponseDtoSchema>;
