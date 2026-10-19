# Engineering notes

## Implemented scope and assumptions

All required local workflows are implemented: dashboard/attention, job/rider management, explainable ranking, reasoned overrides, transactional reservations, rider response, persisted timeout recovery, manual investigation/reassignment, pickup/delivery/cancellation, retained attempts and append-only operational events. Public sample data and the one-page PDF accompany the source. See verification.md for actual checks, not estimates.

Load is a positive integer capacity unit. Pending, accepted and picked-up attempts occupy both load units and one active-job count. Both zones require coverage; priority/deadline never bypass this or capacity. NEW explicitly becomes ready. Rejection enters manual immediately. No candidates enters manual when the dispatcher requests recommendations. Expiry equality belongs to timeout. Cancellation is permitted only before pickup with a reason; post-pickup return/failure is outside scope. Deadlines influence scoring and attention without automatically cancelling deliveries.

References/codes normalize by trim/uppercase, and search is exact. One operation/fleet is assumed. Locations and the complete five-zone travel matrix are simulated. Estimates are operational advice, not routing guarantees. Actor headers are demo attribution, not authentication or authorization. Rider createdBy/updatedBy are last-writer provenance; job operational history is append-only. No delete or arbitrary status PATCH endpoint exists.

## Why these choices are defensible

A delivery job and an assignment attempt have different lifetimes: rejection/expiry ends one attempt while the job survives for reassignment. Keeping attempts separate preserves retry receipts and original scoring/load. Four collections fit this workflow without a mutable collection per screen.

MongoDB transactions are required because one operation changes job, rider counters, attempt and history. Unique indexes alone cannot protect their combined consistency. Guarded writes compete on the same job/rider; retries re-read current state. The active-attempt index is defense in depth. Release wins only after guarded terminalization of an unreleased active attempt; subtract the immutable original load once, without clamping inconsistent counters. The code checks local counter bounds, not a full cross-document reconciliation on every request.

A persisted expiresAt plus a startup/interval scan survives downtime. In-process timers merely trigger bounded scans; they do not own assignment truth. Multiple workers safely race through database predicates. Keeping this inside the monolith avoids Redis or broker infrastructure for a small operation.

Advice does not reserve capacity. Assignment recomputes ranking and guards the chosen rider; other unselected riders are not globally locked. Store numeric snapshots so later workload changes do not rewrite the reason behind a historic choice. A non-top eligible choice requires an operational reason; an ineligible rider can never be overridden.

Successful assignment keys bind job + canonical rider/reason in durable attempts. Replaying returns the original attempt and current job, even after later progress. Network uncertainty is recovered by receipt or returned as 503, never asserted as success/failure. The UI persists that exact command for retry. Job creation stores at most one optional key; a new key cannot become an unbound alias on an existing reference.

## Known limitations and incomplete optional work

- No Docker execution was possible here; the compose recipe is supplied but unverified. Actual MongoDB 8.0.17 replica-set/index/transaction behavior and real Chromium local workflow were verified independently. No production deployment, failover, load testing, authentication or external Git remote is provided.
- Audit guards apply through supported Mongoose/API operations, not privileged raw DB access. Failed assignment rollback and its failure audit use separate transactions; a process crash in that gap can omit the failed-command event. Repeated failed commands may add repeated failure events. A returned auditable business conflict means its failure event committed; inability to confirm it returns 503.
- Small-fleet ranking and snapshots include the full fleet, so they are unbounded in rider count and eventually approach MongoDB document limits. The UI resolves labels from the first 100 riders, falling back to IDs; paginated rider/workload/history views remain available. Dashboard aggregation scans active jobs and uses bounded output/query timeouts; it needs query-plan review at larger volume. Offset pagination can shift between requests.
- The worker scans at most 100 oldest due attempts sequentially. A full batch of persistently corrupt oldest records can delay newer work. It logs failures and retries but has no alerting/reconciliation interface. Readiness measures DB readiness, not worker health. Timeout latency includes scan interval, processing and UI polling. A 10-second shutdown budget can terminate longer retry work; persisted state supports restart recovery.
- Accept uses server decision time; a pre-deadline winning transaction can commit after the deadline. Driver retry captures fresh time. Delivery/cancellation/response uncertain replies require matching retries. Fault injection is not proof of production failover behavior.
- LocalStorage command recovery is best effort if storage is disabled; in-session state still preserves the command. Each new action in another tab gets its own key and server conflict handling. Non-assignment mutations rely on documented state/reference replay; the UI surfaces uncertainty without automatic retries. Rider creation has identity uniqueness rather than a replay receipt; use exact-code lookup after a lost response.
- Seed reruns preserve existing DEMO-* records and user progress. A mid-seed interruption can leave a valid partial scenario. Finish it in the UI or use a fresh development database. Do not run concurrent seed processes or treat the reserved prefix as production data.

All assignment-required workflows are implemented. The items above are operating limits and optional production work, not hidden substitutions of the requested stack. The 8–12-hour target is a planning estimate; the original receipt/submission deadline and human effort are not independently measurable here.

## Three improvements with another week

1. Add authenticated dispatcher/rider roles, authorization and restricted database roles for stronger actor provenance and audit retention.
2. Monitor pending age, worker lag and counter drift; add a tested reconciliation tool and deployment/backup procedures.
3. Improve travel estimates and post-pickup exceptions/returns, then tune scoring against observed dispatch outcomes.
