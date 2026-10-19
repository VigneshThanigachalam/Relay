# Engineering notes

## Current scope

Phase 2 implements domain status/transition rules, expiry boundaries, rider-counter invariants, Job/Rider/Assignment/JobEvent schemas, named indexes, type-specific audit payload validation, append-only model guards, explicit persistence initialization and a transaction helper. Focused comments explain safety/consistency decisions. Real MongoDB integration checks verify these foundations.

Phase 3 now implements job create/list/detail/ready/history routes, canonical hashing and durable replay, guarded ready updates and transactional audit-sequence allocation. Real HTTP tests cover races, rollback, validation and unknown-commit recovery. Phase 4 adds validated rider create/list/detail/update routes, bounded workload views and protected configuration edits. Phase 5 adds pure eligibility/ranking, simulated travel data, a recommendation API, immutable score snapshots and no-candidate manual transitions. Phase 6 adds atomic assignment/capacity reservation, successful-command replay, overrides and failed-command audit. Phase 7 adds response/rejection/expiry and original-load release transactions plus startup persisted-deadline scanning. Public seeds, dedicated manual summaries, delivery/cancellation, operational dashboard and final one-page presentation remain pending. Transaction infrastructure tests do not prove full dispatch workflows. See the requirements checklist and the phase reports for evidence.

## Assumptions

Load is a positive integer unit, not kilograms or simultaneous delivery slots. A rider's capacity is reserved from pending assignment until a terminal attempt; confirmation keeps it reserved. Active count includes pending/accepted/picked-up. Both pickup and destination require zone coverage. A delivery may have identical pickup/destination zones. Priority/deadline influence ranking but never bypass eligibility. The dispatcher explicitly marks a NEW job ready. Rejection and timeout both enter manual; no-candidate ready jobs enter manual during recommendation evaluation. Cancellation before pickup is allowed with a reason; later cancellation requires a future exception workflow.

Idempotency is a single-operation contract with stored hashes, not a process-memory map. Exact normalized reference search is sufficient; free-text search is optional. Dates are server UTC and displayed in operator locale. There is one operation/fleet and no multitenant isolation. Demo actors are supplied by UI/API; no authentication claim is made. Sample travel times and estimated arrival are illustrative.

## Known limitations and verification gaps

A development-only harness now downloads and starts actual MongoDB 8.0.17 processes, including a single-node replica set. Real index constraints, transaction commit/rollback and refusal of standalone MongoDB are verified. The initial default socket startup failed with an operation-not-permitted error; the TCP-only harness runs successfully without elevated permissions. Docker remains unavailable and the compose recipe remains unexecuted. No browser visual walkthrough or full seeded workflow has been performed. There is no remote Git repository configured.

Schema pre-validation hooks run for document creation/save, not arbitrary query updates. Mongoose guards are not database permissions. Job creation replay and audit-sequence allocation are implemented. Assignment now verifies job/rider existence and protects reservation/replay. Rejection/expiry release now checks current/resulting counters transactionally; delivery/cancellation remains pending. Database-level unique indexes protect the specific uniqueness rules now; concurrent assignment and rejection/expiry release-once are now tested; delivery/cancellation release remains pending.

The test suite needs a first-run binary download (roughly 100 MB) or a configured local test binary. It creates and removes temporary fixture-owned data and never uses a user-configured production URI. No mocked or silently skipped database tests are counted as real integration coverage.

Application append-only audit prevents edits through supported APIs, not a privileged DB administrator. Polling delivers timeout handling on the next successful scan; it is not an exact-time scheduler. A single-node replica set has no redundancy. A simple fleet-wide in-memory sort is appropriate for the assignment; huge fleets need indexed shortlisting and better telemetry. The recommendation fleet sort is implemented; the worker remains planned.

## Three improvements with another week

1. Add authenticated dispatcher/rider roles with authorization, stronger actor provenance and restricted database roles for audit retention.
2. Add monitoring for pending age, worker lag and counter invariant drift, plus a tested reconciliation tool and robust deployment/backup procedures.
3. Improve travel estimates and operational exceptions (post-pickup failure/returns), using observed dispatch outcomes to tune scoring and deadline risk.

## Job API policies and limits

A job stores the optional creation key from its first successful creation. Retries reuse it or omit it for reference-based replay; a newly supplied different key on an existing job conflicts. This avoids a second key-receipt collection while keeping accepted keys durable. Defaults and equivalent timestamp offsets are canonicalized before hashing. Replay checks run before the future-deadline rule and return current state. A ready retry only replays while the job is still READY; it cannot reset assigned or terminal work.

Job list/history reads use snapshot transactions; this is simple and consistent but adds read overhead. Lists use offset pagination capped at page 10000 and size 100; queue membership can change across requests. Events and attempts use the same requested page/size but expose separate totals. Actor headers are simulated identity, not verified authorization. GET requests do not generate audit events. Failed input/replayed requests do not generate duplicate lifecycle events. Fault-injection tests wrap real database operations to test rollback and uncertain replies; they do not claim a real network partition or replica failover was performed.

## Rider configuration policies and verification limits

Unique rider codes are immutable; repeated POSTs conflict rather than overwrite/replay. Create/patch actors are stored as createdBy/updatedBy; this is provenance, not append-only rider configuration history. Legacy/test records may have null provenance. No rider delete endpoint is exposed.

Free capacity is total minus reserved even when offline. Offline only changes willingness to take future work and does not erase reservations. Capacity cannot drop below reserved units. Any existing coverage removal is blocked while active work exists, even if the particular removed zone might not be needed by a current delivery; allowing that finer case can be a later refinement. Added coverage and location/name updates are permitted. Current location can be a known zone outside service coverage.

Controlled concurrency tests pause a real edit after its snapshot read, commit a direct rider-counter fixture write, then resume. MongoDB's transaction retry rechecks the new counters. This verifies configuration safety against that primitive; it is not an end-to-end assignment/reservation API. Active-attempt detail tests use explicit coherent job/attempt fixtures. Counter/attempt reconciliation and authenticated actors remain future work. Corrupt local counters return WORKLOAD_CONFLICT rather than being silently repaired/clamped.

## Recommendation policies and verification limits

Scoring v1 is an explainable heuristic, not route optimization. All 25 simulated travel pairs are checked; missing/invalid legs have a tested 60-minute fallback. Priority/deadline never override hard eligibility. Six-decimal component/total rounding and binary code/ID ties make results deterministic. Durations include a workload estimate; extreme supported counters remain finite but are not realistic delivery promises. Invalid local counters are excluded with a visible reason and not repaired.

Recommendations read a consistent fleet snapshot and audit it, but reserve nothing. Rider edits can immediately invalidate the advice; assignment must recheck later. No candidates atomically enters manual once; reevaluation records another snapshot and preserves an existing manual reason. Lost commit replies may produce another evaluation record on retry, without another manual entry. Rider names/codes are resolved through current rider APIs, while historic numeric scores and reasons remain stored. Full-fleet arrays/snapshots have no rider-count cap; large fleets require bounded shortlists and retention controls. Tests exercise actual MongoDB conflicts with controlled lifecycle writes, not an implemented assignment or cancellation API.

## Assignment policies and verification limits

The selected rider's capacity increment and job/attempt/events share one transaction. Actual public configuration/reservation races now verify both commit orders: edits winning first make assignment recheck eligibility; reservation winning first blocks stale capacity/zone reduction, while offline preserves work. The service assumes valid stored local counters; it does not repair preexisting cross-document drift. The active-attempt index and explicit active-work lookup protect conflicting assignments.

Successful keys are job-scoped and bind canonical rider/reason; actor changes do not rewrite original provenance. Same-key replay returns the original attempt/current job, including a terminal fixture outcome, without reserving again. Rejected commands do not bind keys and can add failure events on each request. Ambiguous outcomes return replay only after receipt recovery, otherwise 503; a failure-audit confirmation problem also returns 503. Fault injection wraps real operations and does not claim an actual network partition/failover.

A non-top choice requires a reason, while a note supplied for the top rider is stored without an override event. Ranking uses the transaction fleet snapshot; unselected riders are not globally locked. Existing full-fleet/snapshot scaling limits remain. Expiry is persisted/configurable now; no automatic expiry, acceptance or release endpoint runs in Phase 6. Controlled terminal fixtures prove replay/reassignment primitives, not the future timeout workflow.

The rollback and failure-history insert are separate transactions. A process crash between them may omit the rejection record unless the caller retries. A returned auditable 404/409 means its failure event committed; inability to confirm that event returns 503. This is an explicit trade-off, not a claim of crash-proof exactly-once failure logging.

## Response/worker policies and verification limits

Acceptance uses server decision time before guarded writes; equality expires. It can commit after the deadline if the pre-deadline decision wins; a transaction retry captures fresh time. A late response commits expiry/release before its HTTP 409. Outcome replay reads original attempt/current job and does not touch a new assignment. Rejection replay requires the same trimmed reason. Resolution errors do not fabricate response events. Unknown commit results return 503 and matching retries read stored outcome.

The worker processes at most 100 persisted due attempts sequentially, schedules after completion, and stops between attempts. Multiple scanners are safe through database guards. Individual corrupt attempts remain pending with an operational failure log, rather than silently losing workload. A full oldest-first batch of persistent failures can delay newer work and needs operator repair/monitoring. Readiness reflects database readiness, not worker lag. Shutdown waits for current work under a 10-second overall budget; recovery uses stored deadlines if the process must exit.

Actual MongoDB tests cover transaction races/rollback; fake timers cover scheduler timing. Acceptance preserves capacity even if the rider went offline. Counter reconciliation is still outside scope. Pickup/delivery/cancellation and their capacity-release races remain later work. UI and browser walkthroughs are still pending.
