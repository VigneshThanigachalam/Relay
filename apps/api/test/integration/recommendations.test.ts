import mongoose, { type Connection } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MongoMemoryReplSet } from 'mongodb-memory-server-core';
import { createApp } from '../../src/app.js';
import { createJobsService } from '../../src/modules/jobs/service.js';
import { createRidersService } from '../../src/modules/riders/service.js';
import { createRecommendationsService } from '../../src/modules/recommendations/service.js';
import {
  createPersistenceModels,
  type PersistenceModels,
} from '../../src/modules/persistence/models.js';
import { initializePersistence } from '../../src/modules/persistence/initialize.js';
import { recommendationSnapshotSchema } from '../../src/modules/domain/audit-details.js';
import { startTestReplicaSet } from '../helpers/mongo.js';
import { jobFixture, riderFixture } from '../helpers/fixtures.js';

let replica: MongoMemoryReplSet;
let connection: Connection;
let models: PersistenceModels;
let app: ReturnType<typeof createApp>;
let now: Date;
const actor = 'dispatcher:meena';
const recommend = (id: string) =>
  request(app).post(`/api/v1/jobs/${id}/recommendations`).set('X-Actor-Id', actor).send({});
async function seedJob(change: Record<string, unknown> = {}) {
  return models.Job.create(jobFixture({ status: 'READY_FOR_ASSIGNMENT', ...change }));
}

beforeAll(async () => {
  replica = await startTestReplicaSet();
  connection = await mongoose
    .createConnection(replica.getUri('relay_recommendations_http_test'), {
      autoCreate: false,
      autoIndex: false,
    })
    .asPromise();
  models = createPersistenceModels(connection);
  await initializePersistence(connection);
  const dependencies = { connection, models, clock: { now: () => new Date(now) } };
  app = createApp({
    isReady: () => connection.readyState === 1,
    jobs: createJobsService(dependencies),
    riders: createRidersService(dependencies),
    recommendations: createRecommendationsService(dependencies),
  });
});
beforeEach(async () => {
  vi.restoreAllMocks();
  now = new Date('2030-01-01T09:00:00Z');
  for (const model of Object.values(models)) await model.collection.deleteMany({});
});
afterAll(async () => {
  vi.restoreAllMocks();
  if (connection) await connection.close();
  if (replica) await replica.stop();
});

describe('real recommendation API and history', () => {
  it('creates a job and rider over HTTP, marks ready and records an explainable recommendation', async () => {
    const created = await request(app)
      .post('/api/v1/jobs')
      .set('X-Actor-Id', actor)
      .send({
        orderReference: 'DEMO-REC',
        pickupZone: 'CENTRAL',
        deliveryZone: 'NORTH',
        loadUnits: 2,
        priority: 'HIGH',
      });
    expect(created.status).toBe(201);
    const id = created.body.data.id;
    const rider = await request(app)
      .post('/api/v1/riders')
      .set('X-Actor-Id', actor)
      .send({
        code: 'R-001',
        name: 'Arun',
        serviceZones: ['CENTRAL', 'NORTH'],
        currentZone: 'CENTRAL',
        capacityUnits: 5,
      });
    expect(rider.status).toBe(201);
    expect(
      (await request(app).post(`/api/v1/jobs/${id}/ready`).set('X-Actor-Id', actor).send({}))
        .status,
    ).toBe(200);
    const res = await recommend(id);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      scoringVersion: 'v1',
      generatedAt: now.toISOString(),
      jobStatus: 'READY_FOR_ASSIGNMENT',
      eligible: [
        {
          riderId: rider.body.data.id,
          rank: 1,
          totalCost: 40,
          estimatedMinutes: 20,
          availableUnits: 5,
          breakdown: { travelCost: 40, workloadCost: 0, deadlineCost: 0 },
          estimatedByFallback: false,
        },
      ],
      excluded: [],
    });
    const history = await request(app).get(`/api/v1/jobs/${id}/history`);
    expect(history.body.data.events.map((e: { type: string }) => e.type)).toEqual([
      'JOB_CREATED',
      'JOB_READY',
      'RIDERS_RECOMMENDED',
    ]);
    expect(history.body.data.events[2]).toMatchObject({
      sequence: 3,
      actor,
      occurredAt: now.toISOString(),
    });
    const { jobStatus: _, ...snapshot } = res.body.data;
    expect(history.body.data.events[2].details.snapshot).toEqual(snapshot);
    expect(recommendationSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(history.body.data.attempts).toEqual([]);
    const detail = await request(app).get(`/api/v1/jobs/${id}`);
    expect(detail.body.data).toMatchObject({
      version: 1,
      assignedRiderId: null,
      activeAssignmentId: null,
    });
    const workload = await models.Rider.findById(rider.body.data.id).orFail();
    expect(workload.reservedUnits).toBe(0);
    expect(workload.activeJobCount).toBe(0);
    expect(await models.Assignment.countDocuments()).toBe(0);
  });
  it('ranks ties by code and returns every ineligible rider with reasons', async () => {
    const job = await seedJob();
    const riders = await models.Rider.create([
      riderFixture({ code: 'R-002' }),
      riderFixture({ code: 'R-001' }),
      riderFixture({ code: 'R-003', availability: 'UNAVAILABLE' }),
      riderFixture({ code: 'R-004', serviceZones: ['CENTRAL'] }),
      riderFixture({ code: 'R-005', capacityUnits: 1 }),
    ]);
    const res = await recommend(job.id);
    expect(res.status).toBe(200);
    expect(res.body.data.eligible.map((r: { riderId: string }) => r.riderId)).toEqual([
      riders[1]!.id,
      riders[0]!.id,
    ]);
    expect(res.body.data.excluded).toEqual([
      { riderId: riders[2]!.id, reasons: ['UNAVAILABLE'] },
      { riderId: riders[3]!.id, reasons: ['UNSUPPORTED_DELIVERY_ZONE'] },
      { riderId: riders[4]!.id, reasons: ['INSUFFICIENT_CAPACITY'] },
    ]);
  });
  it('excludes invalid stored counters and leaves the corruption visible', async () => {
    const job = await seedJob();
    const rider = await models.Rider.create(riderFixture());
    await models.Rider.collection.updateOne(
      { _id: rider._id },
      { $set: { reservedUnits: 6, activeJobCount: 1 } },
    );
    const res = await recommend(job.id);
    expect(res.status).toBe(200);
    expect(res.body.data.excluded).toEqual([
      { riderId: rider.id, reasons: ['INVALID_WORKLOAD_COUNTERS'] },
    ]);
    expect(res.body.data.jobStatus).toBe('MANUAL_QUEUE');
    expect((await models.Rider.findById(rider.id).orFail()).reservedUnits).toBe(6);
  });
  it('keeps recorded scores immutable when location and availability later change', async () => {
    const job = await seedJob();
    const rider = await models.Rider.create(riderFixture());
    const first = await recommend(job.id);
    expect(first.body.data.eligible[0].totalCost).toBe(30);
    const update = await request(app)
      .patch(`/api/v1/riders/${rider.id}`)
      .set('X-Actor-Id', actor)
      .send({ currentZone: 'WEST', availability: 'UNAVAILABLE' });
    expect(update.status).toBe(200);
    now = new Date(now.getTime() + 60_000);
    const second = await recommend(job.id);
    expect(second.body.data.eligible).toEqual([]);
    const history = await request(app).get(`/api/v1/jobs/${job.id}/history`);
    expect(history.body.data.events[0].details.snapshot.eligible[0].totalCost).toBe(30);
    expect(history.body.data.events[1].details.snapshot.generatedAt).toBe(now.toISOString());
    expect(history.body.data.events.map((e: { sequence: number }) => e.sequence)).toEqual([
      1, 2, 3,
    ]);
  });
  it('allows a past deadline to remain actionable and prices lateness', async () => {
    const job = await seedJob({ deadlineAt: new Date(now.getTime() - 5 * 60_000) });
    await models.Rider.create(riderFixture());
    const res = await recommend(job.id);
    expect(res.status).toBe(200);
    expect(res.body.data.eligible[0]).toMatchObject({
      totalCost: 130,
      breakdown: { deadlineCost: 100 },
    });
    expect(res.body.data.jobStatus).toBe('READY_FOR_ASSIGNMENT');
  });
});

describe('no-candidate manual intervention', () => {
  it('moves an empty-fleet ready job into manual with reason and both audit events atomically', async () => {
    const job = await seedJob();
    const res = await recommend(job.id);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ eligible: [], excluded: [], jobStatus: 'MANUAL_QUEUE' });
    const stored = await models.Job.findById(job.id).orFail();
    expect(stored.status).toBe('MANUAL_QUEUE');
    expect(stored.manualReason).toBe('NO_ELIGIBLE_RIDER');
    expect(stored.version).toBe(1);
    expect(stored.eventSequence).toBe(2);
    expect(stored.assignedRiderId).toBeUndefined();
    expect(stored.activeAssignmentId).toBeUndefined();
    const history = await request(app).get(`/api/v1/jobs/${job.id}/history`);
    expect(history.body.data.events.map((e: { type: string }) => e.type)).toEqual([
      'RIDERS_RECOMMENDED',
      'MANUAL_QUEUE_ENTERED',
    ]);
    expect(history.body.data.events[1]).toMatchObject({
      sequence: 2,
      actor,
      details: { reason: 'NO_ELIGIBLE_RIDER' },
    });
    expect((await request(app).get('/api/v1/jobs?status=MANUAL_QUEUE')).body.pagination.total).toBe(
      1,
    );
    expect(await models.Assignment.countDocuments()).toBe(0);
  });
  it('records each reevaluation without duplicating manual entry or incrementing state version', async () => {
    const job = await seedJob();
    expect((await recommend(job.id)).status).toBe(200);
    expect((await recommend(job.id)).status).toBe(200);
    expect(await models.JobEvent.countDocuments({ type: 'RIDERS_RECOMMENDED' })).toBe(2);
    expect(await models.JobEvent.countDocuments({ type: 'MANUAL_QUEUE_ENTERED' })).toBe(1);
    expect((await models.Job.findById(job.id).orFail()).version).toBe(1);
  });
  it.each(['RIDER_REJECTED', 'RESPONSE_TIMEOUT'] as const)(
    'preserves existing manual reason %s',
    async (manualReason) => {
      const job = await seedJob({ status: 'MANUAL_QUEUE', manualReason, version: 3 });
      const res = await recommend(job.id);
      expect(res.status).toBe(200);
      expect((await models.Job.findById(job.id).orFail()).manualReason).toBe(manualReason);
      expect((await models.Job.findById(job.id).orFail()).version).toBe(3);
      expect(await models.JobEvent.countDocuments({ type: 'MANUAL_QUEUE_ENTERED' })).toBe(0);
    },
  );
  it('finds newly available riders while leaving a manual job for explicit dispatcher assignment', async () => {
    const job = await seedJob();
    await recommend(job.id);
    await models.Rider.create(riderFixture());
    const res = await recommend(job.id);
    expect(res.status).toBe(200);
    expect(res.body.data.eligible).toHaveLength(1);
    expect(res.body.data.jobStatus).toBe('MANUAL_QUEUE');
    expect((await models.Job.findById(job.id).orFail()).manualReason).toBe('NO_ELIGIBLE_RIDER');
    expect(await models.Assignment.countDocuments()).toBe(0);
  });
  it('rolls back the manual transition, event sequence and first event if the second audit insert fails', async () => {
    const job = await seedJob();
    const original = models.JobEvent.collection.insertOne.bind(models.JobEvent.collection);
    vi.spyOn(models.JobEvent.collection, 'insertOne')
      .mockImplementationOnce((...args) => original(...args))
      .mockRejectedValueOnce(new Error('audit storage failed'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await recommend(job.id);
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    const stored = await models.Job.findById(job.id).orFail();
    expect(stored.status).toBe('READY_FOR_ASSIGNMENT');
    expect(stored.manualReason).toBeUndefined();
    expect(stored.version).toBe(0);
    expect(stored.eventSequence).toBe(0);
    expect(await models.JobEvent.countDocuments()).toBe(0);
  });
});

describe('HTTP validation, states and dependency errors', () => {
  it.each(['NEW', 'AWAITING_CONFIRMATION', 'ACCEPTED', 'PICKED_UP', 'DELIVERED', 'CANCELLED'])(
    'rejects recommendation in %s state without audit',
    async (status) => {
      const active = ['AWAITING_CONFIRMATION', 'ACCEPTED', 'PICKED_UP'].includes(status);
      const job = await seedJob({
        status,
        ...(active
          ? {
              activeAssignmentId: new mongoose.Types.ObjectId(),
              assignedRiderId: new mongoose.Types.ObjectId(),
            }
          : {}),
      });
      const res = await recommend(job.id);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('INVALID_TRANSITION');
      expect(await models.JobEvent.countDocuments()).toBe(0);
      expect((await models.Job.findById(job.id).orFail()).status).toBe(status);
    },
  );
  it.each([
    { actor: undefined, body: {}, query: '' },
    { actor: ' ', body: {}, query: '' },
    { actor: 'x'.repeat(81), body: {}, query: '' },
    { actor, body: { riderId: 'forged' }, query: '' },
    { actor, body: [], query: '' },
    { actor, body: {}, query: '?unknown=1' },
  ])('rejects invalid request %j', async ({ actor: header, body, query }) => {
    const job = await seedJob();
    const req = request(app).post(`/api/v1/jobs/${job.id}/recommendations${query}`);
    if (header !== undefined) req.set('X-Actor-Id', header);
    const res = await req.send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
    expect(await models.JobEvent.countDocuments()).toBe(0);
  });
  it('requires an explicit empty JSON body', async () => {
    const job = await seedJob();
    const res = await request(app)
      .post(`/api/v1/jobs/${job.id}/recommendations`)
      .set('X-Actor-Id', actor);
    expect(res.status).toBe(400);
  });
  it('distinguishes malformed and missing job IDs', async () => {
    expect((await recommend('bad-id')).status).toBe(400);
    const absent = await recommend('507f191e810c19729de860ea');
    expect(absent.status).toBe(404);
    expect(absent.body.error.code).toBe('JOB_NOT_FOUND');
  });
  it('returns 503 before invoking the service when persistence is unready', async () => {
    const recommendations = createRecommendationsService({ connection, models });
    const spy = vi.spyOn(recommendations, 'recommend');
    const unready = createApp({ recommendations, isReady: () => false });
    const res = await request(unready)
      .post('/api/v1/jobs/507f191e810c19729de860ea/recommendations')
      .set('X-Actor-Id', actor)
      .send({});
    expect(res.status).toBe(503);
    expect(spy).not.toHaveBeenCalled();
  });
  it('returns 503 for an uncertain commit, and a new request records a fresh evaluation without duplicate manual entry', async () => {
    const job = await seedJob();
    const original = connection.transaction.bind(connection);
    vi.spyOn(connection, 'transaction').mockImplementationOnce(async (work, options) => {
      await original(work, options);
      throw new mongoose.mongo.MongoServerError({
        message: 'simulated lost recommendation reply',
        errorLabels: ['UnknownTransactionCommitResult'],
      });
    });
    expect((await recommend(job.id)).status).toBe(503);
    expect((await recommend(job.id)).status).toBe(200);
    expect(await models.JobEvent.countDocuments({ type: 'MANUAL_QUEUE_ENTERED' })).toBe(1);
    expect(await models.JobEvent.countDocuments({ type: 'RIDERS_RECOMMENDED' })).toBe(2);
    expect((await models.Job.findById(job.id).orFail()).version).toBe(1);
  });
});

describe('real transaction conflicts', () => {
  it('serializes concurrent empty-fleet evaluations with one manual entry and contiguous events', async () => {
    const job = await seedJob();
    const responses = await Promise.all(Array.from({ length: 8 }, () => recommend(job.id)));
    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(await models.JobEvent.countDocuments({ type: 'RIDERS_RECOMMENDED' })).toBe(8);
    expect(await models.JobEvent.countDocuments({ type: 'MANUAL_QUEUE_ENTERED' })).toBe(1);
    const events = await models.JobEvent.find({ jobId: job.id }).sort({ sequence: 1 }).lean();
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect((await models.Job.findById(job.id).orFail()).version).toBe(1);
  });
  it('rechecks legality when a cancellation fixture commits after recommendation read', async () => {
    const job = await seedJob();
    await models.Rider.create(riderFixture());
    let reached!: () => void;
    let resume!: () => void;
    const atWrite = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const releaseWrite = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const original = models.Job.collection.findOneAndUpdate.bind(models.Job.collection);
    const gate = vi
      .spyOn(models.Job.collection, 'findOneAndUpdate')
      .mockImplementationOnce(async (...args) => {
        reached();
        await releaseWrite;
        return original(...args);
      });
    const pending = recommend(job.id).then((res) => res);
    try {
      await atWrite;
      // Controlled lifecycle fixture, not a claim that the cancellation API exists.
      await models.Job.updateOne(
        { _id: job._id, status: 'READY_FOR_ASSIGNMENT' },
        { $set: { status: 'CANCELLED' }, $inc: { version: 1 } },
      );
      resume();
      const res = await pending;
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('INVALID_TRANSITION');
      expect(await models.JobEvent.countDocuments()).toBe(0);
      expect((await models.Job.findById(job.id).orFail()).status).toBe('CANCELLED');
    } finally {
      resume();
      gate.mockRestore();
      await pending;
    }
  });
});
