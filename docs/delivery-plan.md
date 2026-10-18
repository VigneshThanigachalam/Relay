# Incremental delivery and commit plan

Phase 1 stops at the verified foundation. The following estimates are planning assumptions, not an effort log or delivery guarantee. The assignment targets 8–12 hours of implementation inside a 48-hour submission window; reserve time for review and explaining decisions. Future phases proceed only when the user requests them.

| Order | Feature branch (only one active at a time) | Meaningful commit examples                                                                                                                                           | Merge gate                                                    | Target hours |
| ----- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------ |
| 1     | chore/project-foundation                   | docs: map relay requirements and lifecycle decisions; chore: initialize frontend and backend workspace; test: verify foundation contracts and document setup         | Typecheck, production build, foundation tests, clean diff     | 1.0          |
| 2     | feat/domain-models                         | feat(domain): define job rider assignment and audit schemas; feat(db): add constraints and replica set checks; test(db): verify indexes and transaction rollback     | Actual replica-set schema/index/rollback tests                | 0.8          |
| 3     | feat/job-management                        | feat(jobs): implement job creation and duplicate prevention; feat(jobs): add filters detail and ready command; test(jobs): cover parallel duplicate submissions      | Job validation, API + database tests                          | 0.8          |
| 4     | feat/rider-management                      | feat(riders): manage availability capacity and workload; test(riders): guard occupied capacity and zones                                                             | Rider edit + eligibility inputs tested                        | 0.5          |
| 5     | feat/recommendations                       | feat(dispatch): implement rider eligibility and ranking; feat(history): record recommendation and no-candidate events; test(dispatch): explain scores and tie breaks | Pure ranking + no-candidate DB tests                          | 0.8          |
| 6     | feat/assignment-reservation                | feat(dispatch): reserve rider capacity atomically; feat(dispatch): record manual overrides and command replay; test(dispatch): cover concurrent assignment conflicts | Real parallel Supertest requests + rollback + capacity checks | 1.2          |
| 7     | feat/assignment-resolution                 | feat(dispatch): accept reject and expire pending attempts; feat(worker): recover overdue attempts on startup; test(dispatch): cover expiry races and release once    | Deterministic clock + DB race/restart tests                   | 1.0          |
| 8     | feat/manual-reassignment                   | feat(dispatch): expose manual queue and reassign failed jobs; test(dispatch): retain earlier attempts after reassignment                                             | Full expire/reject → reassign integration checks              | 0.4          |
| 9     | feat/delivery-lifecycle                    | feat(jobs): record pickup delivery and cancellation; test(jobs): enforce lifecycle and append-only audit                                                             | Lifecycle, cancellation races, history consistency tests      | 0.6          |
| 10    | feat/dispatch-interface                    | feat(ui): add dashboard filters and job history; feat(ui): add recommendations rider actions and manual queue; test(ui): cover error empty and conflict recovery     | RTL + browser reviewer workflow                               | 1.5          |
| 11    | docs/reviewer-submission                   | chore(seed): add reproducible review scenarios; test: verify end-to-end dispatch demonstration; docs: finalize api design notes and one-page solution                | Fresh setup, full suite, UI walkthrough, presentation render  | 1.0          |

Total target: approximately 9.6 hours, excluding review buffer. Actual time will differ. Keep presentation and polish bounded if reliability needs more time.

## Dependency adjustments

Audit infrastructure starts with domain models and is used in each feature rather than postponed until delivery lifecycle: an assignment must never land without history. Seeds begin as fixtures with schema work, then become a public seed command at submission. The manual transition implementation necessarily starts with recommendation/rejection/timeout; its own feature finishes listing/reassignment coverage. Configured timeout values exist in foundation; the worker remains feature 7. UI foundation is only a placeholder in Phase 1; the operational dashboard remains feature 10.

## Real Git workflow

1. Initialize `main` with the unchanged assignment and project identity.
2. Branch from clean main; document design and create the workspace incrementally. Stage only coherent changes and use Conventional Commits with real author/time. Commits made here identify the implementation agent, not a fabricated human author.
3. Write tests with each behavior; run relevant checks before committing a claimed feature and before merge. Failed tests prompt fixes and a rerun; never rewrite evidence as a pass.
4. Review diff, merge with `--no-ff`, retain the feature branch for review, confirm clean main, then create the next feature branch. Do not have multiple in-progress feature branches. No fabricated PRs or remote pushes.
5. Keep requirement statuses and actual test paths current as implementation progresses. A design document or test filename in a checklist does not make the feature complete.

Commands for each subsequent feature:

```bash
git switch main
git status --short
git switch -c feat/domain-models
# Implement and test coherent increments, then git add selected paths and commit.
npm run check
# Add real database integration checks when available.
git diff --check
git switch main
git merge --no-ff feat/domain-models -m "chore: merge verified domain models"
```

## Phase 1 boundary

Allowed: source extraction, requirement mapping, proposed schemas/contracts/ranking/lifecycle, tooling, configuration parsing, Express health/errors, React entry, local MongoDB compose recipe, foundation tests and verification report. Deferred: schemas/index creation, job/rider CRUD, ranking implementation, reservations, worker, seed jobs/riders, real dashboard, final presentation. The next feature is **domain models, database constraints and transaction verification**, subject to Phase 1 review.

## Phase 2 checkpoint

Completed on `feat/domain-models` after Phase 1 approval: focused code comments; pure job/attempt transitions and expiry/counter rules; four schemas and their indexes; typed audit/snapshot payloads and append-only model guards; replica-set/index/transaction readiness; real MongoDB integration tests. All changes use genuine commits. No job-management or later feature APIs are included. Next branch: `feat/job-management` after Phase 2 review. See `phase-2-report.md` for actual verification and limitations.
