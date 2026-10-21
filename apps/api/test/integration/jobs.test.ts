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
import { assignmentFixture } from '../helpers/fixtures.js';
import { appendJobEvent } from '../../src/modules/history/append-event.js';

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

const markReady = (id: string) =>
  request(app).post(`/api/v1/jobs/${id}/ready`).set('X-Actor-Id', 'dispatcher:meena').send({});

describe('job retrieval and filtered operational lists', () => {
  it('returns an empty queue with bounded default pagination', async () => {
    const res = await request(app).get('/api/v1/jobs');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [], pagination: { page: 1, pageSize: 20, total: 0 } });
  });
  it('retrieves the current job without leaking storage fields', async () => {
    const created = await create(payload(), 'private-key');
    const res = await request(app).get(`/api/v1/jobs/${created.body.data.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(created.body.data);
    expect(JSON.stringify(res.body)).not.toMatch(/requestHash|creationKey|eventSequence|__v/);
  });
  it('filters by pickup OR delivery zone and combines the status filter', async () => {
    const a = await create(
      payload({ orderReference: 'A', pickupZone: 'CENTRAL', deliveryZone: 'NORTH' }),
    );
    await create(payload({ orderReference: 'B', pickupZone: 'NORTH', deliveryZone: 'SOUTH' }));
    await create(payload({ orderReference: 'C', pickupZone: 'EAST', deliveryZone: 'WEST' }));
    await markReady(a.body.data.id);
    const bothSides = await request(app).get('/api/v1/jobs?zone=north');
    expect(bothSides.body.data.map((j: { orderReference: string }) => j.orderReference)).toEqual([
      'A',
      'B',
    ]);
    expect(bothSides.body.pagination.total).toBe(2);
    const ready = await request(app).get('/api/v1/jobs?zone=NORTH&status=READY_FOR_ASSIGNMENT');
    expect(ready.body.data.map((j: { orderReference: string }) => j.orderReference)).toEqual(['A']);
    expect(ready.body.pagination.total).toBe(1);
  });
  it('searches the exact normalized reference without interpreting regex characters', async () => {
    await create(payload({ orderReference: 'RELAY-1001' }));
    await create(payload({ orderReference: 'RELAY-10012' }));
    const exact = await request(app).get('/api/v1/jobs').query({ orderReference: ' relay-1001 ' });
    expect(exact.body.data).toHaveLength(1);
    expect(exact.body.data[0].orderReference).toBe('RELAY-1001');
    const literal = await request(app).get('/api/v1/jobs').query({ orderReference: 'RELAY-.*' });
    expect(literal.body.data).toEqual([]);
  });
  it('paginates deterministically when jobs share the same creation timestamp', async () => {
    const ids = [];
    for (const reference of ['FIRST', 'SECOND', 'THIRD'])
      ids.push((await create(payload({ orderReference: reference }))).body.data.id);
    const first = await request(app).get('/api/v1/jobs?page=1&pageSize=2');
    const second = await request(app).get('/api/v1/jobs?page=2&pageSize=2');
    expect(first.body.data.map((j: { id: string }) => j.id)).toEqual(ids.slice(0, 2));
    expect(second.body.data.map((j: { id: string }) => j.id)).toEqual(ids.slice(2));
    expect(second.body.pagination).toEqual({ page: 2, pageSize: 2, total: 3 });
    const beyond = await request(app).get('/api/v1/jobs?page=3&pageSize=2');
    expect(beyond.body.data).toEqual([]);
    expect(beyond.body.pagination.total).toBe(3);
  });
  it.each([
    'page=0',
    'pageSize=101',
    'status=UNKNOWN',
    'zone=UNKNOWN',
    'status=NEW&status=CANCELLED',
    'status[$ne]=NEW',
    'unknown=ignored',
  ])('rejects invalid query %s', async (query) => {
    const res = await request(app).get(`/api/v1/jobs?${query}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
  it.each(['/api/v1/jobs/not-an-id', '/api/v1/jobs/not-an-id/history'])(
    'rejects malformed ID at %s',
    async (path) => {
      expect((await request(app).get(path)).status).toBe(400);
    },
  );
  it.each(['', '/history'])('returns meaningful 404 for a missing valid job%s', async (suffix) => {
    const res = await request(app).get(`/api/v1/jobs/507f191e810c19729de860ea${suffix}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('JOB_NOT_FOUND');
  });
});

describe('guarded ready command and transactional audit', () => {
  it('moves NEW to ready with one ordered event, actor and version increment', async () => {
    const created = await create();
    now = new Date('2030-01-01T09:05:00Z');
    const res = await markReady(created.body.data.id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      replayed: false,
      data: { status: 'READY_FOR_ASSIGNMENT', version: 1, updatedAt: now.toISOString() },
    });
    const stored = await models.Job.findById(created.body.data.id).orFail();
    expect(stored.eventSequence).toBe(2);
    const history = await request(app).get(`/api/v1/jobs/${stored._id}/history`);
    expect(history.status).toBe(200);
    expect(history.body.data.events.map((e: { type: string }) => e.type)).toEqual([
      'JOB_CREATED',
      'JOB_READY',
    ]);
    expect(history.body.data.events[1]).toMatchObject({
      sequence: 2,
      actor: 'dispatcher:meena',
      occurredAt: now.toISOString(),
      details: { from: 'NEW', to: 'READY_FOR_ASSIGNMENT' },
    });
    expect(history.body.data.attempts).toEqual([]);
  });
  it('replays an already-ready command without another event or version increment', async () => {
    const id = (await create()).body.data.id;
    await markReady(id);
    const replay = await markReady(id);
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.data.version).toBe(1);
    expect(await models.JobEvent.countDocuments()).toBe(2);
  });
  it('replays creation after ready without resetting current state', async () => {
    const id = (await create(payload(), 'create-key')).body.data.id;
    await markReady(id);
    const replay = await create(payload(), 'create-key');
    expect(replay.status).toBe(200);
    expect(replay.body.data).toMatchObject({ id, status: 'READY_FOR_ASSIGNMENT', version: 1 });
    expect(await models.JobEvent.countDocuments()).toBe(2);
  });
  it('allows only one effective ready transition when eight dispatchers race', async () => {
    const id = (await create()).body.data.id;
    const replies = await Promise.all(Array.from({ length: 8 }, () => markReady(id)));
    expect(replies.every((r) => r.status === 200)).toBe(true);
    expect(replies.filter((r) => r.body.replayed === false)).toHaveLength(1);
    expect(replies.every((r) => r.body.data.version === 1)).toBe(true);
    expect(await models.JobEvent.countDocuments()).toBe(2);
    expect((await models.Job.findById(id).orFail()).eventSequence).toBe(2);
  });
  it.each(['CANCELLED', 'DELIVERED', 'MANUAL_QUEUE'] as const)(
    'refuses resetting %s work to ready',
    async (status) => {
      const id = (await create()).body.data.id;
      // Fixture-only state setup: the corresponding lifecycle APIs do not exist yet.
      await models.Job.collection.updateOne(
        { _id: new mongoose.Types.ObjectId(id) },
        {
          $set: {
            status,
            ...(status === 'MANUAL_QUEUE' ? { manualReason: 'NO_ELIGIBLE_RIDER' } : {}),
          },
        },
      );
      const res = await markReady(id);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('INVALID_TRANSITION');
      expect(await models.JobEvent.countDocuments()).toBe(1);
      expect((await models.Job.findById(id).orFail()).status).toBe(status);
    },
  );
  it('rolls back ready status, version and sequence if its audit insert fails', async () => {
    const id = (await create()).body.data.id;
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(models.JobEvent, 'create').mockRejectedValueOnce(
      new Error('injected ready audit failure'),
    );
    const res = await markReady(id);
    expect(res.status).toBe(500);
    const unchanged = await models.Job.findById(id).orFail();
    expect(unchanged).toMatchObject({ status: 'NEW', version: 0, eventSequence: 1 });
    expect(await models.JobEvent.countDocuments()).toBe(1);
    log.mockRestore();
    expect((await markReady(id)).body.data.version).toBe(1);
    expect(await models.JobEvent.countDocuments()).toBe(2);
  });
  it('recovers a lost ready-commit response through a harmless client retry', async () => {
    const id = (await create()).body.data.id;
    const original = connection.transaction.bind(connection);
    vi.spyOn(connection, 'transaction').mockImplementationOnce(async (work, options) => {
      await original(work, options);
      throw new mongoose.mongo.MongoServerError({
        message: 'simulated lost ready commit reply',
        errorLabels: ['UnknownTransactionCommitResult'],
      });
    });
    expect((await markReady(id)).status).toBe(503);
    const retry = await markReady(id);
    expect(retry.status).toBe(200);
    expect(retry.body.replayed).toBe(true);
    expect(await models.JobEvent.countDocuments()).toBe(2);
  });
  it('requires actor, empty body and a valid/existing target', async () => {
    const id = (await create()).body.data.id;
    expect((await request(app).post(`/api/v1/jobs/${id}/ready`).send({})).status).toBe(400);
    expect(
      (
        await request(app)
          .post(`/api/v1/jobs/${id}/ready`)
          .set('X-Actor-Id', 'dispatcher:test')
          .send({ status: 'DELIVERED' })
      ).status,
    ).toBe(400);
    expect((await markReady('invalid')).status).toBe(400);
    expect((await markReady('507f191e810c19729de860ea')).status).toBe(404);
    expect((await models.Job.findById(id).orFail()).status).toBe('NEW');
  });
  it('refuses an audit append outside a transaction without allocating a sequence', async () => {
    const id = (await create()).body.data.id;
    const session = await connection.startSession();
    try {
      await expect(
        appendJobEvent(models, session, {
          jobId: new mongoose.Types.ObjectId(id),
          type: 'JOB_READY',
          actor: 'dispatcher:test',
          occurredAt: now,
          details: { from: 'NEW', to: 'READY_FOR_ASSIGNMENT' },
        }),
      ).rejects.toThrow('active transaction');
    } finally {
      await session.endSession();
    }
    expect((await models.Job.findById(id).orFail()).eventSequence).toBe(1);
  });
});

describe('bounded chronological job history', () => {
  it('paginates events with totals and retains fixture attempts without exposing command keys', async () => {
    const id = (await create()).body.data.id;
    await markReady(id);
    const jobId = new mongoose.Types.ObjectId(id);
    const failed = {
      status: 'EXPIRED',
      active: false,
      endReason: 'RESPONSE_TIMEOUT',
      endedAt: new Date('2030-01-01T11:00:00Z'),
      reservationReleasedAt: new Date('2030-01-01T11:00:00Z'),
    };
    await models.Assignment.create(assignmentFixture(jobId, failed));
    await models.Assignment.create(assignmentFixture(jobId, failed));
    await models.Assignment.create(assignmentFixture(jobId));
    const page1 = await request(app).get(`/api/v1/jobs/${id}/history?page=1&pageSize=1`);
    const page2 = await request(app).get(`/api/v1/jobs/${id}/history?page=2&pageSize=1`);
    expect(page1.body.data.events[0].sequence).toBe(1);
    expect(page2.body.data.events[0].sequence).toBe(2);
    expect(page1.body.pagination).toEqual({ page: 1, pageSize: 1, total: 2 });
    expect(page1.body.attemptsPagination).toEqual({ page: 1, pageSize: 1, total: 3 });
    expect(page1.body.data.attempts).toHaveLength(1);
    expect(page1.body.data.attempts[0].status).toBe('EXPIRED');
    expect(JSON.stringify(page1.body)).not.toMatch(/requestHash|requestKey|creationKey/);
    expect((await request(app).get(`/api/v1/jobs/${id}/history`)).body.data.attempts).toHaveLength(
      3,
    );
  });
  it('rejects invalid pagination and provides no audit edit/delete route', async () => {
    const id = (await create()).body.data.id;
    expect((await request(app).get(`/api/v1/jobs/${id}/history?pageSize=101`)).status).toBe(400);
    expect(
      (await request(app).patch(`/api/v1/jobs/${id}/history`).send({ actor: 'changed' })).status,
    ).toBe(404);
    expect((await request(app).delete(`/api/v1/jobs/${id}/history`)).status).toBe(404);
    expect(await models.JobEvent.countDocuments()).toBe(1);
  });
});

describe('literal job search', () => {
  it('combines partial case-insensitive reference search with status and either route zone', async () => {
    const north = await create(payload({ orderReference: 'ORDER-101' }));
    const south = await create(payload({ orderReference: 'ORDER-102', deliveryZone: 'SOUTH' }));
    await create(payload({ orderReference: 'OTHER-101' }));
    for (const id of [north.body.data.id, south.body.data.id])
      await request(app)
        .post(`/api/v1/jobs/${id}/ready`)
        .set('X-Actor-Id', 'dispatcher:test')
        .send({});
    const res = await request(app)
      .get('/api/v1/jobs')
      .query({ search: ' order-10 ', status: 'READY_FOR_ASSIGNMENT', zone: 'NORTH' });
    expect(res.status).toBe(200);
    expect(res.body.data.map((j: { orderReference: string }) => j.orderReference)).toEqual([
      'ORDER-101',
    ]);
    expect(res.body.pagination.total).toBe(1);
    const exact = await request(app).get('/api/v1/jobs').query({ orderReference: 'ORDER-10' });
    expect(exact.body.data).toEqual([]);
    const intersection = await request(app)
      .get('/api/v1/jobs')
      .query({ orderReference: 'ORDER-101', search: '102' });
    expect(intersection.body.data).toEqual([]);
  });
  it('escapes regex characters and rejects empty or oversized search', async () => {
    await create(payload({ orderReference: 'LITERAL.*-01' }));
    await create(payload({ orderReference: 'OTHER-01' }));
    const res = await request(app).get('/api/v1/jobs').query({ search: '.*' });
    expect(res.status).toBe(200);
    expect(res.body.data.map((j: { orderReference: string }) => j.orderReference)).toEqual([
      'LITERAL.*-01',
    ]);
    for (const search of [' ', 'x'.repeat(81)])
      expect((await request(app).get('/api/v1/jobs').query({ search })).status).toBe(400);
  });
});
