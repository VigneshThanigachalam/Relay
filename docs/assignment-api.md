# Assignment and reservation API — Phase 6

Implemented: `POST /api/v1/jobs/:jobId/assignments`. Assign a selected eligible rider to a READY_FOR_ASSIGNMENT or MANUAL_QUEUE job. It reserves load, creates a PENDING attempt, links the job, stores the current scoring snapshot and appends events atomically. Phase 7 now implements [rider responses and automatic expiry/release](response-timeout-api.md). The React screen remains a phase indicator.

## Request and responses

Required headers: Content-Type: application/json, X-Actor-Id (trimmed, 1–80 characters), Idempotency-Key (trimmed, 1–128 characters). Use one fresh key per intended assignment action and reuse that same key and payload for retries. Keys are scoped to a job. Actor headers simulate attribution, not authentication.

```json
{
  "riderId": "507f191e810c19729de860ea",
  "overrideReason": "Optional operational reason"
}
```

Body accepts only riderId and optional overrideReason. IDs must be 24-character ObjectId strings; rider ID case is canonicalized before hashing. Provided reasons are trimmed, nonblank and at most 500 characters. Query parameters are forbidden. A client cannot supply load, state, deadline, counters, actor or scoring snapshot. Job load and process configuration supply reservation/expiry.

New success returns 201; exact successful command replay returns 200:

```json
{
  "data": {
    "job": {
      "id": "507f1f77bcf86cd799439011",
      "orderReference": "RELAY-1001",
      "pickupZone": "CENTRAL",
      "deliveryZone": "NORTH",
      "loadUnits": 2,
      "priority": "HIGH",
      "deadlineAt": null,
      "status": "AWAITING_CONFIRMATION",
      "activeAssignmentId": "507f1f77bcf86cd799439012",
      "assignedRiderId": "507f191e810c19729de860ea",
      "manualReason": null,
      "version": 2,
      "createdAt": "2030-01-01T09:00:00.000Z",
      "updatedAt": "2030-01-01T09:01:00.000Z"
    },
    "assignment": {
      "id": "507f1f77bcf86cd799439012",
      "jobId": "507f1f77bcf86cd799439011",
      "riderId": "507f191e810c19729de860ea",
      "status": "PENDING",
      "active": true,
      "loadUnits": 2,
      "assignedAt": "2030-01-01T09:01:00.000Z",
      "expiresAt": "2030-01-01T11:01:00.000Z",
      "respondedAt": null,
      "endedAt": null,
      "reservationReleasedAt": null,
      "overrideReason": null,
      "endReason": null,
      "actor": "dispatcher:demo",
      "recommendationSnapshot": {
        "scoringVersion": "v1",
        "generatedAt": "2030-01-01T09:01:00.000Z",
        "eligible": [
          {
            "riderId": "507f191e810c19729de860ea",
            "rank": 1,
            "totalCost": 40,
            "estimatedMinutes": 20,
            "availableUnits": 5,
            "activeJobCount": 0,
            "breakdown": { "travelCost": 40, "workloadCost": 0, "deadlineCost": 0 },
            "reasons": [
              "AVAILABLE; supports both zones",
              "5 free units for 2 required units",
              "20 simulated minutes including 0 workload minutes",
              "HIGH travel weight 2; 0 active jobs",
              "No delivery deadline"
            ],
            "estimatedByFallback": false
          }
        ],
        "excluded": []
      }
    }
  },
  "replayed": false
}
```

The stored snapshot contains every evaluated rider and the chosen rider among eligible candidates. Its v1 formula is documented in recommendation-api.md. Assignment request key/hash and job creation hashes/keys are private and absent from DTOs. Read current workload through the rider API and retained attempts/events through job history.

| Status / code                | Meaning                                                                                                                             |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 400 VALIDATION_ERROR         | Malformed ID/body/header/query, missing key/actor, blank reason or unknown field                                                    |
| 404 JOB_NOT_FOUND            | No job; no false job history is created                                                                                             |
| 404 RIDER_NOT_FOUND          | Job exists but rider does not; failure event is recorded                                                                            |
| 409 INVALID_TRANSITION       | Job is NEW, DELIVERED or CANCELLED                                                                                                  |
| 409 JOB_ALREADY_ASSIGNED     | Current job/active attempt already occupies work; use the original key for replay                                                   |
| 409 RIDER_INELIGIBLE         | Unavailable, lacks coverage, insufficient free units, invalid counters or guarded reservation could not match; reasons are returned |
| 409 OVERRIDE_REASON_REQUIRED | Selection differs from current rank 1 and no reason was supplied                                                                    |
| 409 IDEMPOTENCY_CONFLICT     | Successful key reused for a different rider/reason                                                                                  |
| 409 STATE_CONFLICT           | Stored job state/version/pointers do not match the guarded update                                                                   |
| 503 DEPENDENCY_UNAVAILABLE   | Database/retry budget exhausted, outcome unresolved, or failure history could not be confirmed                                      |
| 500 INTERNAL_ERROR           | Unexpected failure; no internal database details exposed                                                                            |

Malformed JSON/oversized payloads use the shared 400/413 envelope. Every response has X-Request-Id and Cache-Control: no-store.

## Eligibility and override policy

Recompute scoring v1 inside the assignment transaction using current snapshot data, even if the dispatcher previously opened recommendations. The chosen rider must be AVAILABLE, support both zones and have remaining capacity >= job load. Invalid counters are excluded. A valid operational reason cannot bypass these gates.

Selecting a non-top candidate requires a reason and appends MANUAL_OVERRIDE with actor, reason, recommended/chosen IDs and scoring version. Supplying a reason for the top candidate stores the note on the attempt but does not fabricate an override event. A stale previously-top choice can now require a reason. Ranking represents the transaction's fleet snapshot; unrelated riders can change after that read. Capacity/eligibility are guarded on the selected rider's actual write.

## Atomicity and replay

The transaction checks a durable receipt before checking current state/eligibility. A matching key/hash returns the original attempt and current job. It does not reopen a completed/failed attempt or reserve again. The hash covers canonical riderId and reason/null, independent of actor and request-field order. The first successful actor is retained. Changed actor on a retry cannot rewrite provenance. Rejected commands do not bind a receipt, so an operator can correct a missing reason or unavailable choice under the same key.

The new-assignment transaction validates job state and absence of active work, reads/scores the fleet, guards the job's status/version/empty pointers, increments the selected rider only when availability, both zones and `$expr` free units permit it, inserts an immutable load/expiry/key/hash/snapshot attempt, and appends events. Counter snapshot predicates and writes to the same rider resolve competing capacity/configuration changes through driver retry. Existing unique indexes protect one active attempt per job and one receipt per job/key. Job and rider counters/state/attempt/events all roll back if any required insert fails. A snapshot-only capacity precheck would not provide this protection.

expiresAt = assignedAt + ASSIGNMENT_RESPONSE_THRESHOLD_MS, default 7,200,000 ms. Restarting with another validated threshold affects future attempts only. Each transaction retry captures a fresh decision time. The existing transaction helper bounds retries at 15 seconds, with a 5-second commit limit; queries have 5-second limits. These database budgets are separate from the rider response threshold.

On an unknown commit result or recognized assignment-index collision, recovery reads the durable receipt in a new snapshot transaction after the original ends. A match returns 200 replay. An unresolved outcome returns 503 and must be retried with the same key/payload. Audit-index errors are not classified as successful assignment collisions. No unknown outcome is falsely audited as a definite failure.

## Operational history and manual jobs

Successful assignment records RIDERS_RECOMMENDED and ASSIGNMENT_CREATED with the actual snapshot/attempt ID. MANUAL_OVERRIDE is added when applicable. A job with any older terminal attempt also gets REASSIGNED linking old/new IDs. Previous attempts are retained. Manual reason is cleared on assignment; state version increments once. A manual job with no previous attempt does not get a reassignment event.

A rejected, validated known-job command records ASSIGNMENT_FAILED in a separate transaction after reservation rollback. Details include error code, operational reason (including hard eligibility reasons) and chosen rider ID; actor/time/sequence are retained. These records appear in history as events, not fabricated reservation attempts. Malformed requests/missing jobs do not invent history. Internal/ambiguous infrastructure errors are not reported as definite business failures. If failure auditing cannot be confirmed, the API returns 503. Repeating a rejected request may add another failure event; rejected keys are not deduplicated. A process crash between rollback and failure-audit commit can omit that rejection record unless the caller retries. A normal 404/409 business rejection is returned only after its required failure audit commits.

A failed direct assignment leaves the job's state unchanged. Evaluate recommendations to use the no-candidate automatic manual-entry policy. Phase 7 now verifies the real reject/expire → reassign flow. Phase 8 adds [dedicated manual queue summaries](manual-queue-api.md); current manual assignment and historical receipt checks retain their fixture and public-API coverage.

## Curl walkthrough

Start a replica set and API using README. Follow the recommendation guide to create rider/job, mark ready and copy returned IDs. For this example the selected rider must currently be rank 1; otherwise provide an operational reason.

```bash
JOB_ID='<returned job id>'
RIDER_ID='<returned rider id>'
ASSIGNMENT_KEY='review-assignment-001'

curl -sS -X POST "http://127.0.0.1:4000/api/v1/jobs/$JOB_ID/assignments" \
  -H 'Content-Type: application/json' -H 'X-Actor-Id: dispatcher:demo' \
  -H "Idempotency-Key: $ASSIGNMENT_KEY" \
  -d "{\"riderId\":\"$RIDER_ID\"}"

# Repeat the exact command: 200 replay, same attempt and one reservation.
curl -sS -X POST "http://127.0.0.1:4000/api/v1/jobs/$JOB_ID/assignments" \
  -H 'Content-Type: application/json' -H 'X-Actor-Id: dispatcher:demo' \
  -H "Idempotency-Key: $ASSIGNMENT_KEY" \
  -d "{\"riderId\":\"$RIDER_ID\"}"

curl -sS "http://127.0.0.1:4000/api/v1/riders/$RIDER_ID"
curl -sS "http://127.0.0.1:4000/api/v1/jobs/$JOB_ID/history"
```

A new key on the same pending job returns 409 JOB_ALREADY_ASSIGNED and adds a visible failure event. To demonstrate override, create a second eligible rider and another READY job; select the non-top rider with a nonblank reason. Do not reuse a successful key with changed payload. Use the Phase 7 rejection/expiry workflow to release pending work; acceptance preserves capacity. No generic reset endpoint is exposed.

Platform references: [MongoDB atomicity](https://www.mongodb.com/docs/manual/core/write-operations-atomicity/), [transaction stale reads/write conflicts](https://www.mongodb.com/docs/v8.0/core/transactions-production-consideration/), [Mongoose 8 update validators](https://mongoosejs.com/docs/8.x/docs/validation.html#update-validators-only-run-for-some-operations). These explain database mechanics; application policies and test results above are repository-specific.
