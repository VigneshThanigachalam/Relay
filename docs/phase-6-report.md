# Phase 6 — Atomic assignment and capacity reservation

Phase 6 of 11 implements assignment creation, capacity reservation, successful-command replay, manual override reasons and rejected-command history. Traceability covers assignment sections 3D P050, 4 P102–114, 5 P118–125 and 6 P129/P136. Rider acceptance/rejection, automatic timeout and release are Phase 7, not functionality claimed by this checkpoint.

## Implemented behavior

POST `/api/v1/jobs/:jobId/assignments` requires actor, Idempotency-Key and a strict riderId/optional reason body. It recomputes the scoring snapshot, checks hard eligibility and requires a reason for a non-top choice. Only READY/MANUAL jobs without active work can receive a new attempt. The transaction guards job status/version/empty pointers, reserves the rider's original load and one active-job slot, creates PENDING work, and appends recommendation/assignment plus applicable override/reassignment events. Manual reason is cleared and state version increments once.

The stored attempt captures immutable job/rider IDs, original load, assignedAt/expiresAt, successful key/hash, actor, reason and v1 snapshot. Existing active-attempt and job/key unique indexes are reused. Both job and rider detail/history APIs reflect the committed attempt. Nothing is published externally; no new dependencies, collections or indexes were needed.

Successful same-key/canonical-payload retries return the original attempt and current job before state/eligibility checks. They do not reserve again or append events. Changed rider/reason conflicts; keys are scoped to a job. A recognized assignment-index or unknown-commit result is reconciled from a durable receipt after its original transaction ends. Unresolved outcomes return 503, without inventing a definite failure event.

Known-job validated business rejections append ASSIGNMENT_FAILED after rollback, in a separate transaction, retaining actor/time/rider/code and specific eligibility reasons. Failure-audit confirmation problems return 503. Malformed requests/missing jobs do not fabricate history. Rejected commands do not bind keys; corrected input can be submitted with the same rejected key. Each rejected request can add another failure event. A process crash between state rollback and failure-history commit can omit the event unless the caller retries; normal audited business errors are returned only after that event commits.

## Practical decisions to defend

**Why both transactions and predicates?** A pure capacity check reads a snapshot that may be stale. The selected rider update itself requires availability, both zones, matching capacity/counters and sufficient remaining units, then increments counters. A competing reservation/configuration write causes retry and a fresh check. The job's guarded update and partial active-attempt index protect the same-job race. A multi-document transaction makes job/rider/attempt/events all commit or roll back.

**Why not trust Mongoose validators?** Query `$inc` does not execute the complete document invariant check. The engine checks valid local counters; bounded guarded increments preserve nonnegative safe-integer invariants. It does not reconcile preexisting counter-to-attempt drift; reconciliation remains future work.

**Why recompute recommendations?** A viewed suggestion does not hold capacity. The assignment transaction records the actual fleet snapshot it evaluated. A stale choice can now require a reason or be ineligible. Other unselected riders are not globally locked; ranking reflects the snapshot, while the selected rider's hard eligibility/capacity is guarded by its write.

**Why store replay identity on the attempt?** It is a durable receipt for the one reservation. Replays after an actor/configuration/availability change or later terminal outcome return that original resource, without another reservation. Hashing uses canonical rider/reason; a retry cannot rewrite the original actor. There is no process-memory idempotency map or fabricated human attribution.

**Why a separate failure transaction?** The rejected reservation transaction must roll back. Recording a separate event afterward preserves the rejection without creating a fake reserved attempt. Returned business failures have confirmed history; a failure-history outage/ambiguous outcome returns 503. The crash window and possible duplicate rejection events are documented.

**What counts as an override?** Selecting any eligible rider other than current rank 1 requires a nonblank reason and records both rider IDs, reason, actor and version. A note for the top rider is stored on the attempt without a false override event. A reason never bypasses availability, coverage or capacity.

**What does expiry do now?** Assignment stores assignedAt + validated threshold (default two hours); changed configuration affects future attempts. The worker/response/release services are not implemented yet. Passing expiresAt alone does not move the job or release its reservation in this phase.

## Real Git workflow

Started on clean main `1b6784cbb76bad7075d757d40eac8df670677c4f`; created `feat/assignment-reservation` as the only active feature branch. Actual incremental commits:

| Commit                                   | Change                                                          | Evidence before commit                                   |
| ---------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------- |
| 30a0b2492f168b738700f689dd91b1feecf8f214 | Canonical command contracts, required actor/key and hashing     | 13 focused tests; API typecheck                          |
| 2f1560819cfffad6e3b2ed1113f129253de77eb7 | Atomic reservation/attempt/audit, receipt replay and API wiring | API typecheck; 42 focused tests (13 contracts + 29 HTTP) |
| bf1e116099e7c452722a5986a7926f1fa6411a60 | Concurrent reservation and actual configuration-race coverage   | API typecheck; 56 focused tests (13 + 43)                |
| 53650da55a87647f3bbc79bbdb5a493c1507f355 | Specific eligibility reasons retained in failed-command history | 43 real assignment HTTP checks rerun                     |

The final documentation/phase-indicator commit and non-fast-forward merge are in the included Git log and ZIP handoff. Authors/timestamps were not rewritten. Local identity remains Codex Implementation Agent <codex@local.invalid>; no GitHub remote/account is connected and nothing was pushed.

## Verification

Verified on Node v24.19.0, npm 11.9.0, Git 2.51.1.

| Command/check                                                         | Actual result                                                                                                |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Focused dispatch contracts                                            | 13 tests passed                                                                                              |
| API typecheck plus initial dispatch/HTTP suites                       | Passed; 42 tests (13 + 29)                                                                                   |
| API typecheck plus expanded dispatch/HTTP suites                      | Passed; 56 tests (13 + 43)                                                                                   |
| Assignment HTTP rerun after failure-reason improvement                | 43 passed                                                                                                    |
| `npm run check`                                                       | Exit 0: formatting, both TypeScript checks, 433 API tests in 15 files, 1 web test and both production builds |
| Compiled API in a separate Node process with a fresh real replica set | Passed; smoke details below                                                                                  |
| `git diff --check`, local Markdown targets and new API JSON examples  | Passed                                                                                                       |
| Docker availability probe                                             | Docker absent; compose remains unverified                                                                    |

Total: **434 passing tests**, including **56 new dispatch checks**. No failed functional test or silently skipped database test was counted as a pass.

The compiled `apps/api/dist/server.js` smoke used ASSIGNMENT_RESPONSE_THRESHOLD_MS=5000 and actual public HTTP requests. Readiness returned 200. Missing override reason returned 409; a corrected request under the same rejected key created a pending attempt (201), and exact replay returned that same attempt (200). Its stored expiry was exactly 5,000 ms after assignedAt. A second dispatcher got 409, reducing capacity below reserved load got 409, and another job could not reuse insufficient rider capacity. Assigning that job to another eligible rider succeeded. History retained one override and two rejected-command events for the first job, plus its one attempt. Rider workload showed reserved=2, active=1, remaining=1 with one active attempt. SIGTERM exited 0. The temporary database was fixture-owned and separate from configured user data.

This checkpoint does not claim a browser walkthrough, timeout/release test or complete delivery demonstration.

The 43 real-MongoDB/Supertest checks include public create/ready/assign/history/workload, exact capacity, same-zone work, threshold changes, manual assignment, overrides, stale scoring, unavailable/missing/unsupported/full/corrupt riders, canonical replay, changed payload/key scope, lost commit replies, unknown outcomes, validation/state conflicts, audit rollback and failure-history outages. Terminal/expiry fixtures are labeled; they verify receipt lifetime and retention, not the unimplemented worker/release service.

Concurrency evidence: eight different command keys on one job yield one creation and seven audited conflicts; eight identical keys yield one creation and seven replays, one reservation and no extra events. Six jobs sharing capacity four with load two produce two assignments and four capacity rejections. Reusing a key concurrently with different payloads binds exactly one. Public rider PATCH races are verified in both orders: edits before reservation trigger fresh eligibility checks; reservation before capacity/zone removal triggers configuration conflicts; offline after reservation preserves active work/counters. Every coherent workload assertion compares counters with actual active attempts.

The suite launches actual MongoDB 8.0.17 replica sets through the existing development harness; no application database URI is used or dropped, no emulated database substitutes for MongoDB, and no database tests silently skip. Fault injection is identified and does not claim a real network partition or production replica failover.

## Files and limits

The repository contains **93 tracked files** at this checkpoint. Seven files are new in this phase.

New files: dispatch/contracts.ts, contracts.test.ts, router.ts, service.ts; test/integration/assignments.test.ts; docs/assignment-api.md; this report. Existing app/startup/config comments, module/test notes, README, phase indicator/test, traceability, API guides, architecture, lifecycle, delivery plan and engineering notes were updated. Inspect `git diff --stat 1b6784c..HEAD` for the exact tracked diff.

No rider response, automatic timeout, release-once, delivery/cancellation service, dedicated manual-queue summary, operational UI, public seed command or final presentation is included. Existing job status filtering lists manual jobs; the assignment route accepts manual work. True reject/expire → reassignment demonstration remains Phase 7/8. Docker/compose and browser visual walkthroughs remain unverified. Full-fleet ranking/snapshots are unbounded in rider count; authentication, counter reconciliation and production HA remain documented limits.

Next: Phase 7 on `feat/assignment-resolution`: accept/reject/expire with matching attempt/state guards, release exactly once, and an indexed persisted-deadline worker with restart recovery and race tests. Stop here for Phase 6 review.
