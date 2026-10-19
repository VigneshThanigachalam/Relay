import mongoose from 'mongoose';
import { parseEnv } from './config/env.js';
import { connectDatabase, disconnectDatabase } from './infrastructure/database.js';
import { seedDemo } from './modules/demo/seed.js';
import { createPersistenceModels } from './modules/persistence/models.js';
let stage = 'configuration';
async function run() {
  const config = parseEnv(process.env);
  if (config.NODE_ENV === 'production') throw new Error('Demo seed is disabled in production');
  stage = 'database connection and initialization';
  await connectDatabase(config.MONGODB_URI);
  stage = 'demo scenarios';
  const result = await seedDemo({
    connection: mongoose.connection,
    models: createPersistenceModels(mongoose.connection),
  });
  console.info(JSON.stringify(result, null, 2));
}
run()
  .catch((error: unknown) => {
    // A CLI must explain a failed setup without printing a credential-bearing URI
    // or an entire driver error object. Keep the phase and original error text.
    const name = error instanceof Error ? error.name : 'UnknownError';
    const message = error instanceof Error ? error.message : 'Non-Error seed failure';
    const safeMessage = message.replace(
      /mongodb(?:\+srv)?:\/\/[^\r\n]*/gi,
      '[MongoDB URI redacted]',
    );
    console.error(`Demo seed failed during ${stage} (${name}): ${safeMessage}`);
    console.error('Existing records were not reset.');
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase());
