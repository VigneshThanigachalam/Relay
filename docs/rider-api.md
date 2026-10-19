# Implemented rider API

Phase 4 exposes create/list/detail/PATCH under `/api/v1/riders`. Start a real MongoDB replica set and the API using the README. Phase 5 adds the [recommendation endpoint](recommendation-api.md); Phase 6 adds [assignment/reservation](assignment-api.md). The four existing collections are retained.

## Common conventions

Mutations require JSON and `X-Actor-Id` (trimmed, 1–80 characters). The actor is simulated attribution, not authentication. GET needs no actor. Responses carry `X-Request-Id` and safe JSON errors. Unknown body/query fields, repeated query keys and operator-shaped inputs are rejected. The common 64 KiB body limit applies.

A rider DTO includes `id`, `code`, `name`, `serviceZones`, `currentZone`, `availability`, `capacityUnits`, `reservedUnits`, `availableUnits`, `activeJobCount`, creation/update timestamps and `createdBy`/`updatedBy`. It excludes `_id`/Mongoose metadata. Provenance fields show who created/last edited configuration; they are nullable for legacy/test records and are not a full append-only configuration log. Job history remains separate.

## POST riders

```http
POST /api/v1/riders
X-Actor-Id: dispatcher:demo
Content-Type: application/json
```

```json
{
  "code": "r-001",
  "name": "Arun",
  "serviceZones": ["CENTRAL", "NORTH"],
  "currentZone": "CENTRAL",
  "capacityUnits": 5
}
```

Code is trimmed/uppercased, nonempty and at most 40 characters. It is unique and immutable. Name is trimmed/nonempty/max 100 characters. Service zones must be a nonempty unique set drawn from CENTRAL/NORTH/SOUTH/EAST/WEST; entries normalize before duplicate checks and are stored in sorted order. Current zone must be known but can be outside service coverage. Capacity must be a positive safe-integer JSON number. Availability is AVAILABLE/UNAVAILABLE, default AVAILABLE.

The server initializes reservedUnits/activeJobCount to zero and captures actor/timestamps. Client-supplied counters, free capacity or provenance are rejected. 201 returns `{data:rider}`. Duplicate code returns 409 DUPLICATE_RIDER and never overwrites existing configuration/workload. Rider creation does not use job idempotency semantics: if a successful commit loses its reply, the API may return 503; a subsequent duplicate POST returns 409, and exact-code GET confirms the existing rider.

## GET riders

`GET /api/v1/riders?code=R-001&zone=NORTH&availability=AVAILABLE&page=1&pageSize=20`

Filters are optional and combine with AND. Code is exact/normalized and is not a regex. Zone matches supported service zones, not current location. Availability must be a known enum. Results sort by code then ID ascending. Page is 1–10000; pageSize 1–100 (default 20). An empty/beyond-last page returns an empty array with its total.

200: `{data:[rider],pagination:{page:1,pageSize:20,total:1}}`. Rows and total use one snapshot. Between requests, the fleet can change.

## GET rider detail and active workload

`GET /api/v1/riders/:riderId?page=1&pageSize=20`

ID must be 24 hexadecimal characters; malformed IDs return 400, absent valid IDs 404 RIDER_NOT_FOUND. Detail returns `{data:{...rider,activeAssignments:[attempt]},pagination:{page,pageSize,total}}`. Pagination applies to active attempts. Pending, accepted and picked-up attempts count as occupied work. Expired/rejected/cancelled/delivered attempts are excluded from this active list and remain in the job's operational history.

Attempts sort by assigned time then ID. Shared attempt DTOs show outcome, reservation amount, timestamps, actor, reasons and stored scoring explanation, without private request keys/hashes. An index on riderId/active/assignedAt/ID supports this query. Data, counts and attempts are read in one snapshot. Real assignment and seeded reviewer suites verify current attempt visibility and workload.

`availableUnits = capacityUnits - reservedUnits`. Free physical capacity can be positive on an UNAVAILABLE rider; it does not mean the rider is eligible for a particular job. The recommendation engine evaluates coverage, load and availability for each job. Invalid stored counter combinations return 409 WORKLOAD_CONFLICT rather than misleading/clamped availability.

## PATCH rider configuration

`PATCH /api/v1/riders/:riderId` with `X-Actor-Id` and one or more of:

```json
{
  "name": "Meena",
  "currentZone": "WEST",
  "serviceZones": ["CENTRAL", "NORTH", "WEST"],
  "capacityUnits": 7,
  "availability": "UNAVAILABLE"
}
```

Only supplied fields change. Empty patches, code changes, counter/free-capacity writes, actor/timestamp writes and unknown fields return 400. A successful update returns 200 `{data:rider}`, preserves createdBy/creation time, and changes updatedBy/update time.

- Capacity cannot become lower than reservedUnits. Equality is valid and yields zero free units.
- Service-zone removal is blocked while activeJobCount > 0. This conservative policy preserves every existing zone until active work ends; adding zones is allowed.
- UNAVAILABLE prevents future willingness to receive work; it does not reject active attempts or release reserved capacity. Switching back to AVAILABLE also preserves workload.
- Name/current-zone updates are permitted with active work. A known current zone may be outside the supported service zones.

The service reads/checks the rider and conditionally writes configuration in one transaction. It does not write counters copied from a stale object. A concurrent rider write causes a transaction retry and a fresh recheck. Controlled real-database tests verify newly unsafe capacity/coverage edits conflict and offline edits preserve newly reserved counters. Phase 6 now verifies these conflicts against actual public assignment/reservation writes as well.

An uncertain PATCH commit may return 503; retry the same configuration values or read the rider. Such retries do not increment/decrement capacity counters. Concurrent changes to separate configuration fields are preserved; concurrent same-field edits use the committed order (no client-version precondition is provided).

## Errors

| Status | Code                   | Meaning                                                                  |
| ------ | ---------------------- | ------------------------------------------------------------------------ |
| 400    | VALIDATION_ERROR       | Bad headers/body/query/ID, empty patch or protected-field write          |
| 400    | INVALID_JSON           | Invalid JSON                                                             |
| 404    | RIDER_NOT_FOUND        | Valid rider ID is absent                                                 |
| 409    | DUPLICATE_RIDER        | Code already exists                                                      |
| 409    | CAPACITY_CONFLICT      | Proposed capacity is below reserved load                                 |
| 409    | ACTIVE_ZONE_CONFLICT   | Removing existing coverage while active work remains                     |
| 409    | WORKLOAD_CONFLICT      | Stored counters are internally inconsistent; reconciliation is needed    |
| 409    | STATE_CONFLICT         | Stored rider changed; refresh/retry                                      |
| 413    | PAYLOAD_TOO_LARGE      | JSON exceeds 64 KiB                                                      |
| 503    | DEPENDENCY_UNAVAILABLE | Database not ready, bounded operation/retry failure or unresolved commit |
| 500    | INTERNAL_ERROR         | Unexpected error, with internal details excluded                         |

No rider DELETE endpoint is registered; unavailable riders keep their identity and operational references. Update provenance is not a substitute for future authenticated authorization or tamper-resistant audit storage.

## Curl walkthrough

```bash
curl -i http://127.0.0.1:4000/api/v1/riders \
  -H 'Content-Type: application/json' -H 'X-Actor-Id: dispatcher:demo' \
  --data '{"code":"r-001","name":"Arun","serviceZones":["CENTRAL","NORTH"],"currentZone":"CENTRAL","capacityUnits":5}'
```

Copy `data.id` from the 201 response:

```bash
RIDER_ID='paste-returned-id-here'
curl 'http://127.0.0.1:4000/api/v1/riders?zone=NORTH&availability=AVAILABLE'
curl "http://127.0.0.1:4000/api/v1/riders/$RIDER_ID"
curl -i "http://127.0.0.1:4000/api/v1/riders/$RIDER_ID" \
  -X PATCH -H 'Content-Type: application/json' -H 'X-Actor-Id: dispatcher:demo' \
  --data '{"availability":"UNAVAILABLE","capacityUnits":3}'
curl 'http://127.0.0.1:4000/api/v1/riders?code=r-001'
```

The new rider has zero workload, so reducing unused capacity to 3 succeeds. Repeat the create to observe 409 DUPLICATE_RIDER. Submit `reservedUnits` in a patch to observe 400. The active-work capacity/zone conflicts are covered by real integration fixtures and tests; they are now demonstrable by assigning through the Phase 6 API. The operational React desk exposes these controls and active workload.
