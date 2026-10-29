# BESI Universal Discovery – all-industry filtering

This runs on top of the existing 19k+ sellable products; it never reimports or overwrites upstream feeds.

## What buyers get

- Search by product name, brand, SKU, category label and variation name (accent-insensitive).
- Filter by ANY populated catalog category (including nested subcategories), brand, visible variation price, sort and a chosen product specification.
- Available specifications come from current sellable catalog titles/variations: phone model, cable length, wattage, mAh, color, apparel/shoe size, material, memory, RAM, connection type.
- Product counts are deduplicated by real BESI product ID and paginated server-side.
- Unknown or ambiguous variations are in a separate **Có thể phù hợp – cần kiểm tra** list. No phantom sizes, prices, stock, ratings or sales.
- If a category has no reliable structured specifications, category + brand + price + full-text search remain available. The app does **not** promise every item has an automatically inferred attribute.

## API

- `GET /api/products/discover/options?q=&category=` derives current category tree, brands, and facet values from real stock. Facet count is a distinct product count, not item units.
- `GET /api/products/discover?q=&category=&brand=&attr=&value=&minPrice=&maxPrice=&sort=&page=&possiblePage=&limit=24` searches all sellable product categories.
- Allowed attr values: model, length, watt, capacity, color, size, material, storage, ram, connector. The attr value must already be discoverable in the current in-memory catalog.
- Every result passes through `publicProduct()` to remove supplier identifiers, costs and source links.

## Operational behavior

- Full-catalog derived index is cached and invalidated when product/category references change; periodic refresh catches in-place changes.
- At 20,000 SKUs, the index is in-memory, not a persistent search service. Tune memory and response latency on the actual Windows origin.
- Search filters use explicit data only. An item with an unverified multi-variation listing is not certified as a specific 2m/XL/100W variant.
- Real source synonyms and sizes still require ongoing QA. Build a structured per-category attribute schema or reviewed overrides for higher precision. The universal engine is a broad first pass, not a guarantee of perfect recall.

## Deployment

After merge, production must update/restart the BESI Windows Node process. Check `/healthz` release and both `/api/products/discover/options` and `/api/products/discover` on the real domain. GitHub CI does not deploy a running production server.
