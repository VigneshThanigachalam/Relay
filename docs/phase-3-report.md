# Phase 3 verification and interview notes

Phase 3 completes the job-management API feature. It adds job creation with persistent duplicate prevention, exact payload replay, filtered reads, detail/history, and the NEW → READY command with transactional audit. Necessary code comments explain why the concurrency/retry mechanisms exist. Rider management and later dispatch features remain pending.

## Implemented operations

| Operation                       | Actual behavior                                                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST /api/v1/jobs               | Zod validation, canonical payload hash, optional durable creation key, new job + JOB_CREATED in one transaction; 201 or 200 replay; 409 conflicts |
| GET /api/v1/jobs                | Exact normalized reference search, status and pickup-or-delivery zone filters, bounded pagination and stable creation-time/ID sorting             |
| GET /api/v1/jobs/:jobId         | Current public DTO; malformed ID 400, missing valid ID 404; private storage fields excluded                                                       |
| POST /api/v1/jobs/:jobId/ready  | Guarded NEW → READY with state version increment and JOB_READY event; already-ready replay is harmless; invalid states 409                        |
| GET /api/v1/jobs/:jobId/history | Chronological events and retained attempt DTOs; both arrays bounded with separate totals; no edit/delete API                                      |

See [the implemented job API](job-api.md) for payloads, responses, headers, exact query limits, error examples and a curl walkthrough. Request handlers parse input and choose the HTTP response; services own transactions and business rules. Native Express 5 promise rejection propagation reaches the common error middleware.

## Genuine Git history

Started from clean main at `d816ac8` and used only `feat/job-management`. These actual implementation commits preceded this report:

| Full actual hash                           | Subject                                                                    |
| ------------------------------------------ | -------------------------------------------------------------------------- |
| `2358d3b5998759beb283c0fc936d974dd59c3699` | feat(jobs): validate requests and define canonical job identity            |
| `007bd333719afd5427611975cb7c8a4eaf34e1a9` | feat(jobs): create jobs atomically with audit and durable duplicate replay |
| `fa61836d2ed64200f5f0c7978c000fa0c3ea4ec3` | feat(jobs): list inspect and prepare jobs with guarded audited transitions |

The report/status commit and no-fast-forward merge are recorded by the final actual Git log and ZIP handoff manifest. The complete prior phase history and retained feature branches are included. No remote/PR is claimed.

## Test results

`npm run check` passed: formatting, both TypeScript checks, the complete test suite, API production compilation and Vite production build. The frontend phase wording was then clarified and its typecheck/test/build rerun successfully; no backend code changed after the full check.

| Test file                                         | Passed tests | Scope                                                                            |
| ------------------------------------------------- | ------------ | -------------------------------------------------------------------------------- |
| apps/api/src/config/env.test.ts                   | 12           | Configuration                                                                    |
| apps/api/src/app.test.ts                          | 7            | HTTP foundation and dependency injection                                         |
| apps/api/src/http/errors.test.ts                  | 8            | Safe public validation/conflict/dependency/500 errors                            |
| apps/api/src/modules/domain/lifecycle.test.ts     | 44           | Pure lifecycle, expiry and capacity invariants                                   |
| apps/api/src/modules/domain/audit-details.test.ts | 17           | Typed audit payloads and score snapshot validation                               |
| apps/api/src/modules/persistence/models.test.ts   | 27           | Mongoose document validation                                                     |
| apps/api/src/modules/jobs/contracts.test.ts       | 28           | Canonical hashes, strict input/query types and bounds                            |
| apps/api/test/integration/persistence.test.ts     | 28           | Actual database indexes, guards, transaction infrastructure and startup          |
| apps/api/test/integration/jobs.test.ts            | 55           | Actual MongoDB + Supertest job workflows, concurrency, rollback, retry and reads |
| apps/web/src/App.test.tsx                         | 1            | Honest current-phase placeholder screen                                          |
| Total                                             | 227          | 226 API + 1 web across 10 test files                                             |

The job integration tests run on actual MongoDB 8.0.17 in replica-set mode, not a mock database. Key evidence:

- Twelve simultaneous identical keyed submissions yield one 201, eleven 200 replays, one job and one creation event.
- Concurrent changed payload/reference-key ownership yields one winner and a 409 with no second record.
- Eight simultaneous ready commands yield one effective transition, version 1 and two total lifecycle events.
- An audit-insert failure rolls back creation entirely. A ready audit failure rolls back status, version and sequence; a retry succeeds without a gap.
- A lost-commit-reply injection after a real successful creation commit is reconciled from stored identity. Ready uncertainty returns 503; retry sees READY and appends nothing.
- Replays work across separate service instances, equivalent timezone offsets/defaults, and after a once-valid deadline passes. Replays return current READY state rather than resetting NEW.
- Lists filter both sides of a zone, combine filters, reject repeated/operator-shaped/unknown queries and paginate deterministically with equal creation timestamps.
- History preserves typed actor/time/sequence data and fixture attempts, bounds both arrays, hides command keys/hashes and has no mutation endpoint.

The failure injections wrap actual MongoDB operations. They do not claim a physical network partition or replica failover was executed. Retained attempt reads use explicit fixtures; no assignment-resolution API is implied.

## Compiled application smoke

Started a fresh real temporary replica set, spawned `apps/api/dist/server.js` as a separate Node process and made real HTTP requests. Observed/asserted:

| Action                                | Result                                        |
| ------------------------------------- | --------------------------------------------- |
| Health readiness                      | 200 after bootstrap                           |
| Create a job                          | 201                                           |
| Replay identical creation             | 200, same job ID                              |
| Mark ready / repeat ready             | 200 / harmless replay, version 1              |
| Filter ready jobs by destination zone | 200, total 1                                  |
| Read detail                           | READY_FOR_ASSIGNMENT                          |
| Read history                          | JOB_CREATED then JOB_READY, sequences 1 and 2 |
| Reuse key with changed load           | 409                                           |
| Submit string load                    | 400                                           |
| SIGTERM                               | Clean exit 0                                  |

## Commands and corrections

- `git switch -c feat/job-management`: created the feature branch from clean main.
- Targeted contract/error/HTTP tests: 43 passed before the first implementation commit.
- Targeted creation integration suite: 26 passed before the creation commit.
- Expanded job integration suite: 55 passed before the list/detail/history/ready commit.
- API typechecks passed before each claimed implementation commit. Initial typechecks caught MongoDB error codes typed as string-or-number and an overly broad unknown test-body type; both were corrected with proper narrowing/types before tests/commits.
- `npm run format`, `npm run check`: formatting, all 227 tests, both typechecks and both builds passed.
- Web typecheck/test/build passed again after clarifying its phase wording.
- Compiled-server real-MongoDB smoke passed as described above.
- `git diff --check` passed; final documentation formatting/link checks and repository/archive integrity are checked before handoff.

No new dependency was added in Phase 3. The existing host npm proxy-config warning remains nonfatal. No dependency-security-audit result is claimed. Docker and a browser visual walkthrough remain unverified.

## Interview decisions

**Why canonical hashing?** Retrying JSON with different key order, explicit default priority, trimmed/case-normalized identifiers or an equivalent timezone offset is the same business request. Hashing the validated canonical fields avoids false conflicts. A changed load/priority/deadline is a different request and must not overwrite the original job.

**Why are both a unique index and a precheck needed?** The precheck explains replay/conflict behavior; only the database unique index closes the race between two transactions that both initially see no job. Duplicate-key recovery runs after abort, using the winning stored job. It is limited to job identity indexes so an audit-index failure cannot be mistaken for a successful replay.

**Why reject a different key on the same existing job?** This bounded design stores one optional creation key. Returning success for an unrecorded second key would let that key later create another job. Rejecting it is explicit and safe without adding a key-alias collection. The caller reuses the original key or omits it for exact-reference replay. Multiple durable key aliases could be added later if product requirements need them.

**Why check replay before a future deadline?** A successful request can be retried after its delivery deadline. Rejecting that retry would hide an existing success. Genuinely new jobs still require a future deadline, checked again on each transaction attempt.

**Why separate event sequence and state version?** Every inserted audit event gets an ordered sequence allocated on its job. A recommendation event later need not change delivery state. State versions guard actual lifecycle changes. Both counters must roll back with their transaction; count-plus-one allocation would race.

**Why are read totals and rows in a transaction?** Snapshot reads keep totals and page data consistent within one response. This has database overhead and does not freeze queues across later requests; it is a clear trade-off for this small application. Offset pages are capped at 10000 and 100 items; cursor pagination is a future volume improvement.

**Why do ready replays not use a key?** The command has one legal state change. Stored READY is sufficient to recognize an immediate repeat, without appending or incrementing again. Once the job advances further, a stale ready request conflicts rather than resetting it.

## Added and changed files

The repository contains 69 tracked files after this report. New files include common typed errors/tests, job contracts/tests/router/service/DTOs, a transaction-required audit helper, the real job API test suite, job-api.md and this report. Existing app/server wiring, UI phase label/tests, README and design/traceability docs were updated. Below is the tracked diff before this report; job-api.md and this report are additional new documentation files:

```text
M	README.md
M	apps/api/src/app.test.ts
M	apps/api/src/app.ts
A	apps/api/src/http/api-error.ts
A	apps/api/src/http/errors.test.ts
M	apps/api/src/http/errors.ts
M	apps/api/src/modules/README.md
A	apps/api/src/modules/history/append-event.ts
A	apps/api/src/modules/jobs/contracts.test.ts
A	apps/api/src/modules/jobs/contracts.ts
A	apps/api/src/modules/jobs/dto.ts
A	apps/api/src/modules/jobs/router.ts
A	apps/api/src/modules/jobs/service.ts
M	apps/api/src/server.ts
M	apps/api/test/integration/README.md
A	apps/api/test/integration/jobs.test.ts
M	apps/web/src/App.test.tsx
M	apps/web/src/App.tsx
M	docs/api-contract.md
M	docs/architecture.md
M	docs/delivery-plan.md
M	docs/engineering-notes.md
M	docs/lifecycle.md
M	docs/requirements.md
A docs/job-api.md
A docs/phase-3-report.md
```

## Remaining scope and next phase

Rider management, recommendations, assignment reservation, acceptance/rejection/timeout worker, manual reassignment, pickup/delivery/cancellation and the operational React dashboard remain pending. Job detail/history APIs now exist; later services still need to append their own typed events. This phase does not claim assignment-race or release-once correctness. Actor headers provide attribution but not authenticated identity. No public seeded demo data or final one-page presentation exists yet.

Next branch: `feat/rider-management` (Phase 4). Stop here for Phase 3 review.
