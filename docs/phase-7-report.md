# Phase 7 — Rider responses, expiry and capacity release

Phase 7 of 11 implements rider acceptance/rejection, guarded expiry, original-load release, and restart-safe polling. Traceability covers assignment section 3E P054–064, 3G P084–087 and testing P132–136. Accepted jobs can now hold their confirmed work; pickup/delivery/cancellation remain Phase 9. Dedicated manual queue summaries and broader investigation are Phase 8.

## Implemented behavior

POST `/api/v1/assignments/:id/accept` takes `{}`; reject takes a trimmed nonblank reason up to 500 characters. Both require actor, exact attempt ID, strict JSON and no query parameters. Matching stored decisions replay without new events/effects. Opposing decisions, changed rejection reasons and stale/mismatched pending IDs conflict. Missing attempts return 404. Safe DTOs/envelopes remain consistent.

Timely acceptance keeps capacity and active pointers, sets respondedAt, transitions job/attempt to ACCEPTED and records actor/time. Rejection/expiry terminalizes the attempt, sets end/release markers, validates/decrements its original load and one active-job slot, clears pointers and enters manual with RIDER_REJECTED or RESPONSE_TIMEOUT. Required outcome/manual events share the transaction. Corrupt/missing rider workload aborts without clamping or partial state. Old attempt IDs cannot change a new reservation; real reject/expire → reassignment → acceptance tests retain earlier outcomes/history.

Equality belongs to expiry. Each transaction callback captures a fresh decision time before guarded writes. A pre-deadline acceptance may commit after expiry if it wins; a retry may instead expire. Late response expiry commits before HTTP 409 is emitted. Duplicate outcomes/scanners have one committed release; no global exactly-once execution claim is made. Uncertain commit replies return 503 and matching retries inspect stored outcomes.

The worker starts after successful listen/database readiness, scans persisted PENDING/active/due attempts immediately, shortlists at most 100 by expiry/ID, and resolves sequentially. The next timer starts after the preceding scan completes. Individual failures are safely logged without stopping the batch; query failures retry next tick. Shutdown stops polling/new HTTP work, checks stop between attempts and drains current work before DB close within the existing 10-second process budget. A new process recovers overdue attempts from persisted expiry.

## Decisions to defend

**Why one resolution transaction path?** Accept, reject and expire compete for the same pending attempt/job. Shared pointer/state/deadline predicates prevent divergent rules; the winning terminal outcome owns release and audit. The release helper requires the same transaction and validates current/resulting counters.

**Why post-commit 409 for a late response?** Throwing inside the callback would undo expiry/release/manual history. The transaction instead returns the expired result, then the HTTP-facing method reports ASSIGNMENT_EXPIRED after commit. Repeated expired responses do not decrement again.

**Why decision time, not commit time?** Commit time cannot be predicted before conditional writes. The policy explicitly evaluates the deadline on each callback attempt. Tests pause both real transactions after their reads and before writes, then force each winner; another test forces an unrelated write conflict and verifies the retry gets fresh time.

**Why polling instead of job timers?** Persisted deadlines survive downtime. A startup scan recovers old work and multiple scanners remain safe through DB predicates. Scheduling after completion prevents local overlap. No TTL deletes history or pretends to implement workflow.

**What about overload and corruption?** Batch size is bounded at 100; failed items retry and do not stop the rest. A full oldest-first batch of persistent failures can delay newer work and requires repair/monitoring. Readiness reports database state, not worker lag. Transaction budgets and the 10-second process shutdown deadline remain separate from the two-hour response threshold. No extra infrastructure or dependency was added.

**What is still incomplete?** Delivery/cancellation release paths, dedicated queue summaries, operational UI, public seeds and final presentation remain later work. Counter reconciliation/authentication/production HA remain documented limits. Actor headers are simulated attribution.

## Genuine Git workflow

Started from clean main `11101ea8af0e43bc79a9a85248cf489866033f3e`, then created only `feat/assignment-resolution`. Actual implementation commits:

| Commit                                   | Change                                                                           | Checks before commit                                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 158785cd32b668717a0dd828b4dc109539cc350d | Guarded responses/expiry, shared release and HTTP routes                         | API typecheck; 26 real resolution checks                                                                   |
| 600e08c5e1fe1694a39918347cf452bb6615475e | Bounded startup worker, shutdown and deterministic concurrency/recovery coverage | API typecheck; 43 real resolution checks + 9 scheduler tests, including strengthened two-transaction gates |

Final documentation/review-indicator and non-fast-forward merge commits are in the included Git log and ZIP handoff. No authors/timestamps were rewritten. Local identity remains Codex Implementation Agent <codex@local.invalid>; no remote is configured and nothing was pushed.

## Verification

Verified on Node v24.19.0, npm 11.9.0 and Git 2.51.1.

| Command/check                                                              | Actual result                                                                                                |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Initial API typecheck + resolution suite                                   | Passed; 26 real MongoDB checks                                                                               |
| Scheduler typecheck/unit suite                                             | Passed; 9 checks                                                                                             |
| API typecheck + expanded resolution/scheduler suites                       | Passed; 52 checks (43 + 9), rerun after strengthening simultaneous race gates                                |
| `npm run check`                                                            | Exit 0: formatting, both TypeScript checks, 485 API tests in 17 files, 1 web test and both production builds |
| Compiled API with actual process stop/restart and a fresh real replica set | Passed; details below                                                                                        |
| `git diff --check`, local Markdown targets and two curl JSON examples      | Passed                                                                                                       |
| Docker availability probe                                                  | Docker absent; compose remains unverified                                                                    |

Total: **486 passing tests**, including **52 new resolution/worker checks**. No failed functional result was counted as a pass.

Compiled-process smoke used ASSIGNMENT_RESPONSE_THRESHOLD_MS=4000 and TIMEOUT_SCAN_INTERVAL_MS=100. It created a job/rider/assignment over HTTP, cleanly stopped the process before expiry, waited through the stored deadline, then started a new process against the same temporary database. Startup polling automatically moved the job to MANUAL_QUEUE/RESPONSE_TIMEOUT, retained one EXPIRED attempt and one system:timeout-worker expiry event, and released counters to zero. Old-ID acceptance returned 409. A new assignment accepted/replayed successfully and remained ACCEPTED past its response deadline. Another job rejected/replayed once, released only its own load, then reassigned/accepted using a new attempt ID; history retained REJECTED and ACCEPTED attempts and a reassignment event. Old rejected IDs could not accept new work. Final counters were four reserved units/two active attempts, matching accepted work. Both SIGTERM shutdowns exited 0. No manual database edits or configured user data were used.

No browser walkthrough or full pickup/delivery/cancellation demonstration is claimed.

The 43 resolution checks include real assigned attempts, accepted/rejected/expired outcomes, matching replay/opposing conflicts, preserved other reservations, exact deadline boundaries, late-response post-commit expiry, real reassignment/old IDs, missing/corrupt workload rollback, audit rollback, HTTP validation, unready dependencies and lost commit replies. Eight concurrent same-outcome requests and duplicate scans verify one committed event/release. Forced simultaneous snapshots demonstrate both acceptance/expiry winners and fresh retry clocks. Persisted scanners verify ordered bounded batches, future/accepted exclusions, retry/continue and a fresh service instance after downtime.

Nine fake-timer scheduler checks verify immediate startup, completion-based intervals, nonoverlap, stop/drain, safe failure retry and interval validation. They complement actual MongoDB transaction tests, not replace them. Fault injection wraps real operations and does not claim production failover/network partition. The suite does not use/drop a configured user database or silently skip MongoDB tests.

## Files and remaining work

The checkpoint contains **102 tracked files**. Nine files are new in this phase.

New files: dispatch/resolution.ts, resolution-router.ts, release-reservation.ts; worker/timeout-scanner.ts, timeout-worker.ts, timeout-worker.test.ts; test/integration/resolution.test.ts; docs/response-timeout-api.md; this report. Existing app/server wiring, .env.example comments, module/test notes, phase indicator/test, README, API guides, requirements, architecture/lifecycle, delivery plan and engineering notes were updated. No schemas/indexes/dependencies changed. Inspect `git diff --stat 11101ea..HEAD`.

Docker/compose and browser visual walkthroughs remain unverified. Real process/restart verification is separate from Docker verification. Delivery/cancellation, dedicated queue summaries, public seeds, UI and final one-page presentation remain pending. Next: Phase 8 on `feat/manual-reassignment`, finishing manual queue listing/investigation and reviewer reassignment scenarios. Stop after this Phase 7 checkpoint for review.
