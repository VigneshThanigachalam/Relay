import { createDashboardService } from './modules/dashboard/service.js';
import mongoose from 'mongoose';
import { createDeliveryService } from './modules/delivery/service.js';
import { createJobsService } from './modules/jobs/service.js';
import { createRidersService } from './modules/riders/service.js';
import { createRecommendationsService } from './modules/recommendations/service.js';
import { createDispatchService } from './modules/dispatch/service.js';
import { createResolutionService } from './modules/dispatch/resolution.js';
import { createTimeoutScanner } from './modules/worker/timeout-scanner.js';
import { startTimeoutWorker } from './modules/worker/timeout-worker.js';
import { createManualQueueService } from './modules/manual-queue/service.js';
import { createPersistenceModels } from './modules/persistence/models.js';
import { createApp } from './app.js';
import { parseEnv } from './config/env.js';
import { connectDatabase, disconnectDatabase, isDatabaseReady } from './infrastructure/database.js';

async function start() {
  const config = parseEnv(process.env);
  // Fail before listening when persistence is unavailable. A successful HTTP
  // startup must never imply that we silently switched to in-memory storage.
  await connectDatabase(config.MONGODB_URI);
  const models = createPersistenceModels(mongoose.connection);
  const jobs = createJobsService({ connection: mongoose.connection, models });
  const riders = createRidersService({ connection: mongoose.connection, models });
  const recommendations = createRecommendationsService({ connection: mongoose.connection, models });
  const dispatch = createDispatchService({
    connection: mongoose.connection,
    models,
    responseThresholdMs: config.ASSIGNMENT_RESPONSE_THRESHOLD_MS,
  });
  const delivery = createDeliveryService({ connection: mongoose.connection, models });
  const resolution = createResolutionService({ connection: mongoose.connection, models });
  const manualQueue = createManualQueueService({ connection: mongoose.connection, models });
  const scanner = createTimeoutScanner({ models, resolution });
  let worker: ReturnType<typeof startTimeoutWorker> | undefined;
  let stopping = false;
  const server = createApp({
    isReady: isDatabaseReady,
    jobs,
    riders,
    recommendations,
    dispatch,
    resolution,
    manualQueue,
    delivery,
    dashboard: createDashboardService({ connection: mongoose.connection, models }),
  }).listen(config.PORT, () => {
    if (!stopping)
      worker = startTimeoutWorker({
        scan: scanner.scan,
        intervalMs: config.TIMEOUT_SCAN_INTERVAL_MS,
      });
    console.info(`RELAY API listening on port ${config.PORT}`);
  });
  server.on('error', () => {
    console.error('HTTP server failed to listen');
    void Promise.resolve(worker?.stop())
      .then(() => disconnectDatabase())
      .catch(() => {})
      .finally(() => {
        process.exitCode = 1;
      });
  });
  const stop = () => {
    if (stopping) return;
    stopping = true;
    // Stop accepting HTTP work before disconnecting the database; give existing
    // requests a bounded drain period so shutdown cannot hang indefinitely.
    const forceExit = setTimeout(() => process.exit(1), 10000).unref();
    // Stop polling now and let the current attempt transaction finish. Scanner
    // checks this stop signal between attempts, rather than draining a full batch.
    const workerStopped = worker?.stop();
    server.close(() => {
      void Promise.resolve(workerStopped)
        .then(() => disconnectDatabase())
        .then(() => {
          clearTimeout(forceExit);
          process.exitCode = 0;
        })
        .catch(() => {
          process.exitCode = 1;
        });
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

start().catch(async () => {
  console.error('API startup failed: check configuration and MongoDB replica-set availability');
  await disconnectDatabase();
  process.exitCode = 1;
});
