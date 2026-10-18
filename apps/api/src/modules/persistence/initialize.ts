import type { Connection } from 'mongoose';
import { createPersistenceModels } from './models.js';
import { runInTransaction } from './transaction.js';

export class UnsupportedDatabaseError extends Error {
  constructor() {
    super('RELAY requires a writable MongoDB replica set with session support');
    this.name = 'UnsupportedDatabaseError';
  }
}

export async function initializePersistence(connection: Connection): Promise<void> {
  if (!connection.db) throw new Error('Database must be connected before initialization');
  const topology = await connection.db.command({ hello: 1 }, { timeoutMS: 5000 });
  if (
    !topology.setName ||
    topology.isWritablePrimary !== true ||
    topology.logicalSessionTimeoutMinutes == null
  ) {
    throw new UnsupportedDatabaseError();
  }

  const models = createPersistenceModels(connection);
  // Build only declared indexes, before business traffic. syncIndexes() could
  // drop indexes created by an operator and is inappropriate for safe startup.
  for (const model of Object.values(models)) {
    await model.createCollection();
    await model.createIndexes();
  }
  // A TCP connection and a replica-set name are not enough evidence that session
  // transactions work. Exercise a real snapshot transaction before readiness.
  await runInTransaction(connection, async (session) => {
    await models.Job.findOne({}).select('_id').session(session).maxTimeMS(5000).lean();
  });
}
