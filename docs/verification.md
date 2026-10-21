# Final verification

The original assignment remains unchanged in the development handoff; its source files are excluded from the public repository. All 49 checklist rows retain paragraph references. Functional/submission requirements are implemented; Q01 records the planning target without fabricating receipt time or measured human effort. Historical phase reports are snapshots of earlier work.

## Automated verification

Latest `npm run check` after the interface refinement passed (2026-10-19):

| Check                                  | Actual result                  |
| -------------------------------------- | ------------------------------ |
| Prettier repository check              | Passed                         |
| API and React strict TypeScript checks | Both passed                    |
| API Vitest/Supertest                   | **551 passed**, 22 test files  |
| React Testing Library                  | **26 passed**, 2 test files    |
| Total automated tests                  | **577 passed**                 |
| API TypeScript production build        | Passed                         |
| Vite production build                  | Passed; 41 transformed modules |

Tests launch actual MongoDB **8.0.17**, WiredTiger, disposable single-node replica sets; a standalone rejection scenario also uses an actual process. They exercise unique indexes, transaction rollback, real concurrent writes, guarded reservations, decision/expiry races, capacity release, retained history, lost-reply fault injection and seeded reviewer workflows. They never point at a user database. Pure unit tests cover ranking/rounding, transitions, schemas, validation and scheduler timing. Fault injection and controlled gates do not claim a real network partition/failover test.

Focused phase checks also passed: delivery 19 tests; dashboard 8; React 15; seeded reviewer suite 3. Phase 9 full check had 541 tests; Phase 10 had 563; Phase 11 adds the three seeded end-to-end checks. The interface refinement adds eleven frontend regressions to the original fifteen. The current total is the sum above, not cumulative addition across repeated runs.

At the initial handoff, a fresh checkout of the committed implementation was separately extracted into a new directory. `npm ci --no-audit --no-fund`, both TypeScript checks and both production builds passed there, without copying node_modules or build output.

## Initial handoff: compiled API and browser walkthrough

The documented `npm run seed` was executed twice against a fresh disposable real replica set. First run created 5 riders/13 jobs; the second created none and preserved work. The compiled `apps/api/dist/server.js` ran with threshold 5,000 ms and scan interval 200 ms for this verification. Vite served the actual React application at 127.0.0.1:5173, proxying to API port 4000.

**Chromium 153** completed these actual interactions with zero page errors:

1. Create a job in the form, mark ready, inspect scores, choose a different eligible rider with a reason, assign, accept, pick up and deliver.
2. Reject an assignment with a reason, investigate manual state, reassign with a new attempt and accept.
3. Leave a new assignment unanswered for five seconds; the real worker moves it to manual and GET polling updates the screen. Reassign, accept, pick up and deliver.
4. Confirm the API history agrees: EXPIRED then DELIVERED attempts, REASSIGNED event and system:timeout-worker actor.
5. Cancel a NEW job, edit a rider's name and save configuration. Check every rider's counters against actual active attempts after the workflow.
6. Independently verify no-candidate manual display, rider workload and a 390-pixel mobile viewport. Desktop/mobile screenshots were visually inspected. reviewer-demo.png records the final seeded desk.

Startup automatically expired DEMO-OVERDUE without manual database edits. API and worker were gracefully terminated after the walkthrough. The final smoke's first attempt used an incorrect case-sensitive test selector (`Jobs` instead of the accessible `jobs`); the selector was corrected, then the complete fresh run passed. This was a verification harness error, not a production change.

Standard Playwright browser download returned a truncated ZIP. A packaged Chromium binary from npm was unpacked without ownership changes and used successfully with the available Playwright runtime. Browser tooling remains external to application dependencies. The Phase 10 screenshot and the final reviewer screenshot contain real disposable demo data, not mocked UI content.

## Documents and repository

The solution PDF is exactly **one page** (pdfinfo), uses embedded fonts and was rendered with pdftoppm and visually inspected after layout corrections. Its source generator is scripts/render-solution.py; optional regeneration needs Python/reportlab and DejaVu Sans fonts. Running the app requires none of those tools. API documentation was reconciled with implemented routers. Architecture includes components, models, indexes, lifecycle, races and timeout/retry boundaries. Engineering notes list exactly three next improvements.

Each feature was developed on one branch at a time, with genuine Conventional Commits and checked merges. No author, timestamp, test pass, PR or remote push was invented. See github-publication.md for the later publication boundary. Local identity is Codex Implementation Agent <codex@local.invalid>. The final handoff includes all source and the complete local Git history. Its HANDOFF.md supplies the final main merge hash and restoration evidence without creating a self-referential commit hash inside its own commit.

## Explicit limits

Docker was unavailable, so compose remains unexecuted. Actual MongoDB verification does not imply Docker verification. No deployment, authenticated account integration, production failover/load test is supplied. GitHub publication is documented separately. Polling has scan/processing/UI latency; full-fleet recommendations and snapshot storage suit a small operation. Privileged DB writes can bypass Mongoose audit guards. Failure-audit crash windows, worker starvation risks and other operating limits are documented in engineering-notes.md.

## Post-handoff seed diagnostics

The original seed CLI hid every cause behind one generic message. The diagnostic fix records configuration/database/demo-scenario stage and the original error name/message, redacting MongoDB URI text and avoiding full driver-object dumps. This changes diagnostics only. API TypeScript checking and an actual CLI smoke passed: missing URI reports its configuration field; a credential-bearing malformed URI is not exposed; seeding an initially nonexistent database on a real MongoDB 8.0.17 replica set creates five riders/thirteen jobs; rerunning preserves all thirteen. The initial 566-test run predated this logging-only fix; the later full interface-refinement check includes the updated source.

## Interface refinement verification

The full check was rerun after the UI changes: formatting, API/web TypeScript, **551 API + 26 web = 577 tests**, and both builds passed. The frontend cases include five resource-hook regressions and twenty-one interface interactions. New cases protect retained table DOM during refresh, unsaved rider inputs, old-GET versus mutation ordering, persistent read failures, action-specific pending state, notification survival, failed-form input retention and focus restoration. No production dependency changed.

A fresh disposable real MongoDB 8.0.17 replica set was seeded, the compiled API ran on port 4000, and the Vite application ran on 5173. Verification used a **20,000 ms** response threshold and **300 ms** scan interval, without changing application defaults. Chromium 153 completed these eleven desktop check groups:

1. Delay the next queue read by 850 ms: the exact original row element stays mounted and visible; Refreshing is disabled; completion produces Workspace is up to date.
2. Edit Arun's name, focus the input and wait for real GET polling: the same element, unsaved value and focus remain. Saving through the API produces a notification inside the active native dialog.
3. Tab through the dialog without reaching background controls; Escape closes it and returns focus to the opener. Native browser-chrome/viewport focus during a Tab cycle is permitted.
4. Remove NORTH coverage from occupied Maya: the real API conflict keeps the attempted edit and displays Changes could not be saved. Closing discards only the unsaved local edit.
5. Create a job, delay creation/ready/assignment responses, observe disabled pending labels, inspect scores, select a non-top rider, supply the required reason, assign, accept, pick up and deliver. The real history contains MANUAL_OVERRIDE and delivered state; Activity & history renders it.
6. Reject an assignment, re-enter the manual workflow, reassign and finish delivery. API attempts retain REJECTED and DELIVERED.
7. Commit an assignment through a real request, deliberately abort its response, then recover it from Retry exact assignment. Captured retry key and payload exactly equal the original; the recovered assignment completes normally.
8. Let a new assignment expire through the actual worker and wait for GET polling. History records EXPIRED with system:timeout-worker; reassignment completes with a separate DELIVERED attempt.
9. Cancel a NEW job with a reason and inspect the explicit no-eligible-rider display.
10. Inject one 503 queue read: keep the successful table visible, report the failed refresh, and recover through Retry read.
11. Reconcile every rider's reserved units and active-job count against actual active attempts.

The desktop workflow recorded **one main-frame navigation** (initial load only) and zero page errors. The forced lost response and 503 were deliberate verification faults. A subsequent 390 × 844 browser run separately passed page-width equality, scrolling to/opening an order, a dialog bounded by viewport width, `prefers-reduced-motion` animation removal and Escape dismissal, with zero page errors. Fresh desktop/drawer/rider/mobile captures were visually inspected internally; no new screenshots are distributed as deliverables.

Verification corrections are recorded honestly: an extraction refactor omitted a helper import, which TypeScript caught and was fixed; the first keyboard run exposed missing opener restoration after React unmount, now fixed with an RTL regression and real browser confirmation. Early browser harness runs needed exact/scoped selectors and the actual MANUAL_OVERRIDE event name. A late screenshot capture timed out, and an offscreen mobile click in the combined run timed out. A separate foreground mobile run explicitly scrolled to the order and passed; the failed combined run is not reported as an overall pass. Automated checks and completed desktop assertions remain independently recorded above.

The Windows local seed failure reported in the conversation remains unverified because its underlying diagnostic was not supplied. This package includes the earlier stage-specific logging fix and clearer root-folder/Node/replica-set instructions; no claim is made that a separate Windows installation was repaired.

## Routed navigation and search follow-up — 21 October 2026

`npm run check` passed: Prettier, both TypeScript checks, **555 API + 35 web = 590 automated tests**, and both production builds. Four additional API integration cases exercise partial/case-insensitive literal search, filter combinations, exact-filter compatibility, validation and escaped regex characters against MongoDB 8.0.17. Web tests cover all direct routes and unknown-route recovery, URL sanitization/history/remount, debounce/pagination/clear, distinct Overview content, disabled queue reads and one-second refresh feedback. Existing assignment, timeout, idempotency and lifecycle suites continue to pass.

The final browser run passed **11 checks**, using real seeded MongoDB replica-set data, Express and Vite, with no page errors:

1. Root redirects to a distinct Overview with real summary panels and no delivery table.
2. Rapid partial/case-insensitive typing issues one debounced API search and returns the expected actual row.
3. Search/status combine correctly; both and the delivery route survive a full reload.
4. Rider name search matches real data, in addition to supported code search.
5. Back/Forward restore page and filters; the manual-queue deep link reloads.
6. A 1.6-second delayed response preserves the same fully opaque row DOM; pending feedback lasts until the real response.
7. A fast real read still shows at least one second of manual-refresh progress.
8. An injected 503 keeps successful rows, reports failure and recovers through Retry read.
9. The linked SVG favicon is served successfully with its image content type.
10. Unknown URLs provide a working recovery link.
11. At 390px, mobile links work, reload preserves Deliveries and the document has no horizontal overflow (the table scrolls internally).

Overview and mobile screenshots were visually inspected. This caught inherited button-only flex styling after converting navigation to links; explicit link layout and a styled Overview filter corrected it. The final web build and all eleven browser checks were rerun after that CSS correction. Filter selectors also received explicit accessible names. Earlier harness attempts encountered Chromium archive ownership restrictions and a selector that omitted the manual count badge; those attempts are not recorded as successful runs. Chromium was extracted without changing file ownership, and the corrected harness completed.

`npm audit --omit=dev` reports zero production vulnerabilities with React Router 7.18.4. An older trial version was upgraded after the audit flagged it; it is not in the submitted lockfile. Temporary Playwright/Chromium tools remain outside the application dependencies. Browser checks were run in this Linux environment; no claim is made about execution on the reviewer's Windows machine.
