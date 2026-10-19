import mongoose, { type Connection, Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MongoMemoryReplSet, MongoMemoryServer } from 'mongodb-memory-server-core';
import {
  createPersistenceModels,
  type PersistenceModels,
} from '../../src/modules/persistence/models.js';
import {
  initializePersistence,
  UnsupportedDatabaseError,
} from '../../src/modules/persistence/initialize.js';
import { runInTransaction } from '../../src/modules/persistence/transaction.js';
import {
  connectDatabase,
  disconnectDatabase,
  isDatabaseReady,
} from '../../src/infrastructure/database.js';
import { assignmentFixture, eventFixture, jobFixture, riderFixture } from '../helpers/fixtures.js';
import { startTestReplicaSet, startTestStandalone } from '../helpers/mongo.js';

let replica: MongoMemoryReplSet;
let standalone: MongoMemoryServer;
let connection: Connection;
let models: PersistenceModels;

beforeAll(async () => {
  replica = await startTestReplicaSet();
  connection = await mongoose
    .createConnection(replica.getUri('relay_persistence_test'), {
      autoIndex: false,
      autoCreate: false,
    })
    .asPromise();
  models = createPersistenceModels(connection);
  await initializePersistence(connection);
});
beforeEach(async () => {
  // Only fixture-owned, disposable databases are cleared. Raw access here is an
  // explicit test-admin operation; application audit updates remain forbidden.
  for (const model of Object.values(models)) await model.collection.deleteMany({});
});
afterAll(async () => {
  await disconnectDatabase();
  if (connection) await connection.close();
  if (standalone) await standalone.stop();
  if (replica) await replica.stop();
});

describe('real MongoDB indexes and constraints', () => {
  it('creates named indexes with the required uniqueness/partial filters and no TTL', async () => {
    const jobIndexes = await models.Job.collection.indexes();
    expect(jobIndexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'job_reference_unique',
          unique: true,
          key: { orderReference: 1 },
        }),
        expect.objectContaining({
          name: 'job_creation_key_unique',
          unique: true,
          partialFilterExpression: { creationKey: { $type: 'string' } },
        }),
        expect.objectContaining({
          name: 'job_status_queue',
          key: { status: 1, createdAt: 1, _id: 1 },
        }),
        expect.objectContaining({ name: 'job_pickup_queue' }),
        expect.objectContaining({ name: 'job_delivery_queue' }),
      ]),
    );
    const indexes = await models.Assignment.collection.indexes();
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'assignment_active_job_unique',
          unique: true,
          partialFilterExpression: { active: true },
        }),
        expect.objectContaining({ name: 'assignment_command_unique', unique: true }),
        expect.objectContaining({
          name: 'assignment_due_queue',
          key: { status: 1, expiresAt: 1, _id: 1 },
        }),
        expect.objectContaining({ name: 'assignment_job_history' }),
        expect.objectContaining({
          name: 'assignment_rider_workload',
          key: { riderId: 1, active: 1, assignedAt: 1, _id: 1 },
        }),
      ]),
    );
    expect(await models.JobEvent.collection.indexes()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'event_job_sequence_unique',
          unique: true,
          key: { jobId: 1, sequence: 1 },
        }),
      ]),
    );
    for (const model of Object.values(models)) {
      for (const index of await model.collection.indexes())
        expect(index.expireAfterSeconds).toBeUndefined();
    }
  });
  it('preserves operator-created indexes on repeated initialization', async () => {
    await models.Job.collection.createIndex({ priority: 1 }, { name: 'operator_priority' });
    await initializePersistence(connection);
    expect(await models.Job.collection.indexes()).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'operator_priority' })]),
    );
  });
  it('makes two concurrent normalized job references collide in MongoDB', async () => {
    const results = await Promise.allSettled([
      models.Job.create(jobFixture({ orderReference: ' relay-duplicate ' })),
      models.Job.create(jobFixture({ orderReference: 'RELAY-DUPLICATE' })),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failure = results.find((r) => r.status === 'rejected');
    expect(failure?.status === 'rejected' && failure.reason.code).toBe(11000);
    expect(await models.Job.countDocuments()).toBe(1);
  });
  it('permits multiple jobs without a key but rejects duplicate supplied creation keys', async () => {
    await models.Job.create([jobFixture(), jobFixture()]);
    await models.Job.create(jobFixture({ creationKey: 'create-1' }));
    await expect(models.Job.create(jobFixture({ creationKey: 'create-1' }))).rejects.toMatchObject({
      code: 11000,
    });
    expect(await models.Job.countDocuments()).toBe(3);
  });
  it('enforces normalized rider-code uniqueness', async () => {
    await models.Rider.create(riderFixture({ code: ' rider-1 ' }));
    await expect(models.Rider.create(riderFixture({ code: 'RIDER-1' }))).rejects.toMatchObject({
      code: 11000,
    });
  });
  it('allows one active attempt per job under concurrent inserts', async () => {
    const jobId = new Types.ObjectId();
    const results = await Promise.allSettled([
      models.Assignment.create(assignmentFixture(jobId)),
      models.Assignment.create(assignmentFixture(jobId)),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failure = results.find((r) => r.status === 'rejected');
    expect(failure?.status === 'rejected' && failure.reason.code).toBe(11000);
    expect(await models.Assignment.countDocuments({ jobId, active: true })).toBe(1);
  });
  it.each(['ACCEPTED', 'PICKED_UP'] as const)(
    'keeps %s work protected by the active-attempt index',
    async (status) => {
      const jobId = new Types.ObjectId();
      await models.Assignment.create(
        assignmentFixture(jobId, { status, respondedAt: new Date('2030-01-01T09:05:00Z') }),
      );
      await expect(models.Assignment.create(assignmentFixture(jobId))).rejects.toMatchObject({
        code: 11000,
      });
    },
  );
  it('retains expired attempts while allowing a fresh active attempt', async () => {
    const jobId = new Types.ObjectId();
    await models.Assignment.create(
      assignmentFixture(jobId, {
        status: 'EXPIRED',
        active: false,
        endedAt: new Date('2030-01-01T11:00:00Z'),
        reservationReleasedAt: new Date('2030-01-01T11:00:00Z'),
        endReason: 'RESPONSE_TIMEOUT',
      }),
    );
    await models.Assignment.create(assignmentFixture(jobId));
    expect(await models.Assignment.countDocuments({ jobId })).toBe(2);
    expect(await models.Assignment.countDocuments({ jobId, active: true })).toBe(1);
  });
  it('keeps assignment command keys unique even after an attempt expires', async () => {
    const jobId = new Types.ObjectId();
    await models.Assignment.create(
      assignmentFixture(jobId, {
        requestKey: 'attempt-1',
        status: 'EXPIRED',
        active: false,
        endedAt: new Date('2030-01-01T11:00:00Z'),
        reservationReleasedAt: new Date('2030-01-01T11:00:00Z'),
        endReason: 'RESPONSE_TIMEOUT',
      }),
    );
    await expect(
      models.Assignment.create(assignmentFixture(jobId, { requestKey: 'attempt-1' })),
    ).rejects.toMatchObject({ code: 11000 });
  });
  it('keeps identity/load immutable through supported Mongoose document saves', async () => {
    const attempt = await models.Assignment.create(assignmentFixture());
    const originalRider = attempt.riderId;
    attempt.riderId = new Types.ObjectId();
    attempt.loadUnits = 99;
    await expect(attempt.save()).rejects.toThrow('immutable');
    const stored = await models.Assignment.findById(attempt._id).orFail();
    expect(stored.riderId.equals(originalRider)).toBe(true);
    expect(stored.loadUnits).toBe(2);
  });
});

describe('append-only operational history', () => {
  it('rejects duplicate per-job event sequence and reads in sequence order', async () => {
    const jobId = new Types.ObjectId();
    await models.JobEvent.create(eventFixture(jobId, { sequence: 2 }));
    await models.JobEvent.create(eventFixture(jobId));
    await expect(models.JobEvent.create(eventFixture(jobId))).rejects.toMatchObject({
      code: 11000,
    });
    expect(
      (await models.JobEvent.find({ jobId }).sort({ sequence: 1 })).map((e) => e.sequence),
    ).toEqual([1, 2]);
  });
  it.each([
    'updateOne',
    'updateMany',
    'replaceOne',
    'findOneAndUpdate',
    'findOneAndReplace',
    'deleteOne',
    'deleteMany',
    'findOneAndDelete',
  ] as const)('blocks query mutation %s', async (operation) => {
    const event = await models.JobEvent.create(eventFixture());
    const filter = { _id: event._id };
    let mutation;
    switch (operation) {
      case 'updateOne':
        mutation = models.JobEvent.updateOne(filter, { $set: { actor: 'changed' } });
        break;
      case 'updateMany':
        mutation = models.JobEvent.updateMany(filter, { $set: { actor: 'changed' } });
        break;
      case 'replaceOne':
        mutation = models.JobEvent.replaceOne(filter, eventFixture(event.jobId));
        break;
      case 'findOneAndUpdate':
        mutation = models.JobEvent.findOneAndUpdate(filter, { $set: { actor: 'changed' } });
        break;
      case 'findOneAndReplace':
        mutation = models.JobEvent.findOneAndReplace(filter, eventFixture(event.jobId));
        break;
      case 'deleteOne':
        mutation = models.JobEvent.deleteOne(filter);
        break;
      case 'deleteMany':
        mutation = models.JobEvent.deleteMany(filter);
        break;
      case 'findOneAndDelete':
        mutation = models.JobEvent.findOneAndDelete(filter);
        break;
    }
    await expect(mutation).rejects.toThrow('append-only');
    expect((await models.JobEvent.findById(event._id).orFail()).actor).toBe('dispatcher:test');
  });
  it('blocks changes via document save/update/delete and model bulk writes', async () => {
    const event = await models.JobEvent.create(eventFixture());
    event.actor = 'changed';
    await expect(event.save()).rejects.toThrow('append-only');
    await expect(event.updateOne({ $set: { actor: 'changed' } })).rejects.toThrow('append-only');
    await expect(event.deleteOne()).rejects.toThrow('append-only');
    await expect(
      models.JobEvent.bulkWrite([{ deleteOne: { filter: { _id: event._id } } }]),
    ).rejects.toThrow('append-only');
    expect(await models.JobEvent.countDocuments()).toBe(1);
  });
  it('rejects invalid details and lean insertMany validation bypass', async () => {
    await expect(
      models.JobEvent.create(eventFixture(undefined, { details: { invented: true } })),
    ).rejects.toThrow('event type');
    await expect(models.JobEvent.insertMany([eventFixture()], { lean: true })).rejects.toThrow(
      'append-only',
    );
    await models.JobEvent.insertMany([eventFixture()]);
    expect(await models.JobEvent.countDocuments()).toBe(1);
  });
});

describe('real transaction boundary and startup checks', () => {
  it('commits related records together and returns the callback result', async () => {
    const id = await runInTransaction(connection, async (session) => {
      const [job] = await models.Job.create([jobFixture()], { session });
      if (!job) throw new Error('Missing job fixture');
      await models.JobEvent.create([eventFixture(job._id)], { session });
      return job._id.toHexString();
    });
    expect(await models.Job.exists({ _id: id })).toBeTruthy();
    expect(await models.JobEvent.countDocuments({ jobId: id })).toBe(1);
  });
  it('rolls back job rider attempt and audit together after an injected failure', async () => {
    const rider = await models.Rider.create(riderFixture());
    await expect(
      runInTransaction(connection, async (session) => {
        const [job] = await models.Job.create([jobFixture()], { session });
        if (!job) throw new Error('Missing job fixture');
        await models.Rider.updateOne(
          { _id: rider._id },
          { $inc: { reservedUnits: 2, activeJobCount: 1 } },
          { session },
        );
        await models.Assignment.create([assignmentFixture(job._id, { riderId: rider._id })], {
          session,
        });
        await models.JobEvent.create([eventFixture(job._id)], { session });
        throw new Error('injected failure after all four writes');
      }),
    ).rejects.toThrow('injected failure');
    expect(await models.Job.countDocuments()).toBe(0);
    expect(await models.Assignment.countDocuments()).toBe(0);
    expect(await models.JobEvent.countDocuments()).toBe(0);
    const stored = await models.Rider.findById(rider._id).orFail();
    expect(stored.reservedUnits).toBe(0);
    expect(stored.activeJobCount).toBe(0);
  });
  it('does not allow a duplicate index failure to partially commit a transaction', async () => {
    await models.Job.create(jobFixture({ orderReference: 'RELAY-EXISTS' }));
    await expect(
      runInTransaction(connection, async (session) => {
        await models.Rider.create([riderFixture()], { session });
        await models.Job.create([jobFixture({ orderReference: 'RELAY-EXISTS' })], { session });
      }),
    ).rejects.toMatchObject({ code: 11000 });
    expect(await models.Rider.countDocuments()).toBe(0);
    expect(await models.Job.countDocuments()).toBe(1);
  });
  it('sets readiness only after bootstrap succeeds and clears it on disconnect', async () => {
    expect(isDatabaseReady()).toBe(false);
    await connectDatabase(replica.getUri('relay_startup_test'));
    expect(isDatabaseReady()).toBe(true);
    await disconnectDatabase();
    expect(isDatabaseReady()).toBe(false);
  });
  it('keeps readiness false when existing duplicates prevent index creation', async () => {
    const uri = replica.getUri('relay_bootstrap_conflict_test');
    const setup = await mongoose
      .createConnection(uri, { autoCreate: false, autoIndex: false })
      .asPromise();
    try {
      // Simulate legacy data created before the required unique index existed.
      await setup
        .collection('jobs')
        .insertMany([
          jobFixture({ orderReference: 'LEGACY-DUPLICATE' }),
          jobFixture({ orderReference: 'LEGACY-DUPLICATE' }),
        ]);
      await expect(connectDatabase(uri)).rejects.toMatchObject({ code: 11000 });
      expect(isDatabaseReady()).toBe(false);
      expect(mongoose.connection.readyState).toBe(0);
    } finally {
      await setup.close();
    }
  });

  it('refuses standalone MongoDB before serving transaction-dependent traffic', async () => {
    standalone = await startTestStandalone();
    const unsupported = await mongoose
      .createConnection(standalone.getUri('relay_standalone_test'), {
        autoCreate: false,
        autoIndex: false,
      })
      .asPromise();
    try {
      await expect(initializePersistence(unsupported)).rejects.toBeInstanceOf(
        UnsupportedDatabaseError,
      );
    } finally {
      await unsupported.close();
    }
    await expect(
      connectDatabase(standalone.getUri('relay_startup_standalone_test')),
    ).rejects.toBeInstanceOf(UnsupportedDatabaseError);
    expect(isDatabaseReady()).toBe(false);
    expect(mongoose.connection.readyState).toBe(0);
  });
});
