# Project RELAY

The Autonomous Dispatch Desk technical assignment. **Implemented through Phase 5:** domain/database foundation, transactional job management, protected rider configuration/workload APIs, and explainable rider recommendations with audit snapshots and no-candidate Manual Queue handling. Assignment/reservation services, timeout worker, demo seeds and the operational dashboard remain pending. Next: atomic assignment and capacity reservation.

## Review the design

- [Requirements checklist and planned tests](docs/requirements.md)
- [System design and architecture diagram](docs/architecture.md)
- [Job and assignment lifecycle](docs/lifecycle.md)
- [Implemented job API and curl walkthrough](docs/job-api.md)
- [Implemented rider API and curl walkthrough](docs/rider-api.md)
- [Implemented recommendation API, scoring and curl walkthrough](docs/recommendation-api.md)
- [Full API contract](docs/api-contract.md) (future endpoints explicitly marked as proposed)
- [Feature branches, commits and delivery plan](docs/delivery-plan.md)
- [Assumptions, limitations and next improvements](docs/engineering-notes.md)
- [Original assignment and extraction](docs/source/README.md)
- [Phase 1 verification report](docs/phase-1-report.md) (historical)
- [Phase 2 verification and interview notes](docs/phase-2-report.md) (historical)
- [Phase 3 verification and interview notes](docs/phase-3-report.md) (historical)
- [Phase 4 verification and interview notes](docs/phase-4-report.md) (historical)
- [Phase 5 verification and interview notes](docs/phase-5-report.md)

## Prerequisites

Node.js **24.x** and npm **11.x** (`.nvmrc` selects 24). Git 2.x. Docker with Compose v2 is the easiest optional local MongoDB setup; alternatively provide MongoDB 8.x configured as a replica set or an Atlas development cluster. A standalone database is insufficient for the planned transaction-based workflow. The exact dependency graph is pinned by `package-lock.json`; use `npm ci` after checkout. The project does not require external paid integrations.

For Windows, commands below work in Git Bash/WSL; PowerShell users can use `Copy-Item .env.example .env`. Run npm commands from the repository root. To recover all local branches/history from the handoff ZIP, extract it including its `.git` directory; `git log --all --graph --oneline` shows the real history. No GitHub remote is configured. Commits identify the implementation agent transparently.

## Install and configure

```bash
npm ci
cp .env.example .env
```

The API loads the root `.env` using Node's native env-file option. Vite uses a local same-origin proxy; the browser does not receive the database URI. Keep credentials out of `VITE_*` variables and Git.

| Variable                         | Default/example                                | Purpose                                                                    |
| -------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------- |
| NODE_ENV                         | development                                    | development, test or production                                            |
| PORT                             | 4000                                           | API port, integer 1–65535                                                  |
| MONGODB_URI                      | mongodb://127.0.0.1:27017/relay?replicaSet=rs0 | Required MongoDB URI                                                       |
| ASSIGNMENT_RESPONSE_THRESHOLD_MS | 7200000                                        | Future worker response threshold (1,000–604,800,000 ms); default two hours |
| TIMEOUT_SCAN_INTERVAL_MS         | 5000                                           | Future worker poll interval (100–60,000 ms)                                |

Threshold/interval settings are validated now; no worker runs yet. A future reviewer demo will use threshold `5000` and interval `1000` before assigning a new job. Each future attempt stores its own expiry; restarting with a new threshold will not change existing attempts.

## Local database and startup

The compose file is intended for **local development only**, with MongoDB exposed on loopback and a named data volume. Its healthcheck initializes `rs0` once and waits for a writable primary. The advertised member is `localhost:27017`, because API and Vite run on the host. If you containerize the API later, this hostname setup must change. No authentication is configured in this local recipe.

```bash
docker compose up -d --wait
```

Docker is unavailable in the implementation environment, so this compose recipe remains **unverified**. Phase 2 tests launch a real temporary MongoDB 8.0.17 replica set through a development-only harness and verify actual indexes, transactions and startup checks. This is separate from Docker verification. For a manually managed instance, run `mongod --replSet rs0 --bind_ip 127.0.0.1 --dbpath <your-data-directory>` and initiate `rs0` in mongosh before starting the API. Do not run a second instance over the same port/data directory.

Run in two terminals:

```bash
# Terminal 1
npm run dev:api
```

```bash
# Terminal 2
npm run dev:web
```

Open `http://127.0.0.1:5173`. It displays a foundation screen only. The API waits for a successful real database connection before listening; missing MongoDB fails startup with a safe error rather than silently substituting memory storage. Before listening, startup verifies a writable replica set with session support, creates declared collections/indexes without dropping other indexes, and runs a real snapshot-transaction read. Standalone MongoDB or failed index creation prevents readiness.

```bash
curl http://127.0.0.1:4000/health/live
curl http://127.0.0.1:4000/health/ready
```

Liveness: 200 process status. Readiness: 200 initialized and connected, or 503 unavailable once running. The job, rider and recommendation endpoints in their API guides are implemented; other business endpoints return 404. Vite's proxy targets port 4000; if PORT changes, change the two proxy targets in `apps/web/vite.config.ts` as well.

Production compilation and API start:

```bash
npm run build
npm start
```

The web build lands in `apps/web/dist`; preview with `npm run preview --workspace @relay/web`. Vite preview does not proxy API requests. Production static hosting/reverse proxy is deferred with deployment, which the assignment makes optional.

## Verification

```bash
npm run check
```

Runs Prettier format check, TypeScript checks for both applications, Vitest/Supertest/React Testing Library tests, and both production builds. Individual commands: `npm run format:check`, `npm run typecheck`, `npm test`, `npm run build`. Watch mode: `npm run test:watch --workspace @relay/api` (or `@relay/web`). Prettier is the only formatting tool; this phase does not claim ESLint coverage.

Foundation tests cover HTTP/error envelopes, configuration and UI phase labeling. Domain/schema tests cover lifecycle, local invariants and typed audit details. The integration suite launches actual `mongod` processes: a temporary single-node replica set for indexes/transactions and a standalone instance for the rejection check. It verifies parallel unique-index collisions, active-attempt protection, retained expired attempts, append-only mutation guards, four-record rollback, startup readiness and index failures. Phase 3 adds real HTTP integration tests for duplicate/key conflicts, concurrent creates, concurrent ready commands, audit rollback, unknown commit recovery, DTO privacy, filters and history. Phase 4 adds real rider HTTP tests, including controlled stale-read/counter-write races for configuration edits. Phase 5 adds pure eligibility/scoring tests and real recommendation HTTP tests for audit snapshots, no candidates, rollback, concurrent evaluations and job-state conflicts. Full assignment/capacity-release races remain pending.

The first test run downloads a roughly 100 MB MongoDB 8.0.17 binary and needs network access. Later runs reuse its cache. The harness uses disposable WiredTiger data directories and never loads or drops `MONGODB_URI`. It disables Unix sockets and uses TCP. It fails if MongoDB cannot start; it does not silently skip database tests or replace them with mocks. To use an existing matching executable, configure the harness-supported `MONGOMS_SYSTEM_BINARY` environment variable. `MONGOMS_VERSION` can override the test version; the verified default is 8.0.17. These are test-harness settings, not API configuration.

The API's schema validation is not a substitute for transaction predicates: Mongoose document validation hooks do not run for arbitrary query updates. Later services must use guarded updates with sessions and field validators where applicable. MongoDB unique indexes enforce identity and active-attempt constraints even during concurrent inserts; cross-document job/rider/attempt consistency belongs to the services still to be implemented.

## Current API demonstrations

After starting a real replica set and the API, follow [docs/job-api.md](docs/job-api.md#curl-walkthrough). It creates a job, replays it, marks it ready, filters the list and reads its history without manual database edits. Job mutations require `X-Actor-Id`; this supplies demo attribution, not authentication. For rider creation, exact-code lookup, coverage/availability filtering and configuration updates, follow [docs/rider-api.md](docs/rider-api.md#curl-walkthrough). For ranking and the no-candidate Manual Queue path, follow [docs/recommendation-api.md](docs/recommendation-api.md#curl-walkthrough). The current React screen is a phase indicator, not the operational dashboard.

## Reviewer workflow and remaining submission work

The full [reviewer demonstration](docs/requirements.md#reviewer-demonstration-planned-for-the-final-phase) will cover create/replay → ready → recommend/override → assign → accept → pickup → deliver, plus reject/timeout → manual → reassignment. The reviewer must be able to run it without database edits. The seed command, complete demonstration instructions, final API examples and one-page solution PDF will be added after business features work. There is no public seed command yet; test fixtures are not the reviewer demo data.

Libraries beyond the requested stack: `tsx` runs API TypeScript in development; `@vitejs/plugin-react` handles React development/build integration; `jsdom` provides the RTL DOM; type packages provide compile-time types; Prettier gives reproducible formatting; development-only `mongodb-memory-server-core` launches real temporary MongoDB processes for repeatable database tests (no install-time binary download). No routing/state framework, Redis, Kafka or microservice infrastructure is introduced.
