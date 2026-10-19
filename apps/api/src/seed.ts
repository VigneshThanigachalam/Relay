import mongoose from 'mongoose';
import { parseEnv } from './config/env.js';
import { connectDatabase, disconnectDatabase } from './infrastructure/database.js';
import { seedDemo } from './modules/demo/seed.js';
import { createPersistenceModels } from './modules/persistence/models.js';
async function run() {
  const config = parseEnv(process.env);
  if (config.NODE_ENV === 'production') throw new Error('Demo seed is disabled in production');
  await connectDatabase(config.MONGODB_URI);
  const result = await seedDemo({
    connection: mongoose.connection,
    models: createPersistenceModels(mongoose.connection),
  });
  console.info(JSON.stringify(result, null, 2));
}
run()
  .catch(() => {
    console.error(
      'Demo seed failed. Check MongoDB, demo identity conflicts and rider configuration; existing records were not reset.',
    );
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase());
