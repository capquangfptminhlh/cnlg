# BESI Multi-Supplier Marketplace — Implementation v1

## Product model

BESI is a unified retail + wholesale customer experience built on many independently
operated wholesalers, importers and large distributors. Buyers see BESI's unified
catalog and checkout rather than an upstream website. Buyers may purchase one unit
or request quantity-based tier pricing.

- Supply partners join free: no listing fee, participation fee or per-order
  commission charged by BESI in this model.
- Partners provide product data, stock and source prices privately; after a customer
  places an eligible order, they pack and ship the assigned parcel.
- BESI controls its own public price and customer support; profit must be measured
  after payment fees, return reserve, shipping subsidies and costs.
- The frontend must not receive source IDs, supplier SKUs, source price, upstream
  domains, account cookies, warehouse identities or private fulfillment payloads.
- Legal seller-of-record, invoicing, taxes and seller disclosures must still be
  determined and handled appropriately. Concealing source identifiers is **not**
  authorization to hide information required by law.

## What is implemented

| Component | Location | State |
| --- | --- | --- |
| Admin supplier registry / verification | `services/besi/store.js` | Works; local single-instance persistence |
| Partner SKU JSON intake (200 per import) | `/api/admin/besi/feeds/:supplierId` | Works; authenticated admin |
| Master catalog / deduplication | `services/besi/core.js` | Works; precise product identifiers only |
| Quantity price engine | `core.tierPrice` | Works; fee, reserve and margin floor |
| Supplier allocation | `core.draftAllocation` | Works; draft only, no upstream send |
| Admin Supplier Hub | `/admin-besi.html` | Works behind existing admin session |
| Anonymous catalog / quote | `/api/besi/products` / `/api/besi/quote` | Feature-flagged OFF by default |
| Actual supplier login and feed sync | — | Not implemented |
| Buyer checkout migration | — | Not implemented |
| Partner order dispatch | — | Not implemented |
| Tax invoice / payout / returns | — | Not implemented |
| Fully independent private database | — | Not implemented |

## How to try it safely

1. Run the normal backend in a non-production environment with its existing admin
   credential configured securely. Do **not** paste credentials into GitHub.
2. Log in via `/admin.html`, then open `/admin-besi.html`.
3. Register a partner. It defaults to inactive / unverified; verify and enable it.
4. Import safe offer JSON via Supplier Hub (SKU, GTIN, cost, stock). Production source
   URLs must never be included; images must be approved first-party BESI media paths.
5. Inspect the master catalog and its 1/5/20/100-unit prices.
6. Create a draft allocation from the catalog's public BESI ID.
7. Run `npm test` and `npm run test:ui` before any rollout.

## Operational API contract

All `/api/admin/besi/*` routes require the existing admin session or admin
authentication. Use same-origin POST/PATCH/PUT requests; CSRF validation is enforced
for cookie-based admin mutations. No partner is self-registered publicly in v1.

| Method | Route | Use |
| --- | --- | --- |
| GET | /api/admin/besi/overview | Private partner list and counters |
| GET | /api/admin/besi/offers | Private paginated offer list |
| GET | /api/admin/besi/catalog | Source-masked master catalog preview |
| POST | /api/admin/besi/suppliers | Register a new unverified partner |
| PATCH | /api/admin/besi/suppliers/:id | Explicit verify, enable or pause |
| POST | /api/admin/besi/feeds/:supplierId | Import <=200 approved offer rows |
| PUT | /api/admin/besi/pricing | Update bounded price rules |
| POST | /api/admin/besi/allocate | Produce **draft-only** multi-parcel plan |
| GET | /api/admin/besi/plans | Review prior draft allocations |
| GET | /api/besi/products | Public source-masked catalog, disabled by default |
| POST | /api/besi/quote | Source-masked quote, shipping NOT final, disabled by default |

For internal staging only, set `BESI_MARKETPLACE_PUBLIC=1` to test public
catalog/quote. This DOES NOT activate checkout or dispatch. `orderEnabled`
remains false and `payableTotal` is null. Never confuse this with a paid order.

## Data and source confidentiality

Persistent private state: `data/besi-supply-hub.json`, excluded from Git by
`.gitignore`. Files use restrictive owner-only permissions on supported systems
and atomic rename, but this is **not a production multi-node database**.

The current GitHub repository is public and already contains legacy supplier
integration code. Generic new modules do not include a real partner identity or
credential; however complete supply-chain secrecy requires moving real integrations
and sensitive mappings into a **private backend repository**. Before production:
- migrate suppliers, source mappings, price cost, order routing into a private DB;
- use per-supplier scoped credentials and audit logs, never share admin passwords;
- serve images from a first-party content-addressed media service with checked URLs;
- mask supplier details on public APIs, HTML, shipping documents where law permits,
  notifications, metadata, logs and customer communications;
- implement merchant verification, refund handling, tax invoicing and privacy
  compliance.

## Next production milestones

1. **Supplier connectors**: scheduled feed ingestion, source-specific adapters
   running privately, inventory reservations, freshness and health monitors.
2. **Buyer catalog**: serve tens of thousands of SKUs with SQL indexes, normalized
   category/spec attributes, fast text search, CDN thumbnails, re-order lists and
   Excel bulk import.
3. **Orders and finance**: one buyer cart, per-source child shipments, final shipping
   quote before payment, idempotent checkout, approval workflow, refunds, invoicing,
   financial reconciliation and audit history.
4. **Partner portal**: identity/KYC, scoped roles, feed sync, parcel pickup and
   stock confirmations. No sensitive upstream source information in buyer-facing UI.
5. **Reliability**: PostgreSQL transactions, stock reservation with TTL, queue and
   retries, webhook signature validation, load testing and monitoring.

## Acceptance gates

- No supplier identifier or purchase cost in anonymous JSON (automated tests).
- Unknown/unverified suppliers cannot sell; no oversell in draft allocation.
- Public price covers all allocated quantities, including backup suppliers.
- Quote never claims delivery/shipping or creates a real order.
- Existing checkout, shipping and source synchronization continue unchanged.
- Public feature flag remains OFF until staged browser + order-flow testing.
