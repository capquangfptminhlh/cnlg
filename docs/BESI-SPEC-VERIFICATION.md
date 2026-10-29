# BESI Verified Specifications

This adds admin-reviewed connector, length, power and color data alongside the existing source catalog. It does not replace or mutate existing products, stock, checkout or prices.

## Workflow
1. Open admin-besi.html, then the specification coverage section.
2. Click "Kiểm duyệt" for a product and select its exact variation.
3. Check the current variation's actual attributes. Rules offer preliminary suggestions.
4. Approve attributes with explicit human confirmation, or undo them later.
5. Reviewed records persist in data/besi-spec-overrides.json independently from source feed synchronization. The server-side search index refreshes immediately.
6. Incomplete and ambiguous listings remain in a separate "Có thể phù hợp" group, never presented as confirmed matches.

## Optional private AI
The AI suggestion button only works when a local Ollama model is installed and the private BESI_SPEC_LOCAL_MODEL environment variable is set to an installed model name (e.g. qwen3:4b). Only public, sanitized display names go to the fixed loopback endpoint http://127.0.0.1:11434/api/generate. No external AI provider, source credentials, cost, warehouse data or source feed is transmitted. AI suggestions do NOT auto-save or auto-verify product specs. Without an installed local model the human review and catalog filters work, and the AI button reports unavailable.

## Deployment / reliability
- The file data/besi-spec-overrides.json is gitignored. Store it on a durable backed-up volume, not in an ephemeral container.
- Atomic JSON writes currently support one Node server process; migrate to a transactional database before running multiple replicas.
- A listing with multiple variants must have the actual variant records to be eligible for verified attributes. Missing or stale variants are not automatically confirmed.
- Production besi.com.vn must deploy the merged commit before its new admin API and UI become available.
- Validate with real products from diverse sources, track false positives, uncovered candidates and variation-ID churn.
- Future category schemas should cover phone case model, charger wattage, power bank capacity, storage, clothing size and color. Do not assume cable-specific parsing covers these categories.

Run npm test and npm run test:ui before release.
