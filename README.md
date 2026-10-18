# Project RELAY

The Autonomous Dispatch Desk technical assignment. **Phase 1 only:** requirements, design, Git workflow and a verified React/Express TypeScript foundation. There are no business endpoints, domain schemas, seeded jobs/riders, reservation worker or operational dashboard yet. The next feature is domain models and database constraints after user review.

## Review the design

- [Requirements checklist and planned tests](docs/requirements.md)
- [System design and architecture diagram](docs/architecture.md)
- [Job and assignment lifecycle](docs/lifecycle.md)
- [API contract draft](docs/api-contract.md) (health routes implemented; business routes proposed)
- [Feature branches, commits and delivery plan](docs/delivery-plan.md)
- [Assumptions, limitations and next improvements](docs/engineering-notes.md)
- [Original assignment and extraction](docs/source/README.md)
- [Phase 1 verification report](docs/phase-1-report.md)

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

Threshold/interval settings are validated now; no worker runs in Phase 1. A future reviewer demo will use threshold `5000` and interval `1000` before assigning a new job. Each future attempt stores its own expiry; restarting with a new threshold will not change existing attempts.

## Local database and startup

The compose file is intended for **local development only**, with MongoDB exposed on loopback and a named data volume. Its healthcheck initializes `rs0` once and waits for a writable primary. The advertised member is `localhost:27017`, because API and Vite run on the host. If you containerize the API later, this hostname setup must change. No authentication is configured in this local recipe.

```bash
docker compose up -d --wait
```

Docker/MongoDB are unavailable in the implementation environment, so this compose startup recipe is **not verified here**. Do not infer database test coverage from HTTP health tests. For a manually managed instance, run `mongod --replSet rs0 --bind_ip 127.0.0.1 --dbpath <your-data-directory>` and initiate `rs0` in mongosh before starting the API. Do not run a second instance over the same port/data directory.

Run in two terminals:

```bash
# Terminal 1
npm run dev:api
```

```bash
# Terminal 2
npm run dev:web
```

Open `http://127.0.0.1:5173`. It displays a foundation screen only. The API waits for a successful real database connection before listening; missing MongoDB fails startup with a safe error rather than silently substituting memory storage. Database connection readiness is currently checked, not transaction capability/index readiness (Phase 2).

```bash
curl http://127.0.0.1:4000/health/live
curl http://127.0.0.1:4000/health/ready
```

Liveness: 200 process status. Readiness: 200 connected or 503 disconnected once running. Unimplemented `/api/v1` endpoints return 404. Vite's proxy targets port 4000; if PORT changes, change the two proxy targets in `apps/web/vite.config.ts` as well.

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

Foundation tests cover safe HTTP/error envelopes, true dependency readiness via an injected probe, malformed/oversized JSON, validated configuration and honest UI phase labeling. They do **not** simulate database concurrency. Future integration tests must use an isolated real MongoDB replica-set database and real indexes. The minimum business test obligations are recorded in the requirements checklist; they are all pending.

## Reviewer workflow and remaining submission work

The full [reviewer demonstration](docs/requirements.md#reviewer-demonstration-planned-for-the-final-phase) will cover create/replay → ready → recommend/override → assign → accept → pickup → deliver, plus reject/timeout → manual → reassignment. The reviewer must be able to run it without database edits. The seed command, complete demonstration instructions, final API examples and one-page solution PDF will be added after business features work. There is no seed command to run in Phase 1.

Libraries beyond the requested stack: `tsx` runs API TypeScript in development; `@vitejs/plugin-react` handles React development/build integration; `jsdom` provides the RTL DOM; type packages provide compile-time types; Prettier gives reproducible formatting. No routing/state framework, Redis, Kafka or microservice infrastructure is introduced.
