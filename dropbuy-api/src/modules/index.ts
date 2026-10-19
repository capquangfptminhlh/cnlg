import type { FastifyInstance } from 'fastify';
import account from './account.js';
import catalog from './catalog.js';
import cart from './cart.js';
import orders from './orders.js';
import shopOrders from './shop-orders.js';
import marketing from './marketing.js';
import wallet from './wallet.js';
import referral from './referral.js';
import shop from './shop.js';
import tenant from './tenant.js';
import admin from './admin.js';
import integrations from './integrations.js';

export const modules: ((app: FastifyInstance) => void)[] = [account, catalog, cart, orders, shopOrders, marketing, wallet, referral, shop, tenant, admin, integrations];
