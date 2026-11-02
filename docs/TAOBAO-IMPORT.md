# Taobao → BESI: authorized private staging

This is phase 1 of the Taobao integration in CNLG. It imports only products
accessible via the configured, authorized Taobao Open Platform affiliate
material-search API. It is **not** a full Taobao catalog dump.

## Behavior

- Searches Chinese keywords, follows API pages, upserts by Taobao item ID.
- Keeps original title, optional descriptions, and variant names; if a locally
  installed Ollama model is configured, translates each field to Vietnamese.
- Checks that complete translations contain no Han characters; failures stay
  pending, not published. The affiliate API often does not provide descriptions,
  variants, or reliable stock, so these fields can remain missing.
- Writes to **gitignored private** data/taobao-staging.json, not to TechMall,
  DropBuy, or BESI's sellable product catalog. Partial keyword scans do not
  remove prior staged products.
- Treats Taobao promotional prices in CNY as *reference prices*, not as
  landed supplier costs. No fabricated inventory, shipping, FX rate or checkout.
- Staging has a 25,000-item cap for local JSON safety. Migrate to indexed
  database and workers before expanding to large-volume ingestion.

## Setup

1. Obtain authorized access and data usage rights to the relevant API.
2. Install/start Ollama locally with a Chinese → Vietnamese capable model.
3. Store credentials in the private .env **on the actual server**, never GitHub:

   TAOBAO_APP_KEY=...
   TAOBAO_APP_SECRET=...
   TAOBAO_ADZONE_ID=...
   TAOBAO_DATA_PERMISSION=1
   TAOBAO_LOCAL_MODEL=<installed-model-name>
   TAOBAO_PAGES_PER_KEYWORD=2

4. Run on Windows or Linux:

   npm run sync:taobao:stage -- "手机数据线" "手机充电器" "手机壳"

5. Inspect data/taobao-staging.json privately and review language, rights,
   genuine landed cost, stock, SKU variants, and fulfillment feasibility.

## Not yet done

- No production credentials have been provided or tested.
- No Taobao bulk extraction outside the permissions and search results of
  the official API; no CAPTCHA/session bypass.
- No live product publication, auto-order, international freight quotation,
  tax/customs calculation or automatic Vietnamese pricing at checkout.
- No image downloading or image-text OCR. Image licensing and translation
  overlay require separate rights and implementation.
- No assumption that affiliate material equals merchandise one can resell.

Next phase: build reviewed sourcing contracts + a private indexed database,
translate full detail/variants when supplied by an authorized feed, confirm
landed-cost/availability with partner, then enable sellable products behind
a dedicated fulfillment adapter, with smoke tests before rollout.
