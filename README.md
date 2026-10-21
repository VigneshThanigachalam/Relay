# Project RELAY

A working autonomous dispatch desk built with React, TypeScript, Vite, Express, MongoDB/Mongoose and Zod. Dispatchers create jobs, inspect explainable rider scores, reserve capacity, simulate rider responses, investigate exceptions and complete deliveries. An in-process worker expires unanswered assignments automatically. All eleven development phases are implemented; [verification](docs/verification.md) separates tested behavior from environment limitations.

The interface has real React Router pages: `/overview`, `/deliveries`, `/manual-queue` and `/riders`. The root redirects to Overview; unknown URLs offer a recovery link. Page, search, zone, status and pagination live in the URL, so reload and Back/Forward restore the view.

The refined interface keeps queue rows visible during background refresh, preserves unsaved rider edits, and shows action-specific progress plus success/error notifications. Details open in a keyboard-accessible side panel. See [interface decisions and requirement review](docs/ui-review.md).

## Run locally

Prerequisites: **Node 24.x, npm 11.x**, Git and **MongoDB 8.x configured as a writable replica set** (local or Atlas). A standalone MongoDB instance cannot run the required transactions. Docker Compose v2 is an optional local recipe; no paid integrations are required.

```bash
npm ci
cp .env.example .env
# Optional local database, if Docker is installed:
docker compose up -d --wait
# With the configured replica set available:
npm run seed
```

Run in two terminals from the repository root:

```bash
npm run dev:api
```

```bash
npm run dev:web
```

Open **http://127.0.0.1:5173**. Vite proxies `/api` and `/health` to the API at port 4000. The root `.env` is loaded by Node; database credentials are never browser configuration. Windows users can use Git Bash/WSL or `Copy-Item .env.example .env` in PowerShell. Run every npm command from the folder containing the root `package.json`, for example:

```powershell
Set-Location "C:\path\to\project-relay"
node --version
npm --version
npm ci
npm run seed
```

Use Node 24.x/npm 11.x and configure the root `.env` first. With an existing local MongoDB service, Docker is unnecessary: use its writable `rs0` replica set and `MONGODB_URI=mongodb://localhost:27017/relay?replicaSet=rs0`. Compass is a client for that service. The database is created by the first successful seed writes; creating an empty database manually is unnecessary. If seed fails, its message identifies the configuration, connection/initialization or demo-scenario stage and the underlying error. Resolve that cause before starting the UI. An `esbuild.exe` file-lock error during `npm ci` requires closing the project's running Vite/esbuild process before retrying installation; a partial install cannot run the seed.

The seed creates **5 riders and 13 jobs**, including ready, rejected, no-candidate, accepted, delivered and cancelled scenarios. `DEMO-OVERDUE` is a real pending attempt created with an injected historical clock; the startup worker expires it automatically. `DEMO-DEADLINE` illustrates overdue attention. Seed mutations use the normal transaction services, with complete attempts/history. Rerunning preserves existing demo identities, rider edits and progressed jobs; it never drops data or resets work. Use a fresh development database name in MONGODB_URI for a fresh demonstration. Do not use the DEMO-* identity prefix for unrelated data. Run one seed process at a time; interruption can leave a valid partially progressed scenario to finish through the UI. The seed is disabled for NODE_ENV=production.

The compose recipe exposes MongoDB only on loopback with a named volume and no authentication. It advertises `localhost:27017` because API and Vite run on the host. **Docker was unavailable here, so this recipe has not been executed.** Real MongoDB replica-set startup, indexes and transactions were verified separately. Alternatively start `mongod --replSet rs0 --bind_ip 127.0.0.1 --dbpath <data-directory>` and initiate rs0 in mongosh, or supply an Atlas development URI. Do not share a mongod data directory between processes.

## Configuration

| Variable                         | Default                                        | Meaning                                             |
| -------------------------------- | ---------------------------------------------- | --------------------------------------------------- |
| NODE_ENV                         | development                                    | development/test/production                         |
| PORT                             | 4000                                           | API listen port                                     |
| MONGODB_URI                      | mongodb://127.0.0.1:27017/relay?replicaSet=rs0 | Writable MongoDB replica set                        |
| ASSIGNMENT_RESPONSE_THRESHOLD_MS | 7200000                                        | Default two hours; 1,000–604,800,000 ms             |
| TIMEOUT_SCAN_INTERVAL_MS         | 5000                                           | Poll delay after each completed scan; 100–60,000 ms |

Changing the threshold affects new assignments only. For a fresh live timeout, set threshold `5000` and interval `1000`, restart the API and assign `DEMO-TIMEOUT`. Do not respond: it enters manual on the next successful scan, then appears after the UI's next five-second refresh. Use the default threshold for the main interactive delivery demo; five seconds leaves little time to inspect scores and click acceptance.

The API verifies replica-set/session support, a writable primary, declared indexes and a real transaction before listening. Missing/incompatible MongoDB fails startup; no memory substitute is used. `/health/live` reports process liveness; `/health/ready` reports initialized database connectivity, not worker lag. If PORT changes, change Vite's two proxy targets too.

## Reviewer demonstration

1. Start from seeded data. Inspect count cards and attention jobs. Open Deliveries, search a partial order reference, filter status/zone, then clear filters. Overview contains status totals, exception shortcuts and a fleet snapshot; Deliveries contains the full operational queue.
2. **New job**: create `REVIEW-001` with CENTRAL → NORTH, load 2 and NORMAL priority. Submit the same details again to see reference replay, then open the one job and **Mark ready**.
3. **Review recommendations**: inspect travel/workload/deadline components and excluded riders. Unavailable Lena, wrong-coverage Noah and occupied Isha cannot take this job. Select a different eligible rider and enter an operational reason to demonstrate an override; **Assign selected rider**.
4. **Accept assignment** simulates the selected rider. **Record pickup**, then **Complete delivery**. Open Riders to verify released capacity, and inspect the job's events and stored attempt snapshot. A network/503 assignment failure offers **Retry exact assignment**, retaining the command key and payload.
5. Open `DEMO-REJECT`, recommend/assign, enter a reason and **Reject assignment**. Inspect its manual queue row: reason, age and retained attempt. Open it, review recommendations and **Reassign selected rider**. Accept and finish delivery. Previous attempts remain in history.
6. Investigate automatically expired `DEMO-OVERDUE` in Manual queue. Its expired attempt, release timestamp and system actor explain startup recovery. Reassign it with the same UI workflow. For a fresh timed demonstration use the short-threshold configuration above.
7. Open `DEMO-NO-CANDIDATE` to inspect exclusions and no-candidate handling. Cancel `DEMO-NEW` with a reason. View/edit rider availability/capacity/coverage and active workload. Occupied capacity and active coverage cannot be removed.

No manual database edits are needed. Search is case-insensitive and partial: order reference for deliveries, name or code for riders. Typing waits 350 ms before requesting; Search submits immediately. Exact normalized reference/code filters remain available in the API. A zone filter matches job pickup OR destination; rider zone filtering matches coverage. Awaiting assignment counts NEW + READY; in progress counts ACCEPTED + PICKED_UP; manual is separate. Dates display in the operator's locale. Recommendations are audited commands, so only GETs poll automatically.

## Verify and build

```bash
npm run check
# Separately if needed:
npm run typecheck
npm test
npm run build
npm start
```

`check` runs Prettier, both TypeScript checks, Vitest/Supertest/React Testing Library suites and both production builds. Real database integration tests launch disposable MongoDB 8.0.17 WiredTiger replica sets, including actual transactions/indexes and concurrent requests. The first test run downloads roughly 100 MB; later runs use the cache. `MONGOMS_SYSTEM_BINARY` can point to a matching existing binary. The harness never reads/drops MONGODB_URI, never silently skips database checks and never emulates MongoDB. Fake timers test worker scheduling; fault injection tests uncertain replies and deterministic races without claiming a real network partition.

Production API code is in `apps/api/dist`; frontend assets are in `apps/web/dist`. Vite preview does **not** proxy the API. Production hosting/reverse proxy and deployment are optional and not supplied. The demonstrated local workflow uses Vite dev server plus the API. No authentication is implemented: `dispatcher:demo`, simulated rider IDs and system actors supply visible demo attribution.

## Engineering review

- [Requirement-by-requirement implementation/test traceability](docs/requirements.md)
- [Architecture, models, indexes and concurrency decisions](docs/architecture.md)
- [Lifecycle and reservation rules](docs/lifecycle.md)
- [API overview and errors](docs/api-contract.md), with complete feature guides linked there
- [Engineering notes and exactly three next improvements](docs/engineering-notes.md)
- [One-page manager presentation](docs/solution-one-page.pdf)
- [Actual verification and limitations](docs/verification.md)
- [Incremental delivery and branch plan](docs/delivery-plan.md); historical phase reports remain in docs
- Original assignment and paragraph extraction are supplied separately in the development handoff; they are excluded from this public repository.

This is a modular monolith: thin HTTP controllers, transaction-owning services, pure ranking/lifecycle functions and four workflow collections. Shared helpers cover audit allocation and capacity release. Comments explain non-obvious predicates, retries and boundaries. Native fetch/React state keep the small UI understandable. Additional dependencies beyond the requested stack serve development and verification: tsx, Vite's React plugin, jsdom, type packages, Prettier and mongodb-memory-server-core (which launches real mongod).

The handoff ZIP includes `.git` and all retained feature branches. Extract hidden files too, then run `git log --all --graph --oneline`. Commits use the transparent local identity **Codex Implementation Agent <codex@local.invalid>**. The public repository is [VigneshThanigachalam/Relay](https://github.com/VigneshThanigachalam/Relay). Publishing through the GitHub connection creates new publication commits on the existing remote history; the exact local feature commits remain in the handoff ZIP. See [publication notes](docs/github-publication.md). Configure your own author for future local commits. No deployment is supplied.

## Updating and hosting the interface

After pulling this update, run `npm ci` from the repository root before restarting `npm run dev:api` and `npm run dev:web`: React Router 7.18.4 is a new production dependency, justified by real page routing and browser history support. The application still uses the existing resource hooks and Express API rather than adding another data layer.

Manual Refresh keeps its progress indicator visible for at least one second, and longer if real reads are still pending. Successful rows remain mounted at full opacity; completion reports success or a read error. The SVG favicon is served from the web public directory.

Vite development/preview supports direct route requests. A production frontend host must fall back to `index.html` for frontend page URLs (for example `/deliveries`) while preserving static assets and `/api` routing. Express remains the API server; deployment configuration is not supplied.
