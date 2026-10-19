# Rider recommendation API — Phase 5

Implemented: `POST /api/v1/jobs/:jobId/recommendations`. It evaluates an existing READY_FOR_ASSIGNMENT or MANUAL_QUEUE job, records the result, and returns ranked eligible riders plus excluded riders and their reasons. It never creates an assignment or reserves capacity. Assignment/reservation is Phase 6.

Send `X-Actor-Id` (trimmed, 1–80 characters), JSON body `{}`, and no query parameters. A valid 24-character ObjectId is required. Success is 200, including an empty fleet/no candidates. A missing job returns 404 JOB_NOT_FOUND; any other job state returns 409 INVALID_TRANSITION. Invalid actor/body/ID/query returns 400 VALIDATION_ERROR. Database failures may return 503 DEPENDENCY_UNAVAILABLE; unexpected errors return a safe 500. Responses include X-Request-Id and Cache-Control: no-store.

## Eligibility

All conditions are mandatory: AVAILABLE, supports both pickup and delivery zones, and `capacityUnits - reservedUnits >= job.loadUnits`. Current location can be outside supported coverage. Exact capacity equality is allowed. Pending, accepted and picked-up work is already represented in reservedUnits/activeJobCount; this endpoint does not release it.

Excluded entries list all applicable reasons: UNAVAILABLE, UNSUPPORTED_PICKUP_ZONE, UNSUPPORTED_DELIVERY_ZONE, INSUFFICIENT_CAPACITY. Invalid local counters produce INVALID_WORKLOAD_COUNTERS and exclusion, rather than clamping/repairing data or failing every healthy candidate. Capacity arithmetic is not used as an eligibility gate for corrupt counters. Other applicable availability/zone reasons are still returned. Counter-to-attempt reconciliation remains future operational work.

## Scoring version v1

Lower cost ranks first. Estimated duration includes travel to pickup, pickup to delivery, and 5 minutes for each active job. These are synthetic travel/workload estimates, not a delivery SLA or route optimization.

| From / to (minutes) | CENTRAL | NORTH | SOUTH | EAST | WEST |
| ------------------- | ------- | ----- | ----- | ---- | ---- |
| CENTRAL             | 0       | 20    | 20    | 15   | 15   |
| NORTH               | 20      | 0     | 40    | 30   | 30   |
| SOUTH               | 20      | 40    | 0     | 30   | 30   |
| EAST                | 15      | 30    | 30    | 0    | 30   |
| WEST                | 15      | 30    | 30    | 30   | 0    |

The checked-in matrix covers all 25 pairs. Each missing, negative or nonfinite leg uses 60 minutes and sets estimatedByFallback=true; an explanation flags that fallback. No production configuration API changes this matrix. The fallback is exercised through injected partial matrices in pure tests.

- `estimatedMinutes = toPickup + toDelivery + 5 * activeJobCount`.
- `travelCost = estimatedMinutes * priorityWeight`; LOW=1, NORMAL=1.5, HIGH=2, URGENT=3.
- `workloadCost = 20 * reservedUnits / capacityUnits + 5 * activeJobCount`.
- `deadlineCost = 4 * max(0, estimatedMinutes - minutesUntilDeadline)`, or zero without a deadline.
- `totalCost = travelCost + workloadCost + deadlineCost`.

Components are rounded to six decimal places before summing; the total is rounded again. Sort by stored total, then normalized rider code in binary ascending order, then rider ID. Ranks start at 1 without gaps. Exclusions use the same code/ID order. Priority increases the importance of time relative to workload. An overdue deadline adds cost but never prevents dispatch. The time is captured afresh within each transaction attempt.

Example: a NORMAL job from CENTRAL to NORTH, rider at CENTRAL, capacity 5, reserved 2 and one active job: estimatedMinutes=25; travelCost=37.5; workloadCost=13; deadlineCost=0 without a deadline; totalCost=50.5. A HIGH job with an idle rider at CENTRAL costs 40 for its 20-minute estimate.

## Response and history

```json
{
  "data": {
    "scoringVersion": "v1",
    "generatedAt": "2030-01-01T09:00:00.000Z",
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
    "excluded": [],
    "jobStatus": "READY_FOR_ASSIGNMENT"
  }
}
```

Each evaluation appends RIDERS_RECOMMENDED with `details.snapshot`, containing exactly scoringVersion/generatedAt/eligible/excluded. IDs map to rider detail/list APIs for current names and codes. Historical scores/reasons remain stored after rider edits. This phase does not snapshot names/codes. The returned jobStatus is the committed state for this evaluation; another request can change it afterward.

If a READY job has no eligible riders, the same transaction changes it to MANUAL_QUEUE, sets NO_ELIGIBLE_RIDER, increments its state version, and appends MANUAL_QUEUE_ENTERED after RIDERS_RECOMMENDED. It remains unassigned and appears in `GET /api/v1/jobs?status=MANUAL_QUEUE`. If already manual, another evaluation preserves its original reason/version and adds only a recommendation event. Finding a rider later keeps the job manual until an explicit assignment command (Phase 6).

The job and all riders are read in one snapshot transaction. Job sequence allocation writes the job document; a concurrent job state change causes retry and a fresh state check. Recommendations do not lock rider documents: a rider may go offline or become full immediately after the read. The future assignment service must recompute and atomically guard eligibility/capacity. An eight-request race and a controlled cancellation-write fixture verify job-side conflict behavior, not an implemented assignment/cancellation API.

This endpoint evaluates anew on every invocation; Idempotency-Key is not supported as a replay contract. A lost/ambiguous commit response returns 503; a retry may add another recommendation event, while the manual transition occurs once. Recommendation audit entries document evaluations, not reservations. An audit insert failure rolls back the state, event counter and every event in that transaction.

## Curl walkthrough

Start MongoDB and the API as in README. These commands create reviewer data through public APIs. Use new reference/code values on a repeated demonstration, or follow job replay/rider duplicate rules in their guides. Copy each returned `data.id` into the variables. The commands work in Bash/Git Bash/WSL.

```bash
curl -sS -X POST http://127.0.0.1:4000/api/v1/riders \
  -H 'Content-Type: application/json' -H 'X-Actor-Id: dispatcher:demo' \
  -d '{"code":"REC-R001","name":"Arun","serviceZones":["CENTRAL","NORTH"],"currentZone":"CENTRAL","capacityUnits":5}'

curl -sS -X POST http://127.0.0.1:4000/api/v1/jobs \
  -H 'Content-Type: application/json' -H 'X-Actor-Id: dispatcher:demo' \
  -d '{"orderReference":"REC-J001","pickupZone":"CENTRAL","deliveryZone":"NORTH","loadUnits":2,"priority":"HIGH"}'

JOB_ID='<returned job id>'
RIDER_ID='<returned rider id>'
curl -sS -X POST "http://127.0.0.1:4000/api/v1/jobs/$JOB_ID/ready" \
  -H 'Content-Type: application/json' -H 'X-Actor-Id: dispatcher:demo' -d '{}'
curl -sS -X POST "http://127.0.0.1:4000/api/v1/jobs/$JOB_ID/recommendations" \
  -H 'Content-Type: application/json' -H 'X-Actor-Id: dispatcher:demo' -d '{}'
```

Expect Arun to be eligible at cost 40. Other riders already in your database are evaluated too. To demonstrate no candidates in a shared fleet, create a job requiring more units than every rider can provide. In a fresh database with only this rider, offline is sufficient:

```bash
curl -sS -X PATCH "http://127.0.0.1:4000/api/v1/riders/$RIDER_ID" \
  -H 'Content-Type: application/json' -H 'X-Actor-Id: dispatcher:demo' \
  -d '{"availability":"UNAVAILABLE"}'
curl -sS -X POST "http://127.0.0.1:4000/api/v1/jobs/$JOB_ID/recommendations" \
  -H 'Content-Type: application/json' -H 'X-Actor-Id: dispatcher:demo' -d '{}'
curl -sS 'http://127.0.0.1:4000/api/v1/jobs?status=MANUAL_QUEUE'
curl -sS "http://127.0.0.1:4000/api/v1/jobs/$JOB_ID/history"
```

Expect UNAVAILABLE exclusion, manual status/reason and retained recommendation history. No assignment/reservation exists in Phase 5. The UI remains a foundation screen. Full fleet reads, response arrays and audit snapshots are intentionally unpaginated for this small operation; a large fleet needs bounded/indexed shortlists, exclusion summaries and snapshot retention planning. Queries have 5-second limits and transactions a 15-second retry budget, but the response has no explicit rider-count cap.
