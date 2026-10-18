# Requirements and verification checklist

The unchanged [assignment](source/assignment.docx) is authoritative. References below use section labels and paragraph IDs in [the complete extraction](source/assignment-extracted.txt). Every implementation and test target is **planned** unless marked Foundation. A named test is a verification obligation, not evidence that it exists or passes.

Status: **F** = foundation implemented (see Phase 1 report for checks); **P** = pending. Paths are relative to the repository. `api` means `apps/api/src/modules`; `web` means `apps/web/src/features`; tests are colocated with the named module, with cross-module integration tests in `apps/api/test/integration`.

| ID | Source | Requirement and acceptance check | Implementation target | Verification target | State |
| --- | --- | --- | --- | --- | --- |
| D01 | 3A P014–020 | Display total, NEW/ready, pending confirmation, accepted/picked up, manual, delivered and cancelled counts with clear labels | api/dashboard; web/dashboard | dashboard.integration; Dashboard.test | P |
| D02 | 3A P021 | List jobs; exact normalized order reference search; status and zone filters; paginated results | api/jobs; web/jobs | jobs-list.integration; JobList.test | P |
| D03 | 3A P021–022 | Open job detail/state/history and highlight overdue, manual and deadline risk work | web/jobs; api/dashboard | JobDetail.test; attention.integration | P |
| J01 | 3B P024–033 | Persist unique reference, pickup/delivery zones, positive integer load, priority, creation time, optional deadline, status and optional current rider | api/jobs; api/persistence | jobs-validation; models.integration | P |
| J02 | 3B P034; 4 P114 | Concurrent repeated submissions create one job; same normalized reference and payload replays; changed payload conflicts | api/jobs | duplicate-jobs.integration (parallel requests) | P |
| J03 | 3B P033; 4 P112 | Reject malformed IDs, unknown zones, past deadlines on creation, invalid priority, fractional/negative load and unknown fields | api/jobs; shared HTTP validation | jobs-validation; jobs-http.integration | P |
| R01 | 3C P036–038 | View/create/update riders with identity, service zones, availability, total capacity and current reserved load/active count | api/riders; web/riders | riders.integration; RiderPanel.test | P |
| R02 | 3C P039 | Eligibility requires availability, coverage of both zones and enough remaining capacity | api/recommendations | eligibility.test | P |
| R03 | 3C P038–039; design | Show pending plus accepted/picked up work as occupied; prevent capacity reduction below reserved load | api/riders; web/riders | rider-update.integration | P |
| E01 | 3D P041–049 | Rank eligible riders using documented workload, travel estimate and priority/deadline factors with per-rider score breakdown and stable tie break | api/recommendations | ranking.test (ties, urgent, deadline, missing estimate) | P |
| E02 | 3D P048–049; 8 P170 | Use seeded, documented simulated zone travel times; no paid/GPS dependency | api/recommendations; seed data | travel-estimates.test | P |
| E03 | 3D P050 | Review recommendations and assign the top eligible candidate | api/dispatch; web/dispatch | eligible-assignment.integration; AssignmentPanel.test | P |
| E04 | 3D P050; 3G P089 | Assign a different eligible rider only with a nonblank override reason; audit actor/reason and recommendation snapshot | api/dispatch; web/dispatch | override.integration; AssignmentPanel.test | P |
| E05 | 3D P051; 6 P131 | No eligible rider leaves job unassigned and visibly actionable; chosen policy moves ready job to MANUAL_QUEUE with reason | api/recommendations; web/dispatch | no-candidate.integration | P |
| A01 | 4 P103; 5 P118–123 | Model job separately from every attempt; reserve capacity, create attempt, link job and append events atomically | api/dispatch; api/persistence | assignment-atomicity.integration | P |
| A02 | 4 P114; 5 P121 | Two dispatchers for one job yield one active attempt and one reservation; loser gets 409 | api/dispatch | concurrent-assignment.integration | P |
| A03 | 3C P039; 5 P120 | Competing jobs cannot exceed the same rider's capacity | api/dispatch | concurrent-capacity.integration | P |
| A04 | 4 P114 | Retried assignment command replays the same attempt without reserving twice; changed payload/key reuse conflicts | api/dispatch | assignment-idempotency.integration | P |
| C01 | 3E P054 | Simulate rider acceptance through UI/API with recorded actor and assignment ID | api/dispatch; web/dispatch | confirmation.integration; ConfirmationPanel.test | P |
| C02 | 3E P055–056 | Default response threshold 2 hours; positive configurable milliseconds allow a short reviewer demo | config (F); api/worker (P) | env.test (F); timeout.integration (P) | P |
| C03 | 3E P057–062 | Automatically expire pending attempt, move job to manual, record reason, retain attempt and release capacity in one transaction | api/worker; api/dispatch | timeout.integration | P |
| C04 | 3E P063 | Rejection follows same manual/release/history process immediately; document choice | api/dispatch | rejection.integration | P |
| C05 | 3E P064; 4 P114 | Acceptance versus expiry has one winner; equality belongs to expiry; expired IDs cannot accept a reassignment | api/dispatch | confirmation-timeout-race.integration; stale-attempt.integration | P |
| C06 | 3E P061; 5 P120 | Release reservation once across repeated worker runs, retry, rejection/cancel and delivery | api/dispatch | release-once.integration | P |
| C07 | 3E P055; design | Restarted worker scans persisted overdue attempts; repeated/overlapping scans safe; failures retry next tick | api/worker | worker-restart.integration; worker.test | P |
| M01 | 3E P062–064; 4 P108–109 | List/investigate manual queue with reason, age and attempt history; reassign with normal eligibility/reservation checks | api/jobs; api/dispatch; web/manual-queue | manual-reassign.integration; ManualQueue.test | P |
| M02 | 3E P060; user quality | Failed, rejected and expired attempts stay visible after reassignment; known-job assignment conflicts get failure audit records | api/history; web/jobs | history.integration; JobHistory.test | P |
| L01 | 3F P067–076 | Support all eight required states without collapsing NEW into ready | api/jobs; api/dispatch | lifecycle.test | P |
| L02 | 3F P066–077 | NEW → ready → pending → accepted → picked up → delivered; prevent skips and terminal-state progress | api/jobs; api/dispatch | lifecycle.integration; invalid-transitions.test | P |
| L03 | 3F P075–077; 4 P107 | Cancel before pickup with reason/actor; release pending or accepted reservation and retain history; picked-up cancellation deliberately forbidden | api/dispatch; web/jobs | cancellation.integration | P |
| H01 | 3F P078; 3G P080–091 | Append creation, recommendation, assignment, accept/reject, timeout, manual entry, reassignment, status, override and cancellation events | api/history | history-event-coverage.integration | P |
| H02 | 3G P090–091 | Events contain type, server timestamp, actor when initiated by a user, details and monotonically ordered per-job sequence | api/history | history-order.integration | P |
| H03 | 3G P091; user quality | No history update/delete API; mutation and its audit commit together; retain original attempts and score snapshots | api/history; transaction services | audit-rollback.integration; audit-api.integration | P |
| API01 | 4 P096–111 | Create/get/list/filter/history jobs; rider detail; recommendations; assignment/reassignment; accept/reject; pickup/deliver/cancel; manual queue | docs/api-contract.md; all api modules | end-to-end.integration | P |
| API02 | 4 P112 | Zod requests; meaningful 400/404/409/503 plus safe 500 responses, request IDs and bounded lists | HTTP foundation (F); feature validation (P) | app.test (F); api-errors.integration (P) | P |
| API03 | 4 P113 | Thin controllers delegate to independent services, pure ranking/lifecycle functions and persistence adapters | docs/architecture.md; modules | service tests and code review | P |
| DATA01 | 5 P118–125 | Index normalized reference, one active attempt/job, command replay, due attempts, status/zone queues, event sequence | api/persistence | indexes.integration (actual MongoDB replica set) | P |
| DATA02 | 5 P123 | Failed transaction leaves no partial job/rider/attempt/event state | api/persistence; dispatch | rollback.integration (injected failure) | P |
| UI01 | 6 P138 | Loading, failed API/retry, empty queues and validation/conflict states; disable duplicate submissions and stale actions | all web features | RTL interaction tests incl. non-2xx and network failure | P |
| DEMO01 | 7 P143; 9 P174–175 | Reviewer loads seeds, creates job, ranks/overrides, accepts/rejects, sees timeout/manual, reassigns and delivers without DB edits | seed script; README walkthrough | reviewer-demo.integration and browser walkthrough | P |
| S01 | 7 P141–144 | Complete source/config/sample data; deployment optional | .env.example (F); seed and app (P) | fresh local setup | P |
| S02 | 7 P145–147 | Prerequisites/install/config/start/test/demo and assumptions | README foundation (F), final walkthrough (P) | documentation rehearsal | P |
| S03 | 7 P148–149 | API operations, parameters, payloads, response/error examples sufficient without code | docs/api-contract.md (draft) | contract review against implemented endpoints | P |
| S04 | 7 P150–152 | Architecture diagram, components, models, assignment/timeout decisions, consistency risks | docs/architecture.md; docs/lifecycle.md (design complete) | implementation reconciliation in final phase | P |
| S05 | 7 P153–162 | One slide or one-page PDF: problem, solution, workflow, recommendations/manual automation, architecture/models, trade-off, next week | planned docs/solution-one-page.pdf | render inspection; one-page check | P |
| S06 | 7 P163–164 | Assumptions, limitations, incomplete parts and exactly three next improvements | docs/engineering-notes.md | final truthfulness review | P |
| Q01 | 8 P166–172 | 48h submission; target 8–12h implementation; explain decisions; assistants allowed; prioritize full workflow | docs/delivery-plan.md | effort/scope review (estimates only) | P |
| W01 | User stack | React/TS/Vite, Express/TS, MongoDB/Mongoose, Zod, Vitest/Supertest/RTL, modular monolith | apps/api; apps/web; npm workspace | typecheck/build/foundation tests | F |
| W02 | User workflow | One feature branch at a time; genuine Conventional Commits; tests before merge; stop after Phase 1 | Git; docs/delivery-plan.md | actual git log/status; Phase 1 evidence | F |

Minimum assignment test mapping (section 6): P129 → E03; P130 → R02; P131 → E05; P132 → C01/L02; P133 → C03; P134 → C03/C06/M02; P135 → J02; P136 → A02/L02. No business acceptance test is complete in Phase 1.

## Reviewer demonstration planned for the final phase

1. Start a MongoDB replica set, API and Vite UI; load deterministic sample data through the documented seed command.
2. Read counts and filters; create a job in NEW, mark ready, repeat submission and observe one record.
3. Rank riders; inspect excluded candidates and explain scores; assign eligible rider (also demonstrate a reasoned override).
4. Accept, pick up and deliver; verify matching status, workload and history.
5. Use a five-second response threshold before starting the API; assign a different job and wait for the automatic manual-queue move.
6. Inspect its expired attempt, released capacity and manual reason; reassign and complete. Repeat with rejection.
7. Demonstrate no-candidate handling, invalid transitions, cancellation and a concurrent-assignment conflict through tests/API.

## Scope interpretations

Authentication, routing maps, notifications, geolocation, billing, multitenancy and production deployment are not specified. A named demo actor header is sufficient for attribution but is not authentication. Management includes rider creation/updates and job lifecycle operations, not deletion of operational records. Deadline risk affects ranking/attention, never silently cancels work. Rejection moves immediately to manual. No eligible candidate moves ready work to manual when the dispatcher requests recommendations. These are explicit policies to verify, not extra claimed requirements.
