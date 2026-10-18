import type { ClientSession, Connection } from 'mongoose';

// Type against the driver's actual callback options: Mongoose forwards them to
// withTransaction, including the total retry budget supported by driver 6.20.
const transactionOptions: NonNullable<Parameters<ClientSession['withTransaction']>[1]> = {
  readPreference: 'primary',
  readConcern: { level: 'snapshot' },
  writeConcern: { w: 'majority' },
  maxCommitTimeMS: 5000,
  timeoutMS: 15000,
};

export function runInTransaction<T>(
  connection: Connection,
  work: (session: ClientSession) => Promise<T>,
): Promise<T> {
  // Driver-labelled transient errors may replay the callback. Read fresh state,
  // pass session to every operation, await writes sequentially and keep emails,
  // HTTP responses or other external side effects outside this callback.
  return connection.transaction(work, transactionOptions);
}
