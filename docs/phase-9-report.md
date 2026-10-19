# Phase 9 — delivery lifecycle

Implemented pickup, delivery and cancellation over the existing four collections. No new infrastructure, schemas or dependencies. Capacity stays reserved through acceptance and pickup; delivery/cancellation releases the attempt's original load exactly once in the same transaction as state and audit.

Focused verification: API TypeScript check passed; `npm test --workspace @relay/api -- test/integration/delivery.test.ts` passed all 19 real-MongoDB integration tests. Coverage includes full lifecycle/history, forbidden transitions, stale/foreign attempts, matching retries, eight-way duplicate delivery/cancellation, pickup/cancel and timeout/cancel races, audit/counter rollback and lost commit replies. Full repository verification is run before merge.

Operational UI and seeds remain later phases; this report records the Phase 9 boundary.

Full `npm run check` passed: formatting, both TypeScript checks, 540 API tests plus 1 frontend test (541 total), and both production builds.
