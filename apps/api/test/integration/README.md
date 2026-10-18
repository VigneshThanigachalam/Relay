# Real database integration tests

`persistence.test.ts` starts real MongoDB 8.0.17 through the development-only `mongodb-memory-server-core` harness. It checks actual indexes, concurrent uniqueness conflicts, history guards, transaction commit/rollback, startup readiness and refusal of standalone MongoDB. These are infrastructure tests; full dispatch-service races are still pending.

The first run requires a binary download; subsequent runs use its cache. Temporary database processes/data are owned by the fixtures, and no application/production URI is used. Unix sockets are disabled; clients use TCP. No tests silently skip when the binary is unavailable. See root README for test-harness environment options.
