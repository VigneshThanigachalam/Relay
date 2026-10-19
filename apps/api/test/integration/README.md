# Real database integration tests

`persistence.test.ts` starts real MongoDB 8.0.17 through the development-only `mongodb-memory-server-core` harness. It checks actual indexes, concurrent uniqueness conflicts, history guards, transaction commit/rollback, startup readiness and refusal of standalone MongoDB. These are infrastructure tests; full dispatch-service races are still pending.

The first run requires a binary download; subsequent runs use its cache. Temporary database processes/data are owned by the fixtures, and no application/production URI is used. Unix sockets are disabled; clients use TCP. No tests silently skip when the binary is unavailable. See root README for test-harness environment options.

`jobs.test.ts` adds real Supertest requests for job creation/replay/conflicts, filtering/detail/history, guarded ready transitions and their concurrent/rollback edge cases. Failure injection is explicitly identified in those tests; it wraps real MongoDB transactions rather than substituting a mock database.

`riders.test.ts` verifies rider identity, strict CRUD inputs, filtering, paginated active workload, metadata and capacity/zone/offline protections. Deterministic gates pause a real update after its snapshot read while a direct counter-write fixture commits; resuming proves real transaction conflict/retry behavior. These primitives do not claim a completed dispatch/reservation API.

`recommendations.test.ts` verifies real HTTP recommendation scoring, no-candidate/manual behavior, persisted historical snapshots, invalid requests/states, audit rollback, uncertain commits and eight concurrent evaluations. A controlled cancellation-write fixture forces a stale job snapshot to retry/reject. These tests do not claim assignment, reservation or cancellation APIs exist. Pure travel/eligibility/score tests live beside the engine.

`assignments.test.ts` verifies actual public create/ready/assign/history/workload, hard eligibility and override protection, durable receipts, rollback and failed-command audit. Concurrent requests prove one active assignment per job, one reservation for same-key retries and bounded capacity across competing jobs. Deterministic gates test both orders of actual public rider PATCH versus assignment. Terminal/expiry fixtures are labeled and do not implement response/release/worker behavior.
