# Phase 5 — Rider recommendations

Phase 5 of 11 implements the recommendation service and API. The original assignment remains the source of truth: section 3C/3D eligibility and explanation, 3G recommendation history, and section 6 unavailable/capacity/no-candidate cases. Assignment and reservation are the next phase.

## Implemented behavior

- Pure hard eligibility: AVAILABLE, both service zones, enough free units; exact capacity equality is eligible. Corrupt local counters exclude the rider with an explicit reason.
- Scoring v1 combines simulated travel, active work, occupied capacity, priority and deadline cost. Each result contains its components, available units, active count, reasons, timestamp and fallback flag. Binary code/ID ties and six-decimal costs are deterministic.
- POST `/api/v1/jobs/:jobId/recommendations` validates ID, actor, `{}` body and empty query. Only READY/MANUAL jobs are legal.
- Every evaluation stores RIDERS_RECOMMENDED with its snapshot. With no candidates, READY enters MANUAL_QUEUE with NO_ELIGIBLE_RIDER and a second event in the same transaction.
- Repeated manual evaluations preserve original reason/version and do not duplicate manual entry. Newly available riders become visible while the job remains manual for explicit assignment.
- Audit failure rolls back state, event allocation and inserted events. Concurrent job writes cause a fresh transaction legality check. Rider reads remain advice and reserve no units.
- Startup wires the new service; the React foundation screen identifies Phase 5 without exposing operational actions.

## Architecture decisions to defend

**Why a pure engine?** Eligibility and scoring can be tested without HTTP/Mongoose, then reused by the Phase 6 assignment transaction. Database access, actor attribution and audit writes remain in the service. Routes only validate and call it.

**Why keep exclusion reasons?** Operators can distinguish unavailable riders, missing coverage, full capacity and corrupt counters. An override in Phase 6 must still pass the same hard gates. Invalid counters are not silently repaired.

**Why these costs?** They are a transparent synthetic heuristic suited to the assignment, not a claim of optimal routes. Priority increases time's weight relative to workload. Deadline penalty prices estimated lateness; overdue jobs remain actionable. The documented matrix requires no external maps service. Missing/invalid legs conservatively cost 60 minutes each.

**Why store a snapshot?** Current rider state changes. Storing version, numeric scores and explanations preserves why the recommendation was made. Names/codes are resolved through current rider APIs; this phase does not snapshot rider identity labels.

**Why POST and a transaction?** Evaluation creates audit history and can change job status. The snapshot, job transition and both events must agree after success or rollback. Appending increments the job's event sequence, so concurrent job writes force a fresh callback/state check.

**Does it reserve a rider?** No. Snapshot reads do not lock riders against concurrent edits. Phase 6 must recompute eligibility and conditionally increment the same rider document with the job/attempt/audit changes in one transaction. These tests do not prove reservation or release-once behavior.

**What does retry mean?** Every request is a fresh evaluation; no Idempotency-Key replay contract exists here. An uncertain commit returns 503. Retrying can create another recommendation record while the manual transition remains once. This makes repeated operator evaluations visible without claiming globally exactly-once requests.

**Why read the whole fleet?** It keeps exclusions explainable for this small assignment. Fleet arrays and audit snapshots have no rider-count cap; larger operations need indexed shortlists, bounded explanations and retention planning. No new collection, index, dependency or infrastructure was needed.

## Git workflow

Started from clean main `1249c299401972acd62046beff320c667a686691`, then created only `feat/recommendations` for this phase. Genuine implementation commits:

| Commit                                   | Change                                                                   | Checks before commit                                     |
| ---------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------- |
| 861d8229f899853a519b20dae7156b32a66306ce | Pure eligibility and explainable deterministic scores                    | API typecheck; 33 focused engine tests                   |
| d7a877a57c04f50c30f2da97eaf36aa038ea041f | Transactional recommendation API, audit and no-candidate manual behavior | API typecheck; 62 focused engine/real-MongoDB HTTP tests |

The final documentation/review-indicator commit and non-fast-forward merge are recorded by the included Git history and ZIP handoff. No commit timestamps/authors were fabricated or rewritten. Commit identity remains `Codex Implementation Agent <codex@local.invalid>`; there is no GitHub remote and nothing was pushed online.

## Verification

Verified on Node v24.19.0, npm 11.9.0, Git 2.51.1.

| Command/check                                                                                  | Actual result                                                                                             |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| API typecheck plus focused engine suite                                                        | Passed; 33 tests                                                                                          |
| API typecheck plus engine/recommendation integration suites                                    | Passed; 62 tests (33 + 29)                                                                                |
| First `npm run check`                                                                          | Stopped at Prettier mismatch in the new integration test; corrected                                       |
| Final `npm run check`                                                                          | Exit 0: formatting, both TypeScript checks, 377 API tests in 13 files, 1 web test, both production builds |
| Compiled `apps/api/dist/server.js` in a separate Node process against a fresh real replica set | Passed; details below                                                                                     |
| `git diff --check` and local Markdown target validation                                        | Passed                                                                                                    |
| Docker availability probe                                                                      | Docker absent; compose remains unverified                                                                 |

Compiled-process smoke: readiness 200; rider/job creates 201; recommendation on NEW rejected 409; ready HIGH job ranked its rider at cost 40; offline exclusion returned UNAVAILABLE; no candidates moved the job to MANUAL_QUEUE with one entry event. Repeated evaluation retained manual reason/version; restoring the rider returned one candidate while preserving manual status. Seven stored events retained the original score; no assignment existed and both rider counters stayed zero. Manual status filtering returned one job. SIGTERM shutdown exited 0. This check used temporary fixture-owned MongoDB, not a configured user database.

Total: **378 passing tests**, including 62 new recommendation checks. No claim of full end-to-end delivery or browser verification is made.

Focused engine tests: 33. New real-MongoDB/Supertest checks: 29. They exercise a public HTTP create/ready/recommend/history workflow, both-zone/availability/capacity exclusions, historical snapshot preservation, corrupt counters, late deadlines, no candidates, existing manual reasons, recovery, strict inputs, illegal states, readiness, audit rollback and uncertain commits. Eight concurrent requests create eight evaluation events and exactly one manual-entry event with contiguous sequence numbers. A deterministic gate pauses audit sequence allocation while a direct cancellation fixture commits; the real transaction retry rejects the now-invalid evaluation. This fixture does not implement the future cancellation API.

The first full check stopped at a formatting mismatch in one test expression. Prettier corrected it; no functional test was reported as passing by that failed run. Final results follow in the verification record above. No database tests were skipped or replaced with an emulated database. The harness downloaded and launched actual MongoDB 8.0.17.

## Files

The repository contains **86 tracked files** at this checkpoint. Seven files are new in this phase; existing files are updated as described below.

New files: recommendations/engine.ts, engine.test.ts, service.ts, router.ts; test/integration/recommendations.test.ts; docs/recommendation-api.md; this report. Updated startup/app wiring, module/test notes, phase indicator/test, README, traceability, architecture, lifecycle, API contract, delivery plan and engineering notes. See the actual diff with `git diff --stat 1249c29..HEAD`.

## Limits and next feature

No assignment/reservation or override API, rider response/timeout worker, delivery/cancellation API, dedicated manual-queue/reassignment API, public seed command, operational dashboard or final presentation yet. The existing job filter lists manual jobs. Docker/compose execution and a browser visual walkthrough remain unverified; Docker is unavailable here. The compiled-server and real-MongoDB checks are separate from Docker verification. Authentication, reconciliation and production high availability remain documented limitations.

Next: Phase 6, `feat/assignment-reservation`: atomic eligibility/capacity reservation, one active attempt, job linkage, manual override reasons, durable assignment replay and concurrent-dispatch tests. Stop after this Phase 5 checkpoint for review.
