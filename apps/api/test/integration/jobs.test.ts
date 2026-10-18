import mongoose, { type Connection } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MongoMemoryReplSet } from 'mongodb-memory-server-core';
import { createApp } from '../../src/app.js';
import { createJobsService } from '../../src/modules/jobs/service.js';
import {
  createPersistenceModels,
  type PersistenceModels,
} from '../../src/modules/persistence/models.js';
import { initializePersistence } from '../../src/modules/persistence/initialize.js';
import { startTestReplicaSet } from '../helpers/mongo.js';

let replica: MongoMemoryReplSet;
let connection: Connection;
let models: PersistenceModels;
let app: ReturnType<typeof createApp>;
let now: Date;
const payload = (change: Record<string, unknown> = {}) => ({
  orderReference: 'RELAY-1001',
  pickupZone: 'CENTRAL',
  deliveryZone: 'NORTH',
  loadUnits: 2,
  ...change,
});
const create = (body: Record<string, unknown> = payload(), key?: string) => {
  const req = request(app).post('/api/v1/jobs').set('X-Actor-Id', 'dispatcher:arun');
  if (key !== undefined) req.set('Idempotency-Key', key);
  return req.send(body);
};

beforeAll(async () => {
  replica = await startTestReplicaSet();
  connection = await mongoose
    .createConnection(replica.getUri('relay_jobs_http_test'), {
      autoIndex: false,
      autoCreate: false,
    })
    .asPromise();
  models = createPersistenceModels(connection);
  await initializePersistence(connection);
  app = createApp({
    isReady: () => connection.readyState === 1,
    jobs: createJobsService({ connection, models, clock: { now: () => new Date(now) } }),
  });
});
beforeEach(async () => {
  vi.restoreAllMocks();
  now = new Date('2030-01-01T09:00:00.000Z');
  for (const model of Object.values(models)) await model.collection.deleteMany({});
});
afterAll(async () => {
  vi.restoreAllMocks();
  if (connection) await connection.close();
  if (replica) await replica.stop();
});

describe('transactional job creation over HTTP with actual MongoDB', () => {
  it('creates NEW work with server-owned metadata and one actor-attributed creation event', async () => {
    const res = await create(
      payload({ orderReference: ' relay-1001 ', pickupZone: ' central ' }),
      'create-1',
    );
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      replayed: false,
      data: {
        orderReference: 'RELAY-1001',
        pickupZone: 'CENTRAL',
        priority: 'NORMAL',
        status: 'NEW',
        version: 0,
        createdAt: now.toISOString(),
        activeAssignmentId: null,
        assignedRiderId: null,
        manualReason: null,
      },
    });
    expect(res.body.data).not.toHaveProperty('requestHash');
    expect(res.body.data).not.toHaveProperty('creationKey');
    expect(res.body.data).not.toHaveProperty('eventSequence');
    expect(res.body.data).not.toHaveProperty('_id');
    const stored = await models.Job.findById(res.body.data.id).orFail();
    expect(stored.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.creationKey).toBe('create-1');
    expect(stored.eventSequence).toBe(1);
    const events = await models.JobEvent.find({ jobId: stored._id });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'JOB_CREATED', actor: 'dispatcher:arun', sequence: 1 });
  });
  it('replays repeated normalized references without creating another job or event', async () => {
    const first = await create();
    const replay = await create(payload({ orderReference: ' relay-1001 ', priority: 'NORMAL' }));
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.data.id).toBe(first.body.data.id);
    expect(await models.Job.countDocuments()).toBe(1);
    expect(await models.JobEvent.countDocuments()).toBe(1);
  });
  it('replays a durable key across independently constructed service instances', async () => {
    const first = await create(payload(), 'durable-create');
    const other = createApp({
      isReady: () => true,
      jobs: createJobsService({ connection, models }),
    });
    const replay = await request(other)
      .post('/api/v1/jobs')
      .set('X-Actor-Id', 'dispatcher:other')
      .set('Idempotency-Key', 'durable-create')
      .send(payload());
    expect(replay.status).toBe(200);
    expect(replay.body.data.id).toBe(first.body.data.id);
    expect(await models.JobEvent.countDocuments()).toBe(1);
  });
  it('rejects changed data for the same reference', async () => {
    await create();
    const conflict = await create(payload({ loadUnits: 3 }));
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('DUPLICATE_JOB');
    expect(await models.Job.countDocuments()).toBe(1);
  });
  it('rejects changed data or another order when a key is reused', async () => {
    await create(payload(), 'shared-key');
    for (const body of [payload({ loadUnits: 3 }), payload({ orderReference: 'ANOTHER-ORDER' })]) {
      const conflict = await create(body, 'shared-key');
      expect(conflict.status).toBe(409);
      expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    }
    expect(await models.Job.countDocuments()).toBe(1);
  });
  it('does not silently bind another creation key during a reference replay', async () => {
    await create(payload(), 'original-key');
    const conflict = await create(payload(), 'new-key');
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect((await create()).status).toBe(200);
  });
  it('does not silently accept a new key for an originally keyless order', async () => {
    await create();
    expect((await create(payload(), 'later-key')).status).toBe(409);
  });
  it('honors key ownership before comparing an independently existing order reference', async () => {
    await create(payload(), 'first-key');
    await create(payload({ orderReference: 'SECOND-ORDER' }), 'second-key');
    const conflict = await create(payload({ orderReference: 'SECOND-ORDER' }), 'first-key');
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await models.Job.countDocuments()).toBe(2);
  });
  it('resolves 12 concurrent identical submissions to one job and one creation event', async () => {
    const replies = await Promise.all(
      Array.from({ length: 12 }, () => create(payload(), 'parallel-key')),
    );
    expect(replies.filter((r) => r.status === 201)).toHaveLength(1);
    expect(replies.filter((r) => r.status === 200)).toHaveLength(11);
    expect(new Set(replies.map((r) => r.body.data.id)).size).toBe(1);
    expect(await models.Job.countDocuments()).toBe(1);
    expect(await models.JobEvent.countDocuments()).toBe(1);
  });
  it('resolves concurrent conflicting references without a second record', async () => {
    const replies = await Promise.all([create(payload()), create(payload({ loadUnits: 3 }))]);
    expect(replies.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await models.Job.countDocuments()).toBe(1);
    expect(await models.JobEvent.countDocuments()).toBe(1);
  });
  it('resolves concurrent conflicting key ownership without a second order', async () => {
    const replies = await Promise.all([
      create(payload(), 'race-key'),
      create(payload({ orderReference: 'OTHER-ORDER' }), 'race-key'),
    ]);
    expect(replies.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await models.Job.countDocuments()).toBe(1);
  });
  it('accepts the same canonical deadline offset and replays after that deadline passes', async () => {
    const first = await create(payload({ deadlineAt: '2030-01-01T10:00:00Z' }), 'deadline-key');
    expect(first.status).toBe(201);
    now = new Date('2030-01-02T09:00:00Z');
    const replay = await create(
      payload({ deadlineAt: '2030-01-01T15:30:00+05:30' }),
      'deadline-key',
    );
    expect(replay.status).toBe(200);
    expect(replay.body.data.id).toBe(first.body.data.id);
  });
  it.each(['2030-01-01T08:00:00Z', '2030-01-01T09:00:00Z'])(
    'rejects a genuinely new job with past/equal deadline %s',
    async (deadlineAt) => {
      const res = await create(payload({ deadlineAt }));
      expect(res.status).toBe(400);
      expect(res.body.error.details).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: 'deadlineAt' })]),
      );
      expect(await models.Job.countDocuments()).toBe(0);
    },
  );
  it('rolls back the job and its allocated sequence if the audit append fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(models.JobEvent, 'create').mockRejectedValueOnce(
      new Error('injected audit storage failure'),
    );
    const failed = await create(payload(), 'retry-after-rollback');
    expect(failed.status).toBe(500);
    expect(await models.Job.countDocuments()).toBe(0);
    expect(await models.JobEvent.countDocuments()).toBe(0);
    log.mockRestore();
    const retry = await create(payload(), 'retry-after-rollback');
    expect(retry.status).toBe(201);
    expect((await models.Job.findById(retry.body.data.id).orFail()).eventSequence).toBe(1);
  });
  it('reconciles an unknown commit response after a real successful commit', async () => {
    const original = connection.transaction.bind(connection);
    vi.spyOn(connection, 'transaction').mockImplementationOnce(async (work, options) => {
      await original(work, options);
      throw new mongoose.mongo.MongoServerError({
        message: 'simulated lost commit reply',
        errorLabels: ['UnknownTransactionCommitResult'],
      });
    });
    const res = await create(payload(), 'uncertain-commit');
    expect(res.status).toBe(200);
    expect(res.body.replayed).toBe(true);
    expect(await models.Job.countDocuments()).toBe(1);
    expect(await models.JobEvent.countDocuments()).toBe(1);
  });
});

describe('job HTTP validation and dependency behavior', () => {
  it('requires actor attribution on mutations', async () => {
    const res = await request(app).post('/api/v1/jobs').send(payload());
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'x-actor-id' })]),
    );
    expect(await models.Job.countDocuments()).toBe(0);
  });
  it.each([
    { loadUnits: '2' },
    { loadUnits: 0 },
    { pickupZone: 'UNKNOWN' },
    { priority: 'UNKNOWN' },
    { status: 'DELIVERED' },
    { orderReference: ' ' },
    { deadlineAt: 'tomorrow' },
  ])('rejects invalid create payload %j', async (change) => {
    const res = await create(payload(change));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
    expect(await models.Job.countDocuments()).toBe(0);
  });
  it('rejects an empty idempotency key', async () => {
    expect((await create(payload(), ' ')).status).toBe(400);
  });
  it('returns 503 when persistence is not ready instead of calling the service', async () => {
    const jobs = createJobsService({ connection, models });
    const spy = vi.spyOn(jobs, 'create');
    const unavailable = createApp({ isReady: () => false, jobs });
    const res = await request(unavailable)
      .post('/api/v1/jobs')
      .set('X-Actor-Id', 'dispatcher:test')
      .send(payload());
    expect(res.status).toBe(503);
    expect(spy).not.toHaveBeenCalled();
  });
});
