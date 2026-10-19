# Implemented job API

Job management exposes five operations under `/api/v1/jobs`; delivery and dispatch commands are documented in their linked guides. All operations in the full contract are implemented. Run a MongoDB replica set and the API using the root README. No public seed command is needed for the job-only walkthrough below.

## Headers and common conventions

Send `Content-Type: application/json` for mutations. `X-Actor-Id` is required on create/ready (trimmed, 1–80 characters) and recorded on the action's event; it is a demo actor, not authentication. GET needs no actor header and does not mutate audit history. Create optionally accepts a case-sensitive `Idempotency-Key` (trimmed, 1–128 characters).

Responses use JSON and `X-Request-Id`. Dates are returned as UTC ISO strings. Job DTOs include `id`, reference/zones, load, priority, deadline, status, current assignment/rider IDs, manual reason, state version and creation/update times. Absent pointers/deadline/reason are null. Private request hashes, keys, internal event counters, `_id` and Mongoose metadata are excluded.

## POST jobs

```http
POST /api/v1/jobs
X-Actor-Id: dispatcher:demo
Idempotency-Key: demo-create-1001
Content-Type: application/json
```

```json
{
  "orderReference": "relay-1001",
  "pickupZone": "CENTRAL",
  "deliveryZone": "NORTH",
  "loadUnits": 2,
  "priority": "HIGH"
}
```

Reference is trimmed/uppercased, required, maximum 80 characters. Zones are trimmed/uppercased and must be CENTRAL, NORTH, SOUTH, EAST or WEST. Pickup and delivery may share a zone. Load must be a positive safe-integer JSON number (numeric strings rejected). Priority is LOW/NORMAL/HIGH/URGENT, default NORMAL. Optional `deadlineAt` must be an ISO datetime with timezone and be later than the server's creation decision time for a genuinely new job. Equivalent timezone offsets normalize to the same UTC instant. Unknown body fields, including server-owned status/counters, are rejected.

201 creates one NEW job and one JOB_CREATED event. Response: `{data:job,replayed:false}`. A repeated canonical request returns 200 `{data:currentJob,replayed:true}` without another job/event and without resetting its state. Actor changes are not payload changes. The original creation event retains its original actor.

Canonical payload includes reference, zones, load, priority after defaulting and normalized deadline/null. The first successful write stores at most one optional creation key. A retry reuses that key or omits it for reference replay. A different/new key on an existing reference returns 409 IDEMPOTENCY_CONFLICT, including if the original request omitted a key. A bound key reused for different payload/reference returns the same conflict. Repeated reference with changed details and no matching key returns 409 DUPLICATE_JOB. Key ownership is checked first. No in-memory idempotency map is used.

A once-valid deadline may be past by replay time: an identical stored request still replays. A genuinely new past/equal deadline returns 400. Concurrent identical requests produce one 201 and 200 replays; conflicting payloads produce a winner and 409. Job and creation history are in one transaction, so failed history storage leaves no job behind. An uncertain creation commit is reconciled by stored key/reference; if unresolved, return 503 and retry the same request.

## GET jobs

`GET /api/v1/jobs?page=1&pageSize=20&status=NEW&zone=NORTH&orderReference=RELAY-1001`

All filters optional. Reference is an exact normalized match, never a regex or substring. Zone matches pickup **or** delivery, combined with status/reference using AND. Status must be one of the eight documented job states. Page is 1–10000; pageSize 1–100, default 20. Repeated/unknown query keys, invalid numbers and operator-shaped filters are rejected. Sort is `createdAt` then `_id` ascending, providing a deterministic tie break.

200 response: `{data:[job],pagination:{page:1,pageSize:20,total:1}}`. Empty/beyond-last pages return an empty array while retaining the total. Results and total use one snapshot; separate page requests can observe intervening changes.

## GET job detail

`GET /api/v1/jobs/:jobId` returns 200 `{data:job}`. ID must be exactly 24 hexadecimal characters. Malformed ID returns 400; absent valid ID returns 404 JOB_NOT_FOUND. This operation accepts no query parameters.

## POST mark ready

`POST /api/v1/jobs/:jobId/ready` with `X-Actor-Id` and body `{}` returns 200 `{data:job,replayed:false}` for NEW → READY_FOR_ASSIGNMENT. It increments state version once and appends JOB_READY with a per-job sequence, timestamp, actor and before/after state. Repeating while already ready returns 200 `replayed:true` without another event/version change. Other source states return 409 INVALID_TRANSITION; they are never reset. Arbitrary status bodies are rejected.

A guarded status/version update plus the audit append share one transaction. Concurrent ready requests have one effective transition. An uncertain ready response may return 503; retrying it is safe while the job remains ready. If work has since progressed to another state, refresh rather than resetting it.

## GET history

`GET /api/v1/jobs/:jobId/history?page=1&pageSize=20` returns:

```json
{
  "data": { "events": [], "attempts": [] },
  "pagination": { "page": 1, "pageSize": 20, "total": 0 },
  "attemptsPagination": { "page": 1, "pageSize": 20, "total": 0 }
}
```

This example illustrates the response shape; a real created job has at least its creation event. Events sort by per-job sequence. Attempts sort by assignment time and ID. Both arrays use the requested page/size with separate totals; neither is unbounded. Each event includes ID, job ID, sequence, type, UTC time, actor, optional assignment ID and typed details. Attempt DTOs retain outcomes/release timestamps/reasons and recommendation snapshots while excluding request keys/hashes. Assignment creation is implemented in Phase 6; resolution is implemented in Phase 7. History now covers actual accepted/rejected/expired attempts and reassignment without relying on terminal fixtures. No event edit/delete endpoint is registered.

## Errors

| Status | Code                                | Trigger                                                                                             |
| ------ | ----------------------------------- | --------------------------------------------------------------------------------------------------- |
| 400    | VALIDATION_ERROR                    | Bad fields, headers, IDs, query parameters or new past deadline; details include field path/message |
| 400    | INVALID_JSON                        | Malformed JSON body                                                                                 |
| 404    | JOB_NOT_FOUND                       | Valid job ID does not exist                                                                         |
| 404    | ROUTE_NOT_FOUND                     | Unknown/unimplemented route or history mutation endpoint                                            |
| 409    | DUPLICATE_JOB                       | Existing reference with changed delivery details                                                    |
| 409    | IDEMPOTENCY_CONFLICT                | Key reused with changed payload, or a new key supplied for existing work                            |
| 409    | INVALID_TRANSITION / STATE_CONFLICT | Illegal or stale ready operation                                                                    |
| 413    | PAYLOAD_TOO_LARGE                   | JSON body exceeds 64 KiB                                                                            |
| 503    | DEPENDENCY_UNAVAILABLE              | Database unavailable, bounded operation/retry failure, or unresolved creation outcome               |
| 500    | INTERNAL_ERROR                      | Unexpected implementation/storage failure; no private error message returned                        |

Example error: `{"error":{"code":"VALIDATION_ERROR","message":"Invalid request","details":[{"path":"deadlineAt","message":"Deadline must be in the future for a new job"}]},"requestId":"server-generated-id"}`. Database query limits are 5 seconds and transaction/retry budget is 15 seconds; these differ from the separately configured two-hour rider response threshold.

## Curl walkthrough

From Git Bash/WSL or another shell, after starting the API:

```bash
curl -i http://127.0.0.1:4000/api/v1/jobs \
  -H 'Content-Type: application/json' \
  -H 'X-Actor-Id: dispatcher:demo' \
  -H 'Idempotency-Key: demo-create-1001' \
  --data '{"orderReference":"relay-1001","pickupZone":"CENTRAL","deliveryZone":"NORTH","loadUnits":2}'
```

Run that request again: first response 201, second 200 replay with the same ID. Copy the returned `data.id` into JOB_ID below (a normal API identifier, with no database editing):

```bash
JOB_ID='paste-returned-id-here'
curl -i "http://127.0.0.1:4000/api/v1/jobs/$JOB_ID/ready" \
  -H 'Content-Type: application/json' -H 'X-Actor-Id: dispatcher:demo' --data '{}'
curl "http://127.0.0.1:4000/api/v1/jobs?zone=NORTH&status=READY_FOR_ASSIGNMENT"
curl "http://127.0.0.1:4000/api/v1/jobs/$JOB_ID"
curl "http://127.0.0.1:4000/api/v1/jobs/$JOB_ID/history"
```

Ready shows version 1. History shows JOB_CREATED then JOB_READY, sequences 1 and 2. Repeating ready adds no event. Replaying the original create returns the current READY state. Changing load while reusing the key produces 409; sending a string load produces 400. The operational React interface comes in Phase 10.
