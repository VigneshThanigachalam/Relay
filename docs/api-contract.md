# API contract and implementation status

Implemented through Phase 9: health, jobs, rider configuration/workload, recommendations, atomic assignment/reservation, acceptance/rejection, automatic expiry and dedicated manual queue investigation. Tested guides: [jobs](job-api.md), [riders](rider-api.md), [recommendations](recommendation-api.md), [assignment](assignment-api.md), [responses/timeouts](response-timeout-api.md), [manual queue](manual-queue-api.md). Pickup, delivery and cancellation are implemented; dashboard remains **proposed**. See [delivery API](delivery-api.md). Reassignment reuses the existing assignment route with a new key.

JSON over HTTP. IDs are MongoDB ObjectId strings; timestamps are UTC ISO 8601. Payloads reject unknown fields. `X-Actor-Id` is required for user-initiated business mutations (1–80 characters); the demo UI will send `dispatcher:demo` or `rider:<id>`. This is simulated attribution, not authentication. Generate one `Idempotency-Key` per assignment user action and reuse on network retries (1–128 characters). Server returns `X-Request-Id` on every response.

Success shape: `{ "data": ... }`; list adds `"pagination": {"page":1,"pageSize":20,"total":42}`. Errors: `{"error":{"code":"VALIDATION_ERROR","message":"Invalid request","details":[{"path":"loadUnits","message":"Expected a positive integer"}]},"requestId":"..."}`. Production errors never return stack traces/credentials.

| Method and path                               | Inputs                                                                     | Success and behavior                                                                                      | Common errors                                                                              |
| --------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| GET /health/live                              | None                                                                       | 200 `{data:{status:"ok"}}`; process only                                                                  | —                                                                                          |
| GET /health/ready                             | None                                                                       | 200 `{data:{status:"ready"}}` if persistence is initialized and connected                                 | 503 DEPENDENCY_UNAVAILABLE                                                                 |
| POST /api/v1/jobs                             | Job payload below; optional Idempotency-Key                                | 201 new NEW job; 200 same reference/key + identical canonical payload, `replayed:true`                    | 400 invalid; 409 DUPLICATE_JOB or IDEMPOTENCY_CONFLICT                                     |
| GET /api/v1/jobs                              | page 1–10000, pageSize 1–100 (default 20), orderReference?, status?, zone? | 200 list, createdAt + _id ascending; reference exact after normalization; zone matches pickup OR delivery | 400 invalid filter                                                                         |
| GET /api/v1/jobs/:jobId                       | ID                                                                         | 200 job DTO incl current rider, manual reason                                                             | 400 bad ID; 404 JOB_NOT_FOUND                                                              |
| POST /api/v1/jobs/:jobId/ready                | `{}`                                                                       | 200 ready job (NEW only; ready replay returns current)                                                    | 409 INVALID_TRANSITION                                                                     |
| GET /api/v1/jobs/:jobId/history               | page/pageSize                                                              | 200 `{data:{events,attempts},pagination,attemptsPagination}`; both arrays bounded                         | 404 missing job                                                                            |
| GET /api/v1/riders                            | code?, availability?, zone?, page/pageSize                                 | 200 rider DTOs incl total/reserved/free units and active count                                            | 400 filters                                                                                |
| GET /api/v1/riders/:riderId                   | ID                                                                         | 200 rider details and paginated active assignments                                                        | 404 RIDER_NOT_FOUND                                                                        |
| POST /api/v1/riders                           | Rider payload below                                                        | 201 rider with zero counters                                                                              | 400 invalid; 409 DUPLICATE_RIDER                                                           |
| PATCH /api/v1/riders/:riderId                 | name?, serviceZones?, currentZone?, availability?, capacityUnits?          | 200 updated rider; counters never user-writable                                                           | 409 CAPACITY_CONFLICT, ACTIVE_ZONE_CONFLICT or WORKLOAD_CONFLICT                           |
| POST /api/v1/jobs/:jobId/recommendations      | `{}`                                                                       | 200 ranked eligible/excluded candidates; snapshot audit; no eligible moves ready job into manual          | 409 INVALID_TRANSITION                                                                     |
| POST /api/v1/jobs/:jobId/assignments          | `{riderId,overrideReason?}`; required Idempotency-Key                      | 201 attempt + job; 200 replay; same route reassigns MANUAL job                                            | 409 JOB_ALREADY_ASSIGNED, RIDER_INELIGIBLE, OVERRIDE_REASON_REQUIRED, IDEMPOTENCY_CONFLICT |
| POST /api/v1/assignments/:assignmentId/accept | `{}`                                                                       | 200 accepted job/attempt or exact decision replay                                                         | 404 missing; 409 ASSIGNMENT_EXPIRED or ASSIGNMENT_CONFLICT                                 |
| POST /api/v1/assignments/:assignmentId/reject | `{reason}`                                                                 | 200 manual job + rejected attempt; exact decision replay                                                  | 400 missing reason; 409 expired/opposite/stale attempt                                     |
| POST /api/v1/jobs/:jobId/pickup               | `{assignmentId}`                                                           | 200 picked-up job/attempt                                                                                 | 409 INVALID_TRANSITION or ASSIGNMENT_CONFLICT                                              |
| POST /api/v1/jobs/:jobId/deliver              | `{assignmentId}`                                                           | 200 delivered job/attempt; exact repeat no second release                                                 | 409 INVALID_TRANSITION or ASSIGNMENT_CONFLICT                                              |
| POST /api/v1/jobs/:jobId/cancel               | `{reason}`                                                                 | 200 cancelled job; reason required                                                                        | 409 INVALID_TRANSITION after pickup/delivery                                               |
| GET /api/v1/manual-queue                      | zone?, page/pageSize                                                       | 200 MANUAL jobs with audit-entry age, compact latest attempt/failure, asOf and pagination                 | 400 filters                                                                                |
| GET /api/v1/dashboard                         | zone?                                                                      | 200 counts for every status, total and attention summaries                                                | 400 filters                                                                                |

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

## Implemented creation replay policy

The canonical hash includes normalized reference/zones, numeric load, explicit/default priority and normalized deadline (or null). Actor and key are not payload fields. A job captures at most one optional creation key on its first successful write. A retry reuses that key or omits it for exact-reference replay. Supplying a different/new key for an existing job returns 409 IDEMPOTENCY_CONFLICT; it is never accepted without a durable binding. Reusing a bound key with changed payload/reference also conflicts. Repeated references with different delivery details return 409 DUPLICATE_JOB. Lookup occurs before the new-job future-deadline check, so a successful request remains replayable after its deadline passes. Replays return the current job and never restore NEW.

Ready commands return `{data:job,replayed:boolean}`. Only NEW can transition; repeating while already READY returns a harmless replay. Later states return 409. Lists and history use snapshot reads for consistent totals/data within a response; between requests queues can change. See job-api.md for actual examples and test-backed limitations.

## Implemented rider configuration policy

Rider codes are normalized, unique and immutable. Repeated creates return 409 DUPLICATE_RIDER, not job-style replay; an uncertain committed create can be recovered by exact-code lookup. Create/PATCH require an actor, stored as createdBy/updatedBy provenance. These fields are nullable on legacy/test records and do not constitute an append-only configuration log.

PATCH writes only editable fields and server provenance/time, never workload counters. Capacity may equal but not fall below reserved load. Service-zone removal is conservatively blocked while activeJobCount > 0; additions are allowed. Going UNAVAILABLE preserves pending/accepted/picked-up attempts and counters. Transaction conflicts rerun the checks on fresh state. List/detail use snapshot reads and bounded pagination; detail pagination applies to active assignments. Free capacity is a physical quantity even if a rider is offline; actual per-job eligibility is now available through the recommendation endpoint.

## Implemented recommendation policy

POST recommendations requires actor, explicit JSON `{}` and no query parameters. Only READY/MANUAL is legal. It returns the v1 snapshot plus jobStatus and appends RIDERS_RECOMMENDED; no candidates moves READY to MANUAL with a second event atomically. Already-manual reevaluation preserves reason/version. It reserves nothing and has no idempotency-key replay contract; retries evaluate again. See recommendation-api.md for the exact matrix, formula, exclusion reasons, rounding, concurrency semantics and curl examples.

## Implemented assignment policy

POST assignments requires actor and Idempotency-Key, strict riderId/optional reason body and no query parameters. Success is `{data:{job,assignment},replayed:false}` with 201, or 200 with replayed:true. Recompute scoring in the transaction; only eligible riders can be reserved, and selecting a non-top rider requires a reason. Job state/pointers, rider counters, new PENDING attempt and events commit together. A matching successful key returns the original attempt/current job before state checks; changed payload conflicts. Known-job business failures get ASSIGNMENT_FAILED separately after rollback; uncertain outcomes are reconciled by receipt or return 503. See assignment-api.md for errors, concurrency/retry semantics and curl examples. Stored expiry is configurable now; expiry/response processing is now implemented in Phase 7.

## Implemented rider response/timeout policy

POST accept requires `{}`; reject requires a trimmed nonblank reason up to 500 characters. Both require actor and exact attempt ID, no query fields. Timely accept preserves reservation; reject/expiry release the stored load once and atomically enter manual with retained events/attempt. Stored matching outcomes replay without another effect; opposing decisions/stale IDs conflict. Late responses expire first, then return 409 after commit. The worker scans immediately at startup and sequentially processes at most 100 persisted due attempts, with the next interval after scan completion. See response-timeout-api.md for boundary/race semantics, error codes, shutdown and a public-API restart demo.

## Implemented manual queue policy

GET manual-queue accepts only normalized zone and shared page/pageSize bounds. It returns oldest received MANUAL jobs with audit-based manual entry time/age, assigning/entry actors, compact latest attempt and latest failed-command evidence; full snapshots remain in history. Missing/mismatched manual-entry evidence is flagged and no age is invented. Count/page/summaries share a snapshot transaction. GET is read-only; reassignment uses the existing guarded assignment route/new key and removes committed work from the queue. See manual-queue-api.md for exact response, ordering, scaling limits and reviewer commands.
