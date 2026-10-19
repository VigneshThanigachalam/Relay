# Phase 8 — Manual queue investigation and reassignment

Phase 8 of 11 implements dedicated manual queue summaries and completes public investigation/reassignment coverage. Traceability covers assignment sections 3A P019/P021–022, 3E P058–064, 3G P086–091 and API P108–111. Existing assignment/resolution services already own safe reassignment; this phase composes them rather than introducing a duplicate mutation.

## Implemented behavior

GET `/api/v1/manual-queue` returns only MANUAL_QUEUE jobs with shared pagination and optional normalized zone matching either pickup or delivery. Rows are oldest received first (createdAt/ID), with filtered total and asOf. It is a read-only endpoint with no actor requirement or new audit event.

Each row includes existing job fields/reason, latest manual-entry time/actor and waiting duration from that audit event, a compact latest attempt and latest rejected assignment-command evidence. Recommendations/GETs/failures do not reset waiting time; only another actual manual entry does. Missing/reason-mismatched history produces historyIncomplete and null age/time/entry actor without hiding or repairing the job. Negative observed duration floors at zero. Latest attempt orders assignedAt/ID; event chronology uses per-job sequence.

Total, page and batched summaries are read sequentially in one snapshot. Projections remove scoring snapshots before grouping, and summaries are scoped to at most 100 page IDs. Full attempt/history endpoints retain their existing snapshot fields through a shared summary DTO extraction. Queue output excludes hashes/keys and large score snapshots. Existing indexes/collections suffice; no dependencies were added.

Public workflows verify no-candidate recovery, rejection/expiry investigation, new-key reassignment, matching replay, non-top override correction, retained earlier outcomes, old-ID guards and acceptance of replacement work. Eight competing manual actions produce one winner and seven visible conflicts with one replacement reservation. A controlled real count/read race verifies count/row/summary stay on one snapshot while another request commits reassignment; the next queue request sees removal.

## Decisions to defend

**Why no queue collection?** Membership is job state, and its history/attempts already explain it. A second collection would add a consistency obligation to every mutation. Existing transaction-owning assignment/resolution services continue to enforce capacity and lifecycle.

**Why audit-based age?** updatedAt is mutable and not evidence of a new manual entry. The latest entry sequence identifies the current wait. Missing/mismatched evidence is flagged explicitly rather than reconstructed. The age measures this queue stay, not overall job age or an SLA.

**Why oldest received order?** It reuses the current queue index and prioritizes older incoming jobs. Waiting time is shown separately. Sorting by derived manual-entry time would need a different aggregation/order trade-off or another denormalized field; it is not required by the assignment.

**Why compact summaries?** A score snapshot can contain the full fleet. Queue rows need outcome/rider/reason/release evidence; full scores stay in history. Batch queries avoid a per-row query pattern. Large individual histories can still increase aggregation cost, bounded by existing 5-second query and 15-second transaction budgets; no production throughput claim is made.

**Why snapshot reads?** Count, row state and latest attempt must tell one story even if another dispatcher reassigns between reads. The response can become stale after that snapshot; mutation services still recheck eligibility/state. Offset pages can change between requests.

**What does latest failure mean?** It is rejected-command evidence across this job's history, not a fabricated assignment and not necessarily newer than the current manual entry. Preserve its timestamp when presenting it. manualReason separately explains current membership.

**Why reuse the assignment endpoint?** A new intended attempt gets a new key; successful retries reuse that key. Old keys replay old receipts and cannot resurrect reservations. Existing hard gates/override reasons, partial active-attempt index and release rules remain authoritative.

## Real Git workflow

Started from clean main `c0e33a8042b7278c9637f265793bfcf543eafe6c`, then created only `feat/manual-reassignment`. Actual implementation commits:

| Commit                                   | Change                                                                           | Checks before commit                                      |
| ---------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------- |
| e7aac100ace054e6f292de247eac39affc2e1046 | Shared manual queue filter/bounds contract                                       | API typecheck; 10 focused contract checks                 |
| 289d538a4d90d6de6d1c3128d5c4756b3d47aece | Snapshot queue summaries, audit age, safe summary DTO and wiring                 | API typecheck; corrected 29-check focused suite (10 + 19) |
| 10c5e6d3d11e2ca793af8ab6843f6277ead1631a | Real investigation/reassignment, override/concurrency and snapshot-race coverage | API typecheck; 36 focused checks (10 + 26)                |

Final documentation/review-indicator and non-fast-forward merge commits are in the included log/handoff. No authors/timestamps were rewritten. Local identity remains Codex Implementation Agent <codex@local.invalid>; no remote is configured and nothing was pushed.

## Verification

Verified on Node v24.19.0, npm 11.9.0 and Git 2.51.1.

| Command/check                                                           | Actual result                                                                                                |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| API typecheck + manual queue contract suite                             | Passed; 10 tests                                                                                             |
| First focused queue/HTTP suite                                          | 1 failed expectation, 28 passed; corrected as detailed below                                                 |
| Corrected focused suite                                                 | 29 passed (10 + 19)                                                                                          |
| API typecheck + expanded queue/HTTP suites                              | 36 passed (10 + 26)                                                                                          |
| `npm run check`                                                         | Exit 0: formatting, both TypeScript checks, 521 API tests in 19 files, 1 web test and both production builds |
| Compiled API against a fresh real MongoDB replica set                   | Passed; all-three-reason demonstration below                                                                 |
| `git diff --check`, local Markdown targets and four guide JSON examples | Passed                                                                                                       |
| Docker availability probe                                               | Docker absent; compose remains unverified                                                                    |

Total: **522 passing tests**, including **36 new queue checks**. The initial incorrect test expectation remains documented rather than reported as a pass.

The compiled `apps/api/dist/server.js` demonstration used a 3,000 ms response threshold and 100 ms scan interval. Public requests first produced a NO_ELIGIBLE_RIDER queue row with no fake attempt, then created a rider and rejected real work, producing RIDER_REJECTED with compact evidence/zone filtering. An offline reassignment returned a visible failure without resetting entry time. A new pending assignment automatically expired under the live worker, producing RESPONSE_TIMEOUT and the correct EXPIRED summary/worker actor. A non-top choice required a reason, its corrected action recorded an override, exact replay returned the same attempt, and an old ID could not accept new work. After replacement acceptance, queue total was zero; history retained REJECTED, EXPIRED and ACCEPTED attempts plus two reassignment events. Selected rider workload was reserved=2/active=1. Invalid bounds returned 400 and SIGTERM exited 0. No manual database edits/configured user data were used.

No browser walkthrough or complete delivery/cancellation demonstration is claimed.

The initial focused run had **one failed test and 28 passing checks**: the expected latest failure sequence was 6, while the real seven-event history correctly included JOB_CREATED. The expectation was corrected to 7 and the complete expected history added. No production behavior changed for that correction. The rerun passed all 29, then the expanded suite passed all 36. No failed result is represented as a pass.

The 26 real-MongoDB/Supertest checks cover empty/filtered/paginated queues, all three real reasons, age source/stability/new entry, compact privacy, retained full history, incomplete evidence, time flooring, invalid queries, unready/timeout errors, public reassignment/acceptance/override, eight competing manual actions and consistent snapshot reads. Explicit read-model fixtures are labeled; real rejection/expiry workflows use actual public requests and outcome transactions. No database tests silently skip or replace MongoDB with an emulation. Fault injection does not claim production failover.

## Files and limits

The checkpoint contains **109 tracked files**. Seven files are new in this phase.

New files: manual-queue/contracts.ts, contracts.test.ts, service.ts, router.ts; test/integration/manual-queue.test.ts; docs/manual-queue-api.md; this report. Updated app/server wiring, shared history DTO mapping, phase indicator/test, module/test notes, README, feature guides, requirements, architecture/lifecycle, delivery plan and engineering notes. Inspect `git diff --stat c0e33a8..HEAD`.

Delivery/cancellation, operational UI, public seeds and final one-page presentation remain pending. Dedicated queue rows do not reserve a rider or guarantee future eligibility. Large histories and offset pagination retain their documented limits; arbitrary privileged database corruption is not repaired. Docker/compose and browser visual walkthroughs remain unverified. Next: Phase 9 on `feat/delivery-lifecycle`, implementing pickup/delivery/cancellation, terminal transition guards, release/history and race coverage. Stop after this Phase 8 checkpoint for review.
