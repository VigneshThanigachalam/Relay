# Phase 1 completion report

Phase 1 is complete within its requested scope: the original assignment has been read in full, the design is proposed, and the development foundation is implemented and verified. Business features remain pending. Stop here for user review before Phase 2.

## Files created

The repository contains 44 tracked files including this report. The complete list is below. The source DOCX is unchanged and its SHA-256 matches the attachment. The complete paragraph extraction provides stable source references. The requirements checklist contains 49 traceability rows covering functional requirements, invariants, edge cases, minimum tests, deliverables and user workflow constraints.

```text
.env.example
.gitattributes
.gitignore
.nvmrc
.prettierignore
.prettierrc.json
README.md
apps/api/package.json
apps/api/src/app.test.ts
apps/api/src/app.ts
apps/api/src/config/env.test.ts
apps/api/src/config/env.ts
apps/api/src/http/errors.ts
apps/api/src/infrastructure/database.ts
apps/api/src/modules/README.md
apps/api/src/server.ts
apps/api/test/integration/README.md
apps/api/tsconfig.build.json
apps/api/tsconfig.json
apps/api/vitest.config.ts
apps/web/index.html
apps/web/package.json
apps/web/src/App.test.tsx
apps/web/src/App.tsx
apps/web/src/features/README.md
apps/web/src/main.tsx
apps/web/src/styles.css
apps/web/src/test/setup.ts
apps/web/tsconfig.json
apps/web/vite.config.ts
compose.yaml
docs/api-contract.md
docs/architecture.md
docs/delivery-plan.md
docs/engineering-notes.md
docs/lifecycle.md
docs/phase-1-report.md
docs/requirements.md
docs/source/README.md
docs/source/assignment-extracted.txt
docs/source/assignment.docx
package-lock.json
package.json
tsconfig.base.json
```

## Architecture decisions ready to discuss

- A modular monolith in two npm workspaces: React/TypeScript/Vite frontend; Express/TypeScript API with Mongoose and Zod. No broker, Redis or separate services.
- Four proposed collections: jobs, riders, assignment attempts and append-only job events. A job's identity outlives every rider assignment attempt.
- Pending, accepted and picked-up attempts reserve rider load; only terminalization releases it. Separate rider counters require guarded multi-document transactions and a real replica set.
- Unique normalized order reference protects creation. A partial unique active-attempt index and guarded updates protect assignment; durable command keys support successful retry replay.
- Confirmation and expiry compete on the same pending attempt/job pointers in a transaction. Equality belongs to expiry; all release effects and audit records commit together.
- Persisted assignment expiry plus a polling worker allows startup recovery; a timer per job is not authoritative. Default response threshold is two hours; the reviewer can configure five seconds later.
- Hard eligibility precedes explainable lower-cost ranking using simulated travel, workload, priority and deadline risk. Overrides require a reason and cannot bypass eligibility.
- Audit infrastructure starts with the domain feature and is used by every subsequent mutation. The later history feature completes retrieval and presentation.

These are design commitments, not claims of implemented business behavior. Full model/index fields, scoring formula, concurrency strategy, status diagram, API drafts and ordered feature/commit plan are in the linked documents from README.

## Genuine Git history

Initialized main, then worked only on `chore/project-foundation`. Commits use the actual environment clock and the transparent local identity `Codex Implementation Agent <codex@local.invalid>`. There is no remote configured and no fabricated PR/history. The commits that preceded this report are:

| Actual full hash                           | Subject                                                           |
| ------------------------------------------ | ----------------------------------------------------------------- |
| `6c7ce13d67d496e40d94775191a1b643a88c77ac` | chore: establish relay repository and preserve assignment source  |
| `2a7e14ffee351cdc153d97e8c50f039a9f426795` | docs: map relay requirements architecture and lifecycle decisions |
| `0e73fb82912266491d45f98cf6db07ca6cb53c92` | chore: initialize frontend and backend workspace                  |
| `d6a95326e70d11dd585c5bb93a86de60213e781f` | test: cover foundation configuration http errors and react entry  |

This report is committed on the same foundation branch. After the report/format/link review, the verified branch is merged into main with `--no-ff`. The final report and merge hashes are visible in `git log --all --graph --oneline` and reported in the handoff message. The ZIP preserves `.git`, both branch refs and all real commits; dependencies/build outputs are excluded.

## Commands executed and observed results

| Command or verification                                                                      | Observed result                                                                               |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| DOCX ZIP/XML extraction of all body paragraphs including table cells; footnote/endnote check | Full assignment read; P001–P177 extraction; no additional notes present                       |
| SHA-256 comparison of preserved DOCX against upload                                          | Exact match                                                                                   |
| `git --version`; `node --version`; `npm --version`                                           | Git 2.51.1; Node v24.19.0; npm 11.9.0                                                         |
| `command -v mongod`; `command -v docker`; browser executable probe                           | No MongoDB server, Docker, Chromium or Chrome executable found                                |
| `npm ping --fetch-retries=0 --fetch-timeout=15000`                                           | Registry responded successfully                                                               |
| `npm install --fetch-retries=0 --fetch-timeout=30000`                                        | 275 packages installed; lockfile generated                                                    |
| `npm ls --depth=0`                                                                           | Workspace/dependency graph resolved, exit 0                                                   |
| `npm run format`                                                                             | Source/config/docs formatted successfully                                                     |
| `npm run typecheck`                                                                          | API and web checks passed                                                                     |
| `npm test`                                                                                   | API: 19 passed; web: 1 passed; 20 total, 3 files                                              |
| `npm run build`                                                                              | API tsc and web Vite production builds passed                                                 |
| `npm run check`                                                                              | Combined format check, both typechecks, all 20 tests and both builds passed, exit 0           |
| Node built-app HTTP smoke using createApp + actual loopback requests                         | live 200; ready 503 without DB; unimplemented jobs route 404                                  |
| `MONGODB_URI='mongodb://127.0.0.1:1/relay?replicaSet=rs0' node apps/api/dist/server.js`      | Intentional unreachable-DB test: safe startup error and exit 1; no false ready server         |
| `npm run dev:web`                                                                            | Vite reported startup on 5173; later stopped via Ctrl-C                                       |
| Separate `curl --fail --silent --show-error http://127.0.0.1:5173/`                          | Failed connection, exit 7; not recorded as a successful UI check                              |
| Same-process Vite createServer + fetch smoke on 5174                                         | Index HTML and transformed React component both HTTP 200 with expected text; clean close      |
| Local Markdown target check                                                                  | The only initial missing target was this not-yet-created report; checked again after creation |
| `git diff --check`; staged diff checks before commits                                        | Passed; no whitespace errors                                                                  |
| `git init -b main`, `git switch -c chore/project-foundation`, staged Conventional Commits    | Actual commits listed above, one in-progress branch                                           |

The npm host configuration emits an unknown `http-proxy` warning; installation and checks still passed. jsdom's transitive whatwg-encoding package emitted a deprecation warning. These are not hidden as test failures. No dependency security-audit result is claimed. No browser visual walkthrough or real MongoDB connection was verified. The same-process smoke is HTTP/module serving evidence, not browser rendering evidence.

## Blockers and next feature

MongoDB and Docker are unavailable here. The compose recipe is unexecuted. Phase 2 requires actual replica-set verification for indexes, transactions and rollback; in-memory mocks cannot prove these guarantees. Git, Node, npm and dependency installation are available. No business acceptance test is marked complete.

Next: `feat/domain-models` — implement schemas, explicit indexes, domain types and state rules, add replica-set capability checks and real schema/index/transaction tests. Do not start that branch until the user approves moving to Phase 2. Future deliverables still include actual seeded jobs/riders, end-to-end API/UI workflows, timeout worker, finalized API/design docs, known limitations reconciliation and the single-page solution PDF.
