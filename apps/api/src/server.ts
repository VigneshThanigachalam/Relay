import mongoose from 'mongoose';
import { createJobsService } from './modules/jobs/service.js';
import { createPersistenceModels } from './modules/persistence/models.js';
import { createApp } from './app.js';
import { parseEnv } from './config/env.js';
import { connectDatabase, disconnectDatabase, isDatabaseReady } from './infrastructure/database.js';

async function start() {
  const config = parseEnv(process.env);
  // Fail before listening when persistence is unavailable. A successful HTTP
  // startup must never imply that we silently switched to in-memory storage.
  await connectDatabase(config.MONGODB_URI);
  const jobs = createJobsService({
    connection: mongoose.connection,
    models: createPersistenceModels(mongoose.connection),
  });
  const server = createApp({ isReady: isDatabaseReady, jobs }).listen(config.PORT, () => {
    console.info(`RELAY API listening on port ${config.PORT}`);
  });
  server.on('error', () => {
    console.error('HTTP server failed to listen');
    void disconnectDatabase().finally(() => {
      process.exitCode = 1;
    });
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    // Stop accepting HTTP work before disconnecting the database; give existing
    // requests a bounded drain period so shutdown cannot hang indefinitely.
    const forceExit = setTimeout(() => process.exit(1), 10000).unref();
    server.close(() => {
      void disconnectDatabase()
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
