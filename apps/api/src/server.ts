import { createApp } from './app.js';
import { parseEnv } from './config/env.js';
import { connectDatabase, disconnectDatabase, isDatabaseReady } from './infrastructure/database.js';

async function start() {
  const config = parseEnv(process.env);
  await connectDatabase(config.MONGODB_URI);
  const server = createApp({ isReady: isDatabaseReady }).listen(config.PORT, () => {
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
