import { MongoMemoryReplSet, MongoMemoryServer } from 'mongodb-memory-server-core';

// This harness launches an actual mongod binary. It does not emulate MongoDB or
// substitute a JavaScript in-memory database. No production URI is used/dropped.
const binary = { version: process.env.MONGOMS_VERSION ?? '8.0.17' };
export function startTestReplicaSet() {
  return MongoMemoryReplSet.create({
    binary,
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    // TCP works in this environment; filesystem Unix sockets are restricted.
    instanceOpts: [{ args: ['--nounixsocket'] }],
  });
}
export function startTestStandalone() {
  return MongoMemoryServer.create({
    binary,
    instance: { storageEngine: 'wiredTiger', args: ['--nounixsocket'] },
  });
}
