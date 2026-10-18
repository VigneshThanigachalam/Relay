# Engineering notes

## Current scope

Phase 2 implements domain status/transition rules, expiry boundaries, rider-counter invariants, Job/Rider/Assignment/JobEvent schemas, named indexes, type-specific audit payload validation, append-only model guards, explicit persistence initialization and a transaction helper. Focused comments explain safety/consistency decisions. Real MongoDB integration checks verify these foundations.

There are still no job/rider business routes, ranking implementation, capacity-reservation service, actual timeout worker, public seed command, operational dashboard or final one-page presentation. Transaction infrastructure tests do not prove full dispatch workflows. See the requirements checklist and both phase reports for evidence.

## Assumptions

Load is a positive integer unit, not kilograms or simultaneous delivery slots. A rider's capacity is reserved from pending assignment until a terminal attempt; confirmation keeps it reserved. Active count includes pending/accepted/picked-up. Both pickup and destination require zone coverage. A delivery may have identical pickup/destination zones. Priority/deadline influence ranking but never bypass eligibility. The dispatcher explicitly marks a NEW job ready. Rejection and timeout both enter manual; no-candidate ready jobs enter manual during recommendation evaluation. Cancellation before pickup is allowed with a reason; later cancellation requires a future exception workflow.

Idempotency is a single-operation contract with stored hashes, not a process-memory map. Exact normalized reference search is sufficient; free-text search is optional. Dates are server UTC and displayed in operator locale. There is one operation/fleet and no multitenant isolation. Demo actors are supplied by UI/API; no authentication claim is made. Sample travel times and estimated arrival are illustrative.

## Known limitations and verification gaps

A development-only harness now downloads and starts actual MongoDB 8.0.17 processes, including a single-node replica set. Real index constraints, transaction commit/rollback and refusal of standalone MongoDB are verified. The initial default socket startup failed with an operation-not-permitted error; the TCP-only harness runs successfully without elevated permissions. Docker remains unavailable and the compose recipe remains unexecuted. No browser visual walkthrough or full seeded workflow has been performed. There is no remote Git repository configured.

Schema pre-validation hooks run for document creation/save, not arbitrary query updates. Mongoose guards are not database permissions. Foreign keys, request replay semantics, audit-sequence allocation and cross-document counter equality require the later service implementations. Database-level unique indexes protect the specific uniqueness rules now; tests do not claim full concurrent assignment or release-once behavior.

The test suite needs a first-run binary download (roughly 100 MB) or a configured local test binary. It creates and removes temporary fixture-owned data and never uses a user-configured production URI. No mocked or silently skipped database tests are counted as real integration coverage.

Application append-only audit prevents edits through supported APIs, not a privileged DB administrator. Polling delivers timeout handling on the next successful scan; it is not an exact-time scheduler. A single-node replica set has no redundancy. A simple fleet-wide in-memory sort is appropriate for the assignment; huge fleets need indexed shortlisting and better telemetry. These are design limits, not implemented behavior in this phase.

## Three improvements with another week

1. Add authenticated dispatcher/rider roles with authorization, stronger actor provenance and restricted database roles for audit retention.
2. Add monitoring for pending age, worker lag and counter invariant drift, plus a tested reconciliation tool and robust deployment/backup procedures.
3. Improve travel estimates and operational exceptions (post-pickup failure/returns), using observed dispatch outcomes to tune scoring and deadline risk.
