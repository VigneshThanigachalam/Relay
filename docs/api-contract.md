# API contract draft

Only `GET /health/live`, `GET /health/ready` and the common error envelope are implemented in Phase 1. All `/api/v1` operations below are proposed. Final documentation must be reconciled with tested routes before submission.

JSON over HTTP. IDs are MongoDB ObjectId strings; timestamps are UTC ISO 8601. Payloads reject unknown fields. `X-Actor-Id` is required for user-initiated business operations (1–80 characters); the demo UI will send `dispatcher:demo` or `rider:<id>`. This is simulated attribution, not authentication. Generate one `Idempotency-Key` per assignment user action and reuse on network retries (1–128 characters). Server returns `X-Request-Id` on every response.

Success shape: `{ "data": ... }`; list adds `"pagination": {"page":1,"pageSize":20,"total":42}`. Errors: `{"error":{"code":"VALIDATION_ERROR","message":"Invalid request","details":[{"path":"loadUnits","message":"Expected a positive integer"}]},"requestId":"..."}`. Production errors never return stack traces/credentials.

| Method and path                               | Inputs                                                                | Success and behavior                                                                                      | Common errors                                                                              |
| --------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| GET /health/live                              | None                                                                  | 200 `{data:{status:"ok"}}`; process only                                                                  | —                                                                                          |
| GET /health/ready                             | None                                                                  | 200 `{data:{status:"ready"}}` if persistence is initialized and connected                                 | 503 DEPENDENCY_UNAVAILABLE                                                                 |
| POST /api/v1/jobs                             | Job payload below; optional Idempotency-Key                           | 201 new NEW job; 200 same reference/key + identical canonical payload, `replayed:true`                    | 400 invalid; 409 DUPLICATE_JOB or IDEMPOTENCY_CONFLICT                                     |
| GET /api/v1/jobs                              | page>=1, pageSize 1–100 (default 20), orderReference?, status?, zone? | 200 list, createdAt + _id ascending; reference exact after normalization; zone matches pickup OR delivery | 400 invalid filter                                                                         |
| GET /api/v1/jobs/:jobId                       | ID                                                                    | 200 job DTO incl current rider, manual reason                                                             | 400 bad ID; 404 JOB_NOT_FOUND                                                              |
| POST /api/v1/jobs/:jobId/ready                | `{}`                                                                  | 200 ready job (NEW only; ready replay returns current)                                                    | 409 INVALID_TRANSITION                                                                     |
| GET /api/v1/jobs/:jobId/history               | page/pageSize                                                         | 200 chronological events by sequence plus retained attempts                                               | 404 missing job                                                                            |
| GET /api/v1/riders                            | availability?, zone?, page/pageSize                                   | 200 rider DTOs incl total/reserved/free units and active count                                            | 400 filters                                                                                |
| GET /api/v1/riders/:riderId                   | ID                                                                    | 200 rider details and active assignments                                                                  | 404 RIDER_NOT_FOUND                                                                        |
| POST /api/v1/riders                           | Rider payload below                                                   | 201 rider with zero counters                                                                              | 400 invalid; 409 DUPLICATE_RIDER                                                           |
| PATCH /api/v1/riders/:riderId                 | name?, zones?, currentZone?, availability?, capacityUnits?            | 200 updated rider; counters never user-writable                                                           | 409 CAPACITY_CONFLICT or ACTIVE_ZONE_CONFLICT                                              |
| POST /api/v1/jobs/:jobId/recommendations      | `{}`                                                                  | 200 ranked eligible/excluded candidates; snapshot audit; no eligible moves ready job into manual          | 409 INVALID_TRANSITION                                                                     |
| POST /api/v1/jobs/:jobId/assignments          | `{riderId,overrideReason?}`; required Idempotency-Key                 | 201 attempt + job; 200 replay; same route reassigns MANUAL job                                            | 409 JOB_ALREADY_ASSIGNED, RIDER_INELIGIBLE, OVERRIDE_REASON_REQUIRED, IDEMPOTENCY_CONFLICT |
| POST /api/v1/assignments/:assignmentId/accept | `{}`                                                                  | 200 accepted job/attempt or exact decision replay                                                         | 404 missing; 409 ASSIGNMENT_EXPIRED or ASSIGNMENT_CONFLICT                                 |
| POST /api/v1/assignments/:assignmentId/reject | `{reason}`                                                            | 200 manual job + rejected attempt; exact decision replay                                                  | 400 missing reason; 409 expired/opposite/stale attempt                                     |
| POST /api/v1/jobs/:jobId/pickup               | `{assignmentId}`                                                      | 200 picked-up job/attempt                                                                                 | 409 INVALID_TRANSITION or ASSIGNMENT_CONFLICT                                              |
| POST /api/v1/jobs/:jobId/deliver              | `{assignmentId}`                                                      | 200 delivered job/attempt; exact repeat no second release                                                 | 409 INVALID_TRANSITION or ASSIGNMENT_CONFLICT                                              |
| POST /api/v1/jobs/:jobId/cancel               | `{reason}`                                                            | 200 cancelled job; reason required                                                                        | 409 INVALID_TRANSITION after pickup/delivery                                               |
| GET /api/v1/manual-queue                      | zone?, page/pageSize                                                  | 200 MANUAL jobs with reason, age and last attempt summary                                                 | 400 filters                                                                                |
| GET /api/v1/dashboard                         | zone?                                                                 | 200 counts for every status, total and attention summaries                                                | 400 filters                                                                                |

All business mutations can also return 503 DEPENDENCY_UNAVAILABLE (database/retry exhaustion); unexpected failures return 500 INTERNAL_ERROR. 400 includes malformed JSON, invalid IDs/parameters and Zod failures. 413 PAYLOAD_TOO_LARGE protects body limits. 404 ROUTE_NOT_FOUND for unknown routes; absent entities use domain-specific 404 codes. State/eligibility races use 409, never a misleading success.

## Example payloads and DTOs

Create a job (`orderReference` normalized to `RELAY-1001`; zones from seeded catalog):

```json
{
  "orderReference": "relay-1001",
  "pickupZone": "CENTRAL",
  "deliveryZone": "NORTH",
  "loadUnits": 2,
  "priority": "HIGH",
  "deadlineAt": "2030-01-01T10:30:00.000Z"
}
```

Deadline optional, must be future at creation; sample timestamp is illustrative. Priority LOW/NORMAL/HIGH/URGENT; default NORMAL. Zones are nonempty known uppercase codes. Load positive integer; no order editing after create in this scope. Server owns status, timestamps, counters and assignment pointers.

```json
{
  "data": {
    "id": "507f1f77bcf86cd799439011",
    "orderReference": "RELAY-1001",
    "pickupZone": "CENTRAL",
    "deliveryZone": "NORTH",
    "loadUnits": 2,
    "priority": "HIGH",
    "status": "NEW",
    "activeAssignmentId": null,
    "assignedRiderId": null,
    "manualReason": null,
    "createdAt": "2030-01-01T09:00:00.000Z",
    "deadlineAt": "2030-01-01T10:30:00.000Z",
    "version": 0
  },
  "replayed": false
}
```

Create rider:

```json
{
  "code": "R-001",
  "name": "Arun",
  "serviceZones": ["CENTRAL", "NORTH"],
  "currentZone": "CENTRAL",
  "availability": "AVAILABLE",
  "capacityUnits": 5
}
```

Availability AVAILABLE/UNAVAILABLE. Capacity positive integer; current zone known. A rider may be located outside supported service zones. An availability change does not reject existing work. Return `reservedUnits`, `availableUnits`, `activeJobCount` as read-only fields.

Recommendation (illustrative scores based on architecture formula):

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
        "reasons": ["Supports both zones", "5 free units", "20 minute simulated estimate"],
        "estimatedByFallback": false
      }
    ],
    "excluded": [{ "riderId": "507f191e810c19729de860eb", "reasons": ["UNAVAILABLE"] }],
    "jobStatus": "READY_FOR_ASSIGNMENT"
  }
}
```

Assign `{"riderId":"507f191e810c19729de860ea"}` with `Idempotency-Key: assignment-demo-1`. Non-top selection adds `overrideReason`. Assignment response includes job DTO and `assignment:{id,jobId,riderId,status:"PENDING",active:true,loadUnits,assignedAt,expiresAt}`. Recheck eligibility and actual ranking at commit time; stale UI is not authority. Assignment creation key/hash is scoped to job; replay returns the original attempt plus current job so a timeout replay cannot resurrect it.

History includes e.g. `{sequence:4,type:"ASSIGNMENT_EXPIRED",occurredAt:"...",actor:"system:timeout-worker",assignmentId:"...",details:{reason:"RESPONSE_TIMEOUT",releasedUnits:2}}`. Failed attempts appear separately in `attempts` even after another attempt succeeds. No event/attempt deletion API.

## Idempotency policy

Canonicalize validated defaults, normalized references/zones and dates before hashing. Same reference/key with identical canonical payload returns the original resource without an extra creation event. Reuse for a different payload returns 409. Assignment successful commands persist key/hash; rejected commands do not reserve keys, so the operator may correct an error. User-initiated accept/reject/pickup/deliver/cancel repeats are guarded by attempt/current outcome, not by a generic catch-all idempotency store. A conflicting outcome never silently replays a different command.
