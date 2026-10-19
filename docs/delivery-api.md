# Delivery and cancellation API

All routes require `X-Actor-Id`, a valid job ID, strict JSON body and no query parameters. Errors use the common envelope in api-contract.md.

| POST route                    | Body                              | Result                                                                      |
| ----------------------------- | --------------------------------- | --------------------------------------------------------------------------- |
| `/api/v1/jobs/:jobId/pickup`  | `{"assignmentId":"<current-id>"}` | ACCEPTED → PICKED_UP; reservation retained                                  |
| `/api/v1/jobs/:jobId/deliver` | `{"assignmentId":"<current-id>"}` | PICKED_UP → DELIVERED; original attempt load released                       |
| `/api/v1/jobs/:jobId/cancel`  | `{"reason":"Customer cancelled"}` | NEW/READY/MANUAL/AWAITING/ACCEPTED → CANCELLED; active reservation released |

Success is 200 `{data:{job,assignment},replayed:false}`; cancellation without an active attempt returns assignment null. Matching terminal retries return `replayed:true` without a new event or capacity decrement. A repeated cancellation requires the same trimmed reason; a changed reason returns 409 CANCELLATION_CONFLICT. A pickup replay after this same attempt was delivered is safe. Foreign/stale attempt IDs return 409 ASSIGNMENT_CONFLICT. Illegal state changes return 409 INVALID_TRANSITION. Cancellation after pickup is prohibited.

The transaction updates the guarded job version, matching attempt, rider counters and append-only event together. Only the winner of the active/unreleased attempt predicate may release capacity. Cancellation versus pickup, expiry or duplicate completion is resolved by real MongoDB write conflicts and retried current-state validation. An uncertain commit returns 503; retry the exact command to recover its durable outcome. No success is inferred from a lost reply.

Example after accepting an assignment:

```bash
curl -X POST "$API/api/v1/jobs/$JOB/pickup" -H 'Content-Type: application/json' -H 'X-Actor-Id: dispatcher:demo' -d "{\"assignmentId\":\"$ATTEMPT\"}"
curl -X POST "$API/api/v1/jobs/$JOB/deliver" -H 'Content-Type: application/json' -H 'X-Actor-Id: dispatcher:demo' -d "{\"assignmentId\":\"$ATTEMPT\"}"
```

Read job history and rider detail afterwards to verify DELIVERED, one release timestamp, zero remaining reservation for this job and consecutive audit events. Other jobs retain their own reservations.
