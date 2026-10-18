# Engineering notes

## Current scope

Phase 1 implements the development foundation only. Requirements/design/contracts are reviewable proposals. There are no business routes, Mongoose domain schemas, reservation transactions, actual timeout worker, seed command, operational dashboard or final one-page presentation yet. No business acceptance criteria are claimed complete. See the requirements checklist and Phase 1 report for exact evidence.

## Assumptions

Load is a positive integer unit, not kilograms or simultaneous delivery slots. A rider's capacity is reserved from pending assignment until a terminal attempt; confirmation keeps it reserved. Active count includes pending/accepted/picked-up. Both pickup and destination require zone coverage. A delivery may have identical pickup/destination zones. Priority/deadline influence ranking but never bypass eligibility. The dispatcher explicitly marks a NEW job ready. Rejection and timeout both enter manual; no-candidate ready jobs enter manual during recommendation evaluation. Cancellation before pickup is allowed with a reason; later cancellation requires a future exception workflow.

Idempotency is a single-operation contract with stored hashes, not a process-memory map. Exact normalized reference search is sufficient; free-text search is optional. Dates are server UTC and displayed in operator locale. There is one operation/fleet and no multitenant isolation. Demo actors are supplied by UI/API; no authentication claim is made. Sample travel times and estimated arrival are illustrative.

## Known limitations and verification gaps

MongoDB server and Docker executables are not available in the current environment. The compose recipe is provided for reviewers but cannot be claimed executed here. Replica-set transactions, indexes, reservation races and seeded workflow require a real database in later phases. Do not replace these with mocked database tests as evidence of concurrency correctness. Foundation HTTP/UI tests do not verify MongoDB connectivity. No standalone browser walkthrough has yet been performed. Source and all genuine local Git refs/history are included in the Phase 1 handoff archive; there is no remote repository configured.

Application append-only audit prevents edits through supported APIs, not a privileged DB administrator. Polling delivers timeout handling on the next successful scan; it is not an exact-time scheduler. A single-node replica set has no redundancy. A simple fleet-wide in-memory sort is appropriate for the assignment; huge fleets need indexed shortlisting and better telemetry. These are design limits, not implemented behavior in this phase.

## Three improvements with another week

1. Add authenticated dispatcher/rider roles with authorization, stronger actor provenance and restricted database roles for audit retention.
2. Add monitoring for pending age, worker lag and counter invariant drift, plus a tested reconciliation tool and robust deployment/backup procedures.
3. Improve travel estimates and operational exceptions (post-pickup failure/returns), using observed dispatch outcomes to tune scoring and deadline risk.
