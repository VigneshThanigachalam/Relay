# Manual queue and reassignment — Phase 8

Implemented: `GET /api/v1/manual-queue`. It returns only MANUAL_QUEUE jobs, with reason, waiting time, last assignment summary and latest rejected assignment-command evidence. Full investigation uses existing job detail/history; recommendations, reassignment and rider responses use their existing guarded endpoints. No second queue collection or duplicate reassignment route is introduced. The operational React interface remains Phase 10; pickup/delivery/cancellation are Phase 9.

## Query and response

Optional query parameters: zone (normalized known zone), page (1–10000, default 1) and pageSize (1–100, default 20). A zone matches pickup **or** delivery. Unknown/repeated/nested fields and invalid bounds return 400 VALIDATION_ERROR. No actor is needed for this read; it creates no audit events. Unready dependencies/query timeouts return the shared safe 503 envelope. X-Request-Id and Cache-Control: no-store remain present.

```json
{
  "data": [
    {
      "id": "507f1f77bcf86cd799439011",
      "orderReference": "RELAY-1001",
      "pickupZone": "CENTRAL",
      "deliveryZone": "NORTH",
      "loadUnits": 2,
      "priority": "NORMAL",
      "deadlineAt": null,
      "status": "MANUAL_QUEUE",
      "activeAssignmentId": null,
      "assignedRiderId": null,
      "manualReason": "RIDER_REJECTED",
      "version": 3,
      "createdAt": "2030-01-01T09:00:00.000Z",
      "updatedAt": "2030-01-01T09:01:00.000Z",
      "manualEnteredAt": "2030-01-01T09:01:00.000Z",
      "manualAgeMs": 60000,
      "manualEntryActor": "rider:demo",
      "historyIncomplete": false,
      "latestAttempt": {
        "id": "507f1f77bcf86cd799439012",
        "jobId": "507f1f77bcf86cd799439011",
        "riderId": "507f191e810c19729de860ea",
        "status": "REJECTED",
        "active": false,
        "loadUnits": 2,
        "assignedAt": "2030-01-01T09:00:30.000Z",
        "expiresAt": "2030-01-01T11:00:30.000Z",
        "respondedAt": "2030-01-01T09:01:00.000Z",
        "endedAt": "2030-01-01T09:01:00.000Z",
        "reservationReleasedAt": "2030-01-01T09:01:00.000Z",
        "overrideReason": null,
        "endReason": "Cannot take this route",
        "actor": "dispatcher:demo"
      },
      "latestAssignmentFailure": null
    }
  ],
  "asOf": "2030-01-01T09:02:00.000Z",
  "pagination": { "page": 1, "pageSize": 20, "total": 1 }
}
```

Empty/out-of-range pages return data=[] with the filtered total and asOf. Sort is **oldest received first**, createdAt then job ID ascending. It is not manual-entry-time order. This reuses existing job queue indexes; no new denormalized timestamp/index is needed.

manualEnteredAt/actor come from the latest MANUAL_QUEUE_ENTERED event by per-job sequence. manualAgeMs is milliseconds from that event to the response's asOf, floored at zero if clocks disagree. It is not total job age or an SLA prediction. A new actual queue entry resets age; GETs, recommendations and failed assignment commands do not. Missing entry history or a reason mismatch gives historyIncomplete=true and null entry time/actor/age, rather than inferring evidence from updatedAt. The job stays visible and storage is not repaired by this read. This flag checks available entry evidence, not complete audit continuity or counter reconciliation.

latestAttempt is ordered by assignedAt then ID descending. It is null if no attempt exists, including first no-candidate jobs and rejected commands that never reserved capacity. Its bounded summary omits recommendationSnapshot and private receipt fields; full snapshots remain in job history. actor is the original assigning actor; response/expiry actor is available in history and manualEntryActor. Latest event order uses the authoritative per-job sequence.

latestAssignmentFailure is null or `{id,sequence,occurredAt,actor,code,reason,riderId}` from the latest ASSIGNMENT_FAILED event. It describes a rejected command, not a fabricated reservation attempt. It is the latest failure across the job's history and may predate its current manual entry. Preserve the timestamp when displaying it; manualReason separately explains why the job is currently queued. The failure can show unavailable/capacity/override/conflict reasons while latestAttempt still describes the previous rejected/expired reservation.

The service reads total, page, relevant events and attempt summaries sequentially in one snapshot transaction. Batched aggregations are scoped to at most 100 page IDs and return one summary per job/type; projections discard scoring snapshots before grouping. There is no query per row. Existing job/event/attempt indexes support these reads. Large per-job histories can still cost work to aggregate; query limits are 5 seconds and the transaction retry budget is 15 seconds. This phase adds no claim of a production benchmark or unbounded scalability.

One response remains internally consistent while another dispatcher reassigns a job. Membership changes between requests, and a queue row is not a capacity reservation. The assignment service rechecks live state/eligibility and handles stale/conflicting actions. Offset pagination can shift as jobs enter/leave the queue.

## Investigation and reassignment

| Operation                                  | Existing endpoint                                                                                        |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Current job fields                         | GET /api/v1/jobs/:id                                                                                     |
| Chronological events and retained attempts | GET /api/v1/jobs/:id/history?page=1&pageSize=20                                                          |
| Fresh ranked eligible riders and reasons   | POST /api/v1/jobs/:id/recommendations with `{}` and actor                                                |
| Assign/reassign                            | POST /api/v1/jobs/:id/assignments with riderId, optional overrideReason, actor and a new Idempotency-Key |
| Rider workload                             | GET /api/v1/riders/:riderId                                                                              |
| Accept/reject new pending work             | POST /api/v1/assignments/:newAttemptId/accept or /reject                                                 |

Use a **new key** for each intended new dispatch attempt. A successful old key replays the old attempt; it cannot create reassignment. Reuse the new action's key/payload on network retries. Selecting a current non-top eligible rider needs a nonblank reason; an override cannot bypass availability, both-zone coverage or free capacity. A rejected command remains visible on the queue and does not consume a key or capacity.

Successful reassignment atomically clears manual reason, creates a new pending attempt, reserves once, and removes the job from the queue. REASSIGNED links old/new attempt IDs when there is previous work. A first no-candidate job has no previous attempt, so its first assignment does not fabricate a reassignment event. Earlier rejected/expired attempts, scores and failures remain inspectable in history. Old IDs cannot accept or release the replacement. Eight competing manual reassignment actions commit one winner; the seven conflicts remain in history.

## Reviewer walkthrough

Follow job-api.md and assignment-api.md to create/ready/assign. Copy IDs and reject pending work before expiry, or configure the short timeout demo from response-timeout-api.md and wait for the worker. All steps use public APIs.

```bash
JOB_ID='<job id>'
OLD_ATTEMPT_ID='<pending attempt id>'
RIDER_ID='<eligible rider id>'
curl -sS -X POST "http://127.0.0.1:4000/api/v1/assignments/$OLD_ATTEMPT_ID/reject" \
  -H 'Content-Type: application/json' -H 'X-Actor-Id: rider:demo' \
  -d '{"reason":"Cannot take this route"}'
curl -sS 'http://127.0.0.1:4000/api/v1/manual-queue?zone=NORTH&pageSize=20'
curl -sS "http://127.0.0.1:4000/api/v1/jobs/$JOB_ID/history"
curl -sS -X POST "http://127.0.0.1:4000/api/v1/jobs/$JOB_ID/recommendations" \
  -H 'Content-Type: application/json' -H 'X-Actor-Id: dispatcher:demo' -d '{}'
curl -sS -X POST "http://127.0.0.1:4000/api/v1/jobs/$JOB_ID/assignments" \
  -H 'Content-Type: application/json' -H 'X-Actor-Id: dispatcher:demo' \
  -H 'Idempotency-Key: manual-action-002' \
  -d "{\"riderId\":\"$RIDER_ID\"}"
```

If choosing a non-top rider, add a reason as in assignment-api.md. Copy the returned new attempt ID:

```bash
NEW_ATTEMPT_ID='<new attempt id>'
curl -sS -X POST "http://127.0.0.1:4000/api/v1/assignments/$NEW_ATTEMPT_ID/accept" \
  -H 'Content-Type: application/json' -H 'X-Actor-Id: rider:demo' -d '{}'
curl -sS 'http://127.0.0.1:4000/api/v1/manual-queue'
curl -sS "http://127.0.0.1:4000/api/v1/jobs/$JOB_ID/history"
curl -sS "http://127.0.0.1:4000/api/v1/riders/$RIDER_ID"
```

Expect the job absent from manual queue, one new active reservation, the earlier failed attempt retained and the replacement ACCEPTED. An old expired/rejected attempt ID cannot accept it. Continue with the pickup/delivery commands in delivery-api.md, or use the complete React workflow in README.md.
