# Phase 4 verification and interview notes

Phase 4 completes the rider-management API feature: create/list/detail/PATCH, bounded active workload, strict validation and configuration changes that preserve existing commitments. Necessary comments explain transport reuse, provenance, update predicates, transaction retries and counter ownership. The operational UI and recommendation/assignment workflows remain pending.

## Implemented behavior

| Operation or component        | Actual behavior                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST /api/v1/riders           | Normalized immutable unique code, validated name/zones/location/capacity/availability, zero workload, server actor/timestamp provenance, 201 or 409 duplicate |
| GET /api/v1/riders            | Exact normalized code, supported-zone and availability filters, code order, bounded snapshot rows/totals                                                      |
| GET /api/v1/riders/:riderId   | Public rider DTO and bounded active attempts/count; pending/accepted/picked-up remain occupied; private attempt keys excluded                                 |
| PATCH /api/v1/riders/:riderId | Editable configuration only; guarded capacity/coverage updates; offline changes preserve counters and attempts; updatedBy/time record last writer             |
| Shared HTTP contracts         | Actor, ObjectId, zone, empty object and pagination validation reused across jobs/riders; compatible job exports retained                                      |
| Shared history DTOs           | Public event/attempt mappers reused by job history and rider workload                                                                                         |
| Workload index                | assignment_rider_workload on riderId, active, assignedAt and ID; actual database declaration verified                                                         |

See [rider-api.md](rider-api.md) for tested request/response shapes, errors and runnable curl examples. The four-collection design is unchanged. CreatedBy/updatedBy are configuration provenance, not a separate append-only rider audit log. Existing job history remains append-only.

## Genuine Git workflow

Started from clean main at `6c22f9d`, with only `feat/rider-management` in progress. The actual implementation commits preceding this report are:

| Full actual hash                           | Subject                                                                      |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| `fa0f6f518e93da06c7f0a40782bd62f028393e6a` | feat(riders): define rider contracts and reuse shared api validation         |
| `d27fe98df0c96f1a869a0ce02583437b176259a6` | feat(riders): create and inspect riders with bounded workload views          |
| `d092ca83e17c7c83dc11aeb5092ea90c2ae181fb` | feat(riders): guard configuration edits against reserved and concurrent work |
| `a15ff09b2741f32510c4f0b4f0d537ed737d371f` | perf(riders): index active assignment workload retrieval                     |

The verification/documentation commit and no-fast-forward merge are recorded by the final actual log and ZIP handoff manifest. Both current and earlier feature branches/history are retained. No remote repository, PR or fabricated activity is claimed.

## Automated verification

`npm run check` passed: formatting, both TypeScript checks, all tests, API production compilation and Vite production build.

| Actual test file                                  | Passed checks | Scope                                                                     |
| ------------------------------------------------- | ------------- | ------------------------------------------------------------------------- |
| apps/api/src/config/env.test.ts                   | 12            | Configuration                                                             |
| apps/api/src/app.test.ts                          | 7             | HTTP foundation                                                           |
| apps/api/src/http/errors.test.ts                  | 8             | Safe error envelopes                                                      |
| apps/api/src/modules/domain/lifecycle.test.ts     | 44            | Lifecycle, expiry and counter policy                                      |
| apps/api/src/modules/domain/audit-details.test.ts | 17            | Typed audit payloads                                                      |
| apps/api/src/modules/persistence/models.test.ts   | 27            | Document schema validation                                                |
| apps/api/src/modules/jobs/contracts.test.ts       | 28            | Job/shared transport contracts                                            |
| apps/api/src/modules/riders/contracts.test.ts     | 38            | Rider strict create/PATCH/filter validation                               |
| apps/api/test/integration/persistence.test.ts     | 28            | Actual indexes, audit guards, transaction boundary and startup checks     |
| apps/api/test/integration/jobs.test.ts            | 55            | Existing job HTTP workflows/races/rollback/replay                         |
| apps/api/test/integration/riders.test.ts          | 51            | Rider HTTP, workload/configuration safety and controlled stale-read races |
| apps/web/src/App.test.tsx                         | 1             | Honest Phase 4 placeholder label                                          |
| Total                                             | 316           | 315 API + 1 web across 12 files                                           |

The rider integration suite uses actual MongoDB 8.0.17/WiredTiger in a temporary single-node replica set. It verifies:

- Eight concurrent normalized duplicate rider creates produce one 201, seven 409 conflicts and one rider; original data is never overwritten.
- Strict field, actor, query and ID validation rejects counter/provenance/identity writes, malformed numbers, unknown fields and duplicate normalized coverage.
- Code search is exact, zone filtering matches service coverage rather than current location, and combined filters/pagination behave as documented.
- Coherent job/attempt fixtures represent pending/accepted/picked-up work; active detail pagination counts those and excludes historical expired attempts without exposing request keys/hashes.
- Capacity cannot drop below reserved units; equality succeeds. Active zone removals conflict; equal/reordered coverage and additions succeed.
- Going offline/back online preserves all active attempts and occupied counters. Name/location updates retain creation provenance and record the latest actor/time.
- Corrupt local counters produce WORKLOAD_CONFLICT rather than being clamped or silently repaired. Concurrent disjoint configuration patches preserve both changes.
- Lost create/patch commit-reply injections wrap real successful commits. Duplicate create retry conflicts with one persistent identity; repeated configuration patches preserve counters.

## What the race tests prove

Three controlled tests pause a real configuration update after the service read/validated its old snapshot. A direct rider-counter fixture write commits on the actual database, then the update resumes. The database conflict causes a fresh service retry:

| Interleaving                                         | Observed result                                                      |
| ---------------------------------------------------- | -------------------------------------------------------------------- |
| Reduce capacity to 2; concurrent fixture reserves 3  | 409 CAPACITY_CONFLICT; capacity stays 5, reservation stays 3         |
| Remove coverage; concurrent fixture adds active work | 409 ACTIVE_ZONE_CONFLICT; original zones retained                    |
| Go offline; concurrent fixture reserves 3            | 200 UNAVAILABLE, with reservedUnits 3 and activeJobCount 1 preserved |

The gates only control timing; writes/read retries execute against real MongoDB. These are configuration-versus-counter-write tests, not an implemented assignment API or proof of all reservation/release races. Actual assignment services must still atomically guard eligibility and write the same rider record in their own transactions.

## Compiled application smoke

Started a fresh real test replica set, spawned `apps/api/dist/server.js` as a separate Node process, and made real HTTP requests:

| Action                                   | Result                                          |
| ---------------------------------------- | ----------------------------------------------- |
| Readiness                                | 200 after bootstrap                             |
| Create rider                             | 201 with five free units and zero occupied work |
| Repeat rider code                        | 409                                             |
| List available riders covering NORTH     | 200, total 1                                    |
| Rider detail                             | 200, empty active workload                      |
| PATCH offline and reduce unused capacity | 200, counters preserved and updatedBy captured  |
| Available-rider filter after offline     | total 0                                         |
| Attempt to PATCH reservedUnits           | 400                                             |
| Existing job create and mark-ready       | 201 then 200                                    |
| Existing job history                     | JOB_CREATED then JOB_READY                      |
| SIGTERM                                  | Clean exit 0                                    |

This validates production app composition for both job and rider routes. No browser visual walkthrough is claimed.

## Commands and evidence

- `git switch -c feat/rider-management`: branch created from clean main.
- Shared/rider contracts plus existing job integration targeted run: 121 checks passed before the first commit.
- Initial rider reads/creation plus model targeted run: 54 checks passed before the create/read commit.
- Expanded rider targeted run: 51 checks passed before the guarded-update commit.
- Persistence plus rider index targeted run: 79 checks passed before the workload-index commit.
- API typechecks passed before each implementation claim/commit.
- `npm run format` and `npm run check`: formatting, all 316 tests, both typechecks and both production builds passed.
- Compiled-server smoke and graceful shutdown passed as above.
- `git diff --check` passed; local doc links, final Git integrity and restored ZIP are checked before handoff.
- Current runtime: Node v24.19.0, npm 11.9.0. Docker executable probe found none. No new dependency was added in this phase.

The MongoDB binary needed a first-run download again in this resumed environment; subsequent checks used its cache. The host npm http-proxy-config warning remains nonfatal. No test, Docker run, browser run, failover or dependency-security-audit result is invented.

## Practical interview decisions

**Why separate availability from workload?** Offline means the rider will not take new work. Existing accepted or pending commitments still occupy capacity and need their normal outcome/release path. Treating offline as empty workload could cause overbooking later.

**Why does capacity count pending assignments?** A pending offer already reserves the load. Otherwise multiple offers could all be accepted and exceed capacity. Schema/persistence work supports this invariant; the actual reservation API is still a later feature.

**Why block every zone removal during active work?** It is a conservative operational rule that preserves coverage without interpreting each active route. It allows additions now and avoids invalidating an existing delivery. A future refinement could permit removing zones proven unnecessary for all current work.

**Why not use only runValidators?** Query validators do not execute full document validation and do not protect a stale capacity check. The service validates current counters and proposed changes, writes only input configuration, and guards the counter/capacity snapshot inside a transaction. A concurrent rider write triggers a fresh callback/recheck.

**Why no client-version field on riders yet?** Disjoint patches write only supplied fields and are protected from counter races. Concurrent edits to the same configuration field follow commit order. If an operator must reject stale same-field changes, a client-visible configuration version/If-Match contract can be added later. Job state versions remain separate and unchanged.

**Why add an index now?** Rider workload reads query by rider and active flag, then sort attempts. Existing job-history indexes do not cover that access pattern. The new compound index matches it. Its presence/key shape is verified; no production benchmark is claimed.

**Are provenance fields a full audit?** No. They retain creator/last editor and timestamps. They are not an immutable list of rider configuration changes or verified authenticated identities. Job events continue to provide the requested append-only operational delivery history.

## File changes

The repository has 79 tracked files after this report. New files are shared HTTP contracts, shared history DTOs, rider contracts/tests/router/service/DTO, the real rider HTTP suite, rider-api.md and this report. Existing job imports/compatibility exports, rider schema provenance, assignment index, startup wiring, phase UI label and documentation were updated. Tracked diff before this report follows; the two new documentation files are also listed:

```text
M	README.md
M	apps/api/src/app.ts
A	apps/api/src/http/contracts.ts
M	apps/api/src/modules/README.md
A	apps/api/src/modules/history/dto.ts
M	apps/api/src/modules/jobs/contracts.ts
M	apps/api/src/modules/jobs/dto.ts
M	apps/api/src/modules/jobs/service.ts
M	apps/api/src/modules/persistence/models.ts
A	apps/api/src/modules/riders/contracts.test.ts
A	apps/api/src/modules/riders/contracts.ts
A	apps/api/src/modules/riders/dto.ts
A	apps/api/src/modules/riders/router.ts
A	apps/api/src/modules/riders/service.ts
M	apps/api/src/server.ts
M	apps/api/test/integration/README.md
M	apps/api/test/integration/persistence.test.ts
A	apps/api/test/integration/riders.test.ts
M	apps/web/src/App.test.tsx
M	apps/web/src/App.tsx
M	docs/api-contract.md
M	docs/architecture.md
M	docs/delivery-plan.md
M	docs/engineering-notes.md
M	docs/requirements.md
A docs/rider-api.md
A docs/phase-4-report.md
```

## Remaining scope and next feature

Recommendation scoring/eligibility, atomic assignment/reservation, rider responses/timeouts, manual reassignment, delivery/cancellation actions, the operational React interface, public seeds and final presentation remain pending. The rider UI rows in traceability are still partial. Actor headers are demo attribution; reconciliation, production HA and a full configuration audit log are outside this phase. Docker/compose and browser walkthroughs remain unverified.

Next: Phase 5 on `feat/recommendations`, adding hard eligibility, explainable scores, deterministic simulated travel estimates and recommendation/no-candidate audit behavior. Stop here for Phase 4 review.
