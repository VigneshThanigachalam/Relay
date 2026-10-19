# Rider responses and automatic expiry — Phase 7

Implemented: rider acceptance/rejection, atomic timeout resolution and an in-process persisted-deadline worker. Create an assignment first using assignment-api.md. The React screen remains a phase indicator. Pickup/delivery/cancellation remain Phase 9; dedicated manual queue summaries are now available in [manual-queue-api.md](manual-queue-api.md).

## HTTP contract

| Method/path                                   | Body                                  | Success                                                   |
| --------------------------------------------- | ------------------------------------- | --------------------------------------------------------- |
| POST /api/v1/assignments/:assignmentId/accept | `{}`                                  | 200 accepted job/attempt or exact outcome replay          |
| POST /api/v1/assignments/:assignmentId/reject | `{"reason":"Cannot take this route"}` | 200 manual job/rejected attempt or matching reason replay |

Both routes require X-Actor-Id (trimmed, 1–80 characters), Content-Type: application/json, a 24-character ObjectId and no query parameters. Reason is trimmed, nonblank and at most 500 characters. Unknown fields are rejected. Actor attribution is simulated, not authenticated. No Idempotency-Key is required: stored attempt outcome controls replay. Responses use `{data:{job,assignment},replayed:boolean}` and the same safe DTO fields as assignment-api.md; keys/hashes stay private. Request IDs and shared safe error envelopes remain unchanged.

| Status/code                | Meaning                                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 400 VALIDATION_ERROR       | Bad ID/actor/body/query or invalid reason                                                                       |
| 404 ASSIGNMENT_NOT_FOUND   | No attempt with that ID                                                                                         |
| 409 ASSIGNMENT_CONFLICT    | Opposing outcome, changed rejection reason, stale pending ID, mismatched job pointers or missing referenced job |
| 409 ASSIGNMENT_EXPIRED     | Expired attempt, including expiry committed by this late response; refresh the job                              |
| 409 WORKLOAD_CONFLICT      | Missing/inconsistent rider workload prevented release; the entire outcome rolls back                            |
| 503 DEPENDENCY_UNAVAILABLE | Database/retry failure or unresolved commit; retry the same action/reason                                       |
| 500 INTERNAL_ERROR         | Unexpected storage/audit failure, with no database details exposed                                              |

Malformed JSON/body limits use the shared 400/413 errors. Invalid response requests/conflicts do not create fabricated response events. ASSIGNMENT_FAILED remains specific to rejected assignment-creation commands.

## Outcomes, capacity and replay

Timely acceptance requires the exact current PENDING/active attempt, matching rider/job pointers and AWAITING_CONFIRMATION job. It changes the job/attempt to ACCEPTED, sets respondedAt and appends ASSIGNMENT_ACCEPTED with actor/time. It preserves capacity and pointers. Offline status after assignment does not block the rider's existing commitment. Repeating an accepted decision returns 200 replay without a new event; an opposing rejection returns 409.

Timely rejection changes the attempt to REJECTED/inactive, sets respondedAt/endedAt/reservationReleasedAt and stores the reason. The job becomes MANUAL_QUEUE/RIDER_REJECTED with empty active pointers. It releases exactly that attempt's original load and one active-job slot, then records ASSIGNMENT_REJECTED and MANUAL_QUEUE_ENTERED atomically. A matching trimmed reason replays; a changed reason/opposing acceptance conflicts. Retrying an old rejected ID after reassignment returns its original outcome/current job without touching the new attempt.

Expiry performs the same guarded release/manual transition with EXPIRED, RESPONSE_TIMEOUT, no respondedAt, and ASSIGNMENT_EXPIRED plus MANUAL_QUEUE_ENTERED. Automatic events use system:timeout-worker. If a late accept/reject triggers expiry before the worker, its actor is recorded and the API returns 409 only **after** that expiry transaction commits. Repeating expired response IDs returns 409 without another decrement/event.

The winning transition, release marker, job change, rider decrement and events share one transaction. Only PENDING/active/unreleased attempts can win. The release helper validates current and resulting local counters and uses a guarded increment; it never clamps or repairs corruption. Stored original load is used. Other active reservations remain occupied. An audit failure rolls everything back, including the first event if the second fails. Accepted work is never expired by the worker. Pickup/delivery/cancellation release behavior remains later work.

Stored outcome controls retries after an uncertain commit response: the original request can return 503, then the same accept/reject retry reads a committed matching decision without another effect. Exact accepted retries recognize matching accepted, picked-up or delivered outcomes. Pickup/delivery routes are implemented and documented in delivery-api.md. A cancelled/opposing attempt does not falsely replay acceptance.

## Deadline and race policy

At each transaction callback attempt, capture a fresh server decision time immediately before guarded state writes. Acceptance/rejection require `expiresAt > decisionTime`; expiry requires `expiresAt <= decisionTime`. Equality expires. This is a decision-time policy, not a claim that commit precedes the wall-clock deadline. A pre-deadline acceptance may commit just after the deadline if it wins; if another write forces retry, the fresh time may instead expire it.

Tests force both real MongoDB transactions to read PENDING and pause before their first writes, then deterministically let each side win. Separate checks prove equality, fresh time after conflict, duplicate responses/scanners, opposing accept/reject and one committed release. There is no process-memory lock or globally exactly-once request claim.

## Worker and restart behavior

After database readiness/index initialization and successful HTTP listening, the worker immediately scans persisted PENDING/active attempts with expiresAt <= now. It orders by expiry/ID using the existing assignment_due_queue index, shortlists at most 100, and resolves each sequentially in its own guarded transaction. It ignores future and accepted work. A fresh process finds overdue work left during downtime; no per-assignment timer is the source of truth and no TTL deletes history.

The next poll is scheduled TIMEOUT_SCAN_INTERVAL_MS **after the preceding scan completes**. This prevents local overlap. Other worker processes/scanners remain safe through database guards. Query failures are safely logged and retried next tick. An individual attempt failure is logged by assignment ID, the rest of its batch continues, and it can retry later. A fixed oldest-first batch is intentionally simple; a sustained full batch of corrupt failures can delay newer overdue work and needs operator repair/monitoring.

| Setting                          | Default             | Demo |
| -------------------------------- | ------------------- | ---- |
| ASSIGNMENT_RESPONSE_THRESHOLD_MS | 7200000 (two hours) | 5000 |
| TIMEOUT_SCAN_INTERVAL_MS         | 5000                | 1000 |

Restart after editing `.env`. Threshold changes affect newly created attempts only; each existing attempt retains its expiresAt. Actual manual movement occurs on the next successful scan, not at an exact timer instant. Batch duration, database retries and outages can increase delay. Database queries have 5-second limits; transaction retry budget is 15 seconds with a 5-second commit limit.

Shutdown stops new HTTP work and polling, checks the stop flag between attempts, waits for the current scan/HTTP work, then closes MongoDB. The process retains its overall 10-second forced-exit budget; if exceeded, persisted deadlines allow a later process to retry unresolved work. Readiness currently reports database readiness, not a worker-lag health metric. Authentication, reconciliation, production high availability and observability remain documented limits.

## Curl demonstration

Create/ready/assign using the assignment guide and copy the returned IDs. Accept promptly before expiry:

```bash
ASSIGNMENT_ID='<returned attempt id>'
JOB_ID='<returned job id>'
RIDER_ID='<returned rider id>'
curl -sS -X POST "http://127.0.0.1:4000/api/v1/assignments/$ASSIGNMENT_ID/accept" \
  -H 'Content-Type: application/json' -H 'X-Actor-Id: rider:demo' -d '{}'
```

Repeat for 200 replay and unchanged workload. Use a **new job/attempt** for rejection:

```bash
curl -sS -X POST "http://127.0.0.1:4000/api/v1/assignments/$ASSIGNMENT_ID/reject" \
  -H 'Content-Type: application/json' -H 'X-Actor-Id: rider:demo' \
  -d '{"reason":"Cannot take this route"}'
curl -sS "http://127.0.0.1:4000/api/v1/jobs/$JOB_ID/history"
curl -sS "http://127.0.0.1:4000/api/v1/riders/$RIDER_ID"
```

For automatic expiry, configure the short demo values and restart, create another job/assignment, then leave it pending for roughly 5–7 seconds while the API runs. Inspect:

```bash
curl -sS "http://127.0.0.1:4000/api/v1/jobs/$JOB_ID"
curl -sS 'http://127.0.0.1:4000/api/v1/jobs?status=MANUAL_QUEUE'
curl -sS "http://127.0.0.1:4000/api/v1/jobs/$JOB_ID/history"
curl -sS "http://127.0.0.1:4000/api/v1/riders/$RIDER_ID"
```

Expect manual reason RESPONSE_TIMEOUT, retained EXPIRED attempt/events and released units. Reassign that same manual job with a **new assignment key**, then accept using the **new attempt ID**. The old ID cannot accept or release the new work. To demonstrate recovery, stop the API while a short-threshold attempt is pending, wait until its persisted expiry, restart and inspect the same records. No manual database edits are needed.
