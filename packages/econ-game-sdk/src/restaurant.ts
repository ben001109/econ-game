import { EconGameHttpClient, encodePathSegment, type EconGameClientOptions } from './core.js';

/** JSON representation of a Prisma Decimal. Preserve it until a caller chooses a display format. */
export type ApiMoney = number | string;

export type RestaurantOrderType = 'dine-in' | 'takeout' | 'delivery';
export type RestaurantOrderStatus = 'OPEN' | 'IN_PROGRESS' | 'SERVED' | 'CLOSED' | 'CANCELED';
export type RestaurantPaymentMethod = 'CASH' | 'CARD';

export type HealthResponse = { status: string };

export type Table = {
  id: string;
  branchId: string;
  code: string;
  seats: number;
  status: string;
};

export type Branch = {
  id: string;
  restaurantId: string;
  name: string;
  address: string | null;
  hours: string | null;
  tables: Table[];
};

export type MenuItem = {
  id: string;
  branchId: string;
  sku: string;
  name: string;
  basePrice: ApiMoney;
  active: boolean;
};

export type Restaurant = {
  id: string;
  name: string;
  timezone: string;
  createdAt: string;
  branches: Branch[];
};

export type BootstrappedRestaurant = Omit<Restaurant, 'branches'> & {
  branches: Array<Branch & { menuItems: MenuItem[] }>;
};

export type Order = {
  id: string;
  branchId: string;
  tableId: string | null;
  type: 'DINE_IN' | 'TAKEOUT' | 'DELIVERY';
  status: RestaurantOrderStatus;
  openedAt: string;
  closedAt: string | null;
};

export type OrderItem = {
  id: string;
  orderId: string;
  menuItemId: string;
  qty: number;
  price: ApiMoney;
  notes: string | null;
};

export type OrderItemWithMenu = OrderItem & { menuItem: MenuItem };

export type Payment = {
  id: string;
  orderId: string;
  method: RestaurantPaymentMethod;
  amount: ApiMoney;
  paidAt: string;
};

export type TaxLine = {
  id: string;
  orderId: string;
  name: string;
  amount: ApiMoney;
};

export type Tip = {
  id: string;
  orderId: string;
  amount: ApiMoney;
};

export type OrderDetail = Order & {
  items: OrderItemWithMenu[];
  payments: Payment[];
  taxLines: TaxLine[];
  tips: Tip[];
};

export type KdsTicket = Order & { items: OrderItemWithMenu[] };

export type CreateOrderInput = {
  branchId: string;
  tableId?: string;
  type?: RestaurantOrderType;
};

export type AddOrderItemInput = {
  menuItemId: string;
  qty?: number;
  priceOverride?: number;
  notes?: string;
};

export type AddPaymentInput = {
  method: 'cash' | 'card';
  amount: number;
  taxLines?: Array<{ name: string; amount: number }>;
  tip?: number;
  close?: boolean;
};

/** Explicit confirmation prevents accidental use of the state-changing demo seed endpoint. */
export const DEMO_BOOTSTRAP_CONFIRMATION = 'create-demo-data' as const;

export type BootstrapDemoInput = {
  confirm: typeof DEMO_BOOTSTRAP_CONFIRMATION;
};

/**
 * Client for the current Node/Fastify restaurant scaffold.
 *
 * This is not the future authoritative game contract: see the package README
 * before using it for a new product feature.
 */
export class RestaurantApiClient extends EconGameHttpClient {
  getHealth(): Promise<HealthResponse> {
    return this.request({ method: 'GET', path: '/health' });
  }

  listRestaurants(): Promise<Restaurant[]> {
    return this.request({ method: 'GET', path: '/restaurants' });
  }

  bootstrapDemo(input: BootstrapDemoInput): Promise<BootstrappedRestaurant> {
    if (input.confirm !== DEMO_BOOTSTRAP_CONFIRMATION) {
      throw new TypeError(`confirm must equal ${DEMO_BOOTSTRAP_CONFIRMATION}.`);
    }
    return this.request({ method: 'POST', path: '/bootstrap' });
  }

  listMenuItems(): Promise<MenuItem[]> {
    return this.request({ method: 'GET', path: '/menus' });
  }

  createOrder(input: CreateOrderInput): Promise<Order> {
    return this.request({ method: 'POST', path: '/orders', body: input });
  }

  addOrderItem(orderId: string, input: AddOrderItemInput): Promise<OrderItem> {
    return this.request({
      method: 'POST',
      path: `/orders/${encodePathSegment(orderId)}/items`,
      body: input,
    });
  }

  addPayment(orderId: string, input: AddPaymentInput): Promise<Payment> {
    return this.request({
      method: 'POST',
      path: `/orders/${encodePathSegment(orderId)}/payments`,
      body: input,
    });
  }

  getOrder(orderId: string): Promise<OrderDetail> {
    return this.request({ method: 'GET', path: `/orders/${encodePathSegment(orderId)}` });
  }

  listKdsTickets(): Promise<KdsTicket[]> {
    return this.request({ method: 'GET', path: '/kds/tickets' });
  }

  startKdsTicket(ticketId: string): Promise<Order> {
    return this.request({
      method: 'POST',
      path: `/kds/tickets/${encodePathSegment(ticketId)}/start`,
    });
  }

  serveKdsTicket(ticketId: string): Promise<Order> {
    return this.request({
      method: 'POST',
      path: `/kds/tickets/${encodePathSegment(ticketId)}/serve`,
    });
  }
}

export const createRestaurantApiClient = (options: EconGameClientOptions): RestaurantApiClient =>
  new RestaurantApiClient(options);
