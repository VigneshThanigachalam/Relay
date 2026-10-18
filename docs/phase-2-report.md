# Phase 2 verification and interview notes

Phase 2 implements the domain and database foundation and adds necessary explanatory code comments. It does not implement job management or later business features. The full assignment remains the source of truth; the source DOCX and Phase 1 history are preserved unchanged.

## Delivered behavior

- Pure status enums/transition rules for all eight job states and all attempt outcomes; terminal states cannot progress. Rejection/expiry allow manual-queue reassignment. Cancellation is allowed before pickup. The expiry helper treats equality as expired.
- Job, Rider, Assignment and JobEvent Mongoose schemas with required fields, known service-zone/priority/status values, positive safe-integer loads, counter invariants, assignment pointers, historical outcome markers, immutable identity/load snapshots and strict unknown-field handling.
- Type-specific Zod event-detail contracts and structured score snapshots. Event mutation guards protect supported Mongoose save/query/document/bulk paths; lean insertMany validation bypass is refused.
- Named unique, partial and queue/history indexes. The active-attempt index covers pending, accepted and picked-up attempts. Expired attempts and successful command keys remain stored. No TTL index deletes operational evidence.
- Explicit startup initialization verifies a writable replica set and sessions, builds declared collections/indexes without dropping operator-created indexes, and runs a real snapshot transaction before the API listens. Unsupported standalone MongoDB and failed unique-index creation prevent readiness.
- A reusable transaction boundary with snapshot reads, majority writes, primary routing, a 15-second driver transaction/retry budget and a 5-second commit limit. Sequential operations and explicit sessions are explained in comments.
- Real MongoDB test harness, fixture factories, schema/domain tests and integration tests. API cleanup closes its own connection rather than every connection on the Mongoose instance.
- README, architecture, lifecycle, API readiness description, traceability, engineering notes and placeholder phase label updated to match actual progress.

## Genuine Git workflow

The branch `feat/domain-models` was created from clean `main` at `fd71398`. The following actual commits preceded this report:

| Full actual hash                           | Subject                                                                 |
| ------------------------------------------ | ----------------------------------------------------------------------- |
| `5a4171368065c724844954aa4e0971e37fab9d1a` | docs(code): explain startup health and configuration boundaries         |
| `34b10175f6635f78e14b6542938d54aad83cc710` | feat(domain): define lifecycle transitions and reservation invariants   |
| `ad4d23baa13b69de9a007916ea525763a6a4cd5b` | feat(db): add job rider assignment and append-only audit schemas        |
| `6b7aa8694534f62b0f5427feb75d4642457a61ee` | feat(db): verify replica set readiness indexes and transaction rollback |

The verification/documentation commit and subsequent no-fast-forward merge are recorded by the final actual Git log and handoff manifest in the ZIP. Both feature branches and the complete prior history are preserved. No timestamps, authors, PRs or test outcomes have been fabricated.

## Verification results

`npm run check` completed successfully: Prettier, both TypeScript checks, the complete test suite, API tsc build and web Vite production build.

| Test file                                         | Tests passed | Verification scope                                                                                   |
| ------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------- |
| apps/api/src/config/env.test.ts                   | 12           | Safe config validation and two-hour default                                                          |
| apps/api/src/app.test.ts                          | 7            | HTTP foundation, errors and injected readiness                                                       |
| apps/api/src/modules/domain/lifecycle.test.ts     | 44           | Transitions, terminal states, expiry equality and counter invariants                                 |
| apps/api/src/modules/domain/audit-details.test.ts | 17           | All event payload types and valid/invalid score snapshots                                            |
| apps/api/src/modules/persistence/models.test.ts   | 27           | Document validators and defaults without a database                                                  |
| apps/api/test/integration/persistence.test.ts     | 28           | Actual MongoDB indexes, concurrency/retention, audit guards, transaction rollback and startup checks |
| apps/web/src/App.test.tsx                         | 1            | Honest current-phase UI label                                                                        |
| Total                                             | 136          | 135 API + 1 web, across 7 test files                                                                 |

The integration tests use actual MongoDB **8.0.17**, WiredTiger, a temporary single-node replica set and a separate standalone instance for refusal testing. The new test-only dependency `mongodb-memory-server-core` is a process/binary harness, not a JavaScript database emulator. It uses disposable fixture-owned data directories; the configured application/production URI is never used by tests.

An additional compiled-server smoke started a fresh real replica set, launched `apps/api/dist/server.js` as a separate Node process, and made real HTTP requests. `/health/live` returned 200; `/health/ready` returned 200 after successful initialization; `/api/v1/jobs` correctly returned 404 because that feature is deferred. SIGTERM drained/shut down cleanly with exit code 0.

## Commands and corrections

| Command/check                                                                                                              | Result                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `git switch -c feat/domain-models`                                                                                         | Branch created from clean main                                                                |
| `npm install --save-dev mongodb-memory-server-core@^10.3.0 --workspace @relay/api --fetch-retries=0 --fetch-timeout=30000` | Added 32 packages; exact resolved graph in lockfile                                           |
| Initial real-MongoDB probe                                                                                                 | Binary downloaded; default Unix-socket startup failed with open: Operation not permitted      |
| TCP-only real-MongoDB probe (`--nounixsocket`)                                                                             | Replica set started and stopped successfully without escalation                               |
| `npm run test --workspace @relay/api -- src/modules/domain/lifecycle.test.ts`                                              | 44 passed before domain-rule commit                                                           |
| Initial API typecheck                                                                                                      | Caught maxTimeMS incorrectly supplied as a driver command option; changed to driver timeoutMS |
| Schema/audit targeted tests                                                                                                | 27 + 17 passed before schema commit                                                           |
| First real persistence suite                                                                                               | 25 passed, 2 failed; failures investigated rather than claimed as passes                      |
| Persistence suite after corrections                                                                                        | 28 passed including the added index-bootstrap failure case                                    |
| `npm run typecheck --workspace @relay/api`                                                                                 | Passed before persistence commit                                                              |
| `npm run format`; `npm run check`                                                                                          | All formatting/typechecks, all 136 tests and both production builds passed                    |
| Built server + fresh real replica-set HTTP smoke                                                                           | live 200; ready 200; jobs 404; SIGTERM exit 0                                                 |
| `git diff --check`                                                                                                         | Passed                                                                                        |

The initial persistence failures exposed (1) an overly broad Mongoose disconnect that closed a fixture's separate connection and (2) a test expecting an immutable edit to be silently ignored, while strict mode correctly rejects it. Cleanup now closes only the API-owned connection, and the test asserts rejection plus unchanged stored fields. The final suite is green.

The host npm proxy-config warning remains nonfatal. No browser visual walkthrough, Docker execution, production HA validation or dependency-security-audit result is claimed.

## Practical interview explanations

**Why does an assignment need its own record?** A job can survive several failed dispatch attempts. Changing only its current rider would erase who rejected/timed out and why. An expired attempt stays historical; a new attempt gets its own identity and reservation.

**Why is the unique index partial on active=true?** Historical attempts must coexist. Pending-only uniqueness would stop protecting the job once confirmation changes the attempt to ACCEPTED. Pending, accepted and picked-up attempts all remain active until their reservation is released.

**Why are transactions needed if writes are atomic?** Single-document atomicity does not cover a rider counter, job pointer, attempt and event together. A transaction makes all four commit or roll back. The injected-failure integration test verifies this infrastructure; the actual dispatch service has not been written yet.

**What does schema validation not solve?** Mongoose document hooks validate creation/save, not arbitrary query updates. Refs do not enforce foreign keys. Later services must check referenced records and use conditional updates on status, version, current attempt and remaining capacity within a transaction. Pure transition functions express allowed changes; service replay handling still needs to be implemented.

**Is audit history tamper-proof?** Supported Mongoose mutation paths are blocked and event sequence uniqueness is database-enforced. Raw collection access and privileged DB users can bypass Mongoose. Audit-sequence allocation and coupling every business mutation to an append event belong to the next service features; there is no false claim that schema middleware alone provides that workflow.

**What makes the tests real?** The harness launches an actual mongod process with WiredTiger and replica-set transactions. Parallel inserts are rejected by real unique indexes; an injected error rolls back writes across all four collections. Mocked model calls would not prove those properties.

**Why are there two very different timeouts?** The two-hour rider threshold is a business deadline persisted on each future attempt. Millisecond driver/query/transaction limits bound database work and retries. They do not move a job to manual queue; that worker is still a later feature.

## Files added or changed since Phase 1

The list below records additions and modifications before this report; this report itself is also new. The final repository has 58 tracked files. The ZIP omits dependencies, downloaded MongoDB binaries, fixture databases and build output; it includes all source, config, docs and actual Git history.

```text
M	README.md
M	apps/api/package.json
M	apps/api/src/app.ts
M	apps/api/src/config/env.ts
M	apps/api/src/infrastructure/database.ts
M	apps/api/src/modules/README.md
A	apps/api/src/modules/domain/audit-details.test.ts
A	apps/api/src/modules/domain/audit-details.ts
A	apps/api/src/modules/domain/constants.ts
A	apps/api/src/modules/domain/invariants.ts
A	apps/api/src/modules/domain/lifecycle.test.ts
A	apps/api/src/modules/domain/lifecycle.ts
A	apps/api/src/modules/persistence/initialize.ts
A	apps/api/src/modules/persistence/models.test.ts
A	apps/api/src/modules/persistence/models.ts
A	apps/api/src/modules/persistence/transaction.ts
M	apps/api/src/server.ts
A	apps/api/test/helpers/fixtures.ts
A	apps/api/test/helpers/mongo.ts
M	apps/api/test/integration/README.md
A	apps/api/test/integration/persistence.test.ts
M	apps/api/tsconfig.json
M	apps/api/vitest.config.ts
M	apps/web/src/App.test.tsx
M	apps/web/src/App.tsx
M	apps/web/vite.config.ts
M	docs/api-contract.md
M	docs/architecture.md
M	docs/delivery-plan.md
M	docs/engineering-notes.md
M	docs/lifecycle.md
M	docs/requirements.md
M	package-lock.json
A docs/phase-2-report.md
```

## Limitations and next feature

Docker remains unavailable, so the compose recipe remains unexecuted. Test binaries require a first-run download or configured local executable. The pure/schema/transaction tests do not prove service-level two-dispatcher races, exactly-once capacity release, HTTP idempotency or a running timeout worker; those features are still pending. A real browser walkthrough will be needed once the dispatch interface exists.

Next branch: `feat/job-management`, implementing create/read/list/filter/detail/mark-ready with request validation, canonical payload hashing, duplicate/idempotency behavior, transactional creation audit and corresponding real-database HTTP tests. Stop here for Phase 2 review before proceeding to that feature.
