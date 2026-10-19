import mongoose, { type Connection } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MongoMemoryReplSet } from 'mongodb-memory-server-core';
import { createApp } from '../../src/app.js';
import { createDashboardService } from '../../src/modules/dashboard/service.js';
import { seedDemo } from '../../src/modules/demo/seed.js';
import { createDeliveryService } from '../../src/modules/delivery/service.js';
import { createDispatchService } from '../../src/modules/dispatch/service.js';
import { createResolutionService } from '../../src/modules/dispatch/resolution.js';
import { createJobsService } from '../../src/modules/jobs/service.js';
import { createManualQueueService } from '../../src/modules/manual-queue/service.js';
import {
  createPersistenceModels,
  type PersistenceModels,
} from '../../src/modules/persistence/models.js';
import { initializePersistence } from '../../src/modules/persistence/initialize.js';
import { createRecommendationsService } from '../../src/modules/recommendations/service.js';
import { createRidersService } from '../../src/modules/riders/service.js';
import { createTimeoutScanner } from '../../src/modules/worker/timeout-scanner.js';
import { startTestReplicaSet } from '../helpers/mongo.js';
let replica: MongoMemoryReplSet,
  connection: Connection,
  models: PersistenceModels,
  app: ReturnType<typeof createApp>,
  now: Date;
const clock = { now: () => new Date(now) };
beforeAll(async () => {
  replica = await startTestReplicaSet();
  connection = await mongoose
    .createConnection(replica.getUri('relay_reviewer_demo'), {
      autoIndex: false,
      autoCreate: false,
    })
    .asPromise();
  models = createPersistenceModels(connection);
  await initializePersistence(connection);
  const deps = { connection, models, clock };
  app = createApp({
    isReady: () => true,
    jobs: createJobsService(deps),
    riders: createRidersService(deps),
    recommendations: createRecommendationsService(deps),
    dispatch: createDispatchService({ ...deps, responseThresholdMs: 5000 }),
    resolution: createResolutionService(deps),
    delivery: createDeliveryService(deps),
    manualQueue: createManualQueueService(deps),
    dashboard: createDashboardService(deps),
  });
});
beforeEach(async () => {
  now = new Date('2030-01-01T12:00:00Z');
  for (const model of Object.values(models)) await model.collection.deleteMany({});
});
afterAll(async () => {
  await connection?.close();
  await replica?.stop();
});
const post = (path: string, body: object = {}, key?: string) => {
  const r = request(app)
    .post('/api/v1' + path)
    .set('X-Actor-Id', 'dispatcher:reviewer');
  if (key) r.set('Idempotency-Key', key);
  return r.send(body);
};
async function getJob(reference: string) {
  const response = await request(app).get(`/api/v1/jobs?orderReference=${reference}`);
  expect(response.status).toBe(200);
  return response.body.data[0] as { id: string; status: string; activeAssignmentId: string | null };
}
async function assign(id: string, key: string, override = false) {
  const advice = await post(`/jobs/${id}/recommendations`);
  expect(advice.status).toBe(200);
  const eligible = advice.body.data.eligible as { riderId: string }[];
  expect(eligible.length).toBeGreaterThan(0);
  const riderId = eligible[override ? eligible.length - 1 : 0]!.riderId;
  const body = {
    riderId,
    ...(override ? { overrideReason: 'Reviewer operational preference' } : {}),
  };
  const result = await post(`/jobs/${id}/assignments`, body, key);
  expect(result.status).toBe(201);
  expect((await post(`/jobs/${id}/assignments`, body, key)).body.replayed).toBe(true);
  return result.body.data.assignment as { id: string; riderId: string };
}
async function complete(id: string, attemptId: string) {
  expect((await post(`/assignments/${attemptId}/accept`)).status).toBe(200);
  expect((await post(`/jobs/${id}/deliver`, { assignmentId: attemptId })).status).toBe(409);
  expect((await post(`/jobs/${id}/pickup`, { assignmentId: attemptId })).status).toBe(200);
  expect((await post(`/jobs/${id}/deliver`, { assignmentId: attemptId })).status).toBe(200);
  expect((await post(`/jobs/${id}/deliver`, { assignmentId: attemptId })).body.replayed).toBe(true);
}
async function invariants() {
  for (const rider of await models.Rider.find().lean()) {
    const active = await models.Assignment.find({ riderId: rider._id, active: true }).lean();
    expect(rider.activeJobCount).toBe(active.length);
    expect(rider.reservedUnits).toBe(active.reduce((sum, a) => sum + a.loadUnits, 0));
    expect(rider.reservedUnits).toBeLessThanOrEqual(rider.capacityUnits);
  }
  for (const job of await models.Job.find().lean()) {
    const active = await models.Assignment.find({ jobId: job._id, active: true }).lean();
    expect(active.length).toBeLessThanOrEqual(1);
    expect(job.activeAssignmentId?.toHexString() ?? null).toBe(
      active[0]?._id.toHexString() ?? null,
    );
    const events = await models.JobEvent.find({ jobId: job._id }).sort({ sequence: 1 }).lean();
    expect(events.map((e) => e.sequence)).toEqual(
      Array.from({ length: job.eventSequence }, (_, i) => i + 1),
    );
  }
}
describe('complete seeded reviewer workflow', () => {
  it('creates public demo scenarios with real histories/counters and a persisted overdue attempt', async () => {
    const result = await seedDemo({ connection, models, clock });
    expect(result.created).toHaveLength(13);
    expect(result.riders).toBe(5);
    const dashboard = await request(app).get('/api/v1/dashboard');
    expect(dashboard.body.data).toMatchObject({
      total: 13,
      awaitingAssignment: 6,
      inProgress: 2,
      byStatus: { MANUAL_QUEUE: 2, DELIVERED: 1, CANCELLED: 1, AWAITING_CONFIRMATION: 1 },
      attentionTotal: 4,
    });
    const overdue = await getJob('DEMO-OVERDUE');
    expect(overdue.status).toBe('AWAITING_CONFIRMATION');
    const scanner = createTimeoutScanner({
      models,
      resolution: createResolutionService({ connection, models, clock }),
      clock,
    });
    expect((await scanner.scan()).expired).toBe(1);
    expect((await getJob('DEMO-OVERDUE')).status).toBe('MANUAL_QUEUE');
    expect((await scanner.scan()).expired).toBe(0);
    await invariants();
  });
  it('preserves progressed work and rider edits when seeded again', async () => {
    await seedDemo({ connection, models, clock });
    const job = await getJob('DEMO-READY');
    const attempt = await assign(job.id, 'first');
    await complete(job.id, attempt.id);
    const rider = await models.Rider.findOne({ code: 'DEMO-ARUN' }).orFail();
    expect(
      (
        await request(app)
          .patch(`/api/v1/riders/${rider.id}`)
          .set('X-Actor-Id', 'dispatcher:reviewer')
          .send({ name: 'Reviewer renamed' })
      ).status,
    ).toBe(200);
    const events = await models.JobEvent.countDocuments();
    now = new Date(now.getTime() + 86400000);
    const again = await seedDemo({ connection, models, clock });
    expect(again.created).toEqual([]);
    expect(again.skipped).toHaveLength(13);
    expect(await models.Job.countDocuments()).toBe(13);
    expect(await models.JobEvent.countDocuments()).toBe(events);
    expect((await getJob('DEMO-READY')).status).toBe('DELIVERED');
    expect((await models.Rider.findById(rider.id))?.name).toBe('Reviewer renamed');
    await invariants();
  });
  it('demonstrates duplicate prevention, override, reject, expiry, manual reassignment and delivery through public APIs', async () => {
    await seedDemo({ connection, models, clock });
    const payload = {
      orderReference: 'REVIEWER-CREATE',
      pickupZone: 'CENTRAL',
      deliveryZone: 'NORTH',
      loadUnits: 1,
      priority: 'NORMAL',
    };
    const created = await post('/jobs', payload);
    expect(created.status).toBe(201);
    expect((await post('/jobs', payload)).body.replayed).toBe(true);
    expect(await models.Job.countDocuments({ orderReference: 'REVIEWER-CREATE' })).toBe(1);
    expect((await post(`/jobs/${created.body.data.id}/ready`)).status).toBe(200);
    const overrideJob = await getJob('DEMO-OVERRIDE');
    const overridden = await assign(overrideJob.id, 'override', true);
    await complete(overrideJob.id, overridden.id);
    expect(
      await models.JobEvent.exists({ jobId: overrideJob.id, type: 'MANUAL_OVERRIDE' }),
    ).not.toBeNull();
    const rejectedJob = await getJob('DEMO-REJECT');
    const rejected = await assign(rejectedJob.id, 'reject');
    expect(
      (await post(`/assignments/${rejected.id}/reject`, { reason: 'Road closure' })).status,
    ).toBe(200);
    const timeoutJob = await getJob('DEMO-TIMEOUT');
    const first = await assign(timeoutJob.id, 'timeout');
    now = new Date(now.getTime() + 5000);
    const scanner = createTimeoutScanner({
      models,
      resolution: createResolutionService({ connection, models, clock }),
      clock,
    });
    expect((await scanner.scan()).expired).toBe(2);
    const queue = await request(app).get('/api/v1/manual-queue');
    expect(queue.status).toBe(200);
    expect(queue.body.data.find((j: { id: string }) => j.id === timeoutJob.id)).toMatchObject({
      manualReason: 'RESPONSE_TIMEOUT',
      latestAttempt: { id: first.id, status: 'EXPIRED' },
    });
    const second = await assign(timeoutJob.id, 'retry');
    expect(second.id).not.toBe(first.id);
    expect((await post(`/assignments/${first.id}/accept`)).status).toBe(409);
    await complete(timeoutJob.id, second.id);
    const history = await request(app).get(`/api/v1/jobs/${timeoutJob.id}/history?pageSize=100`);
    expect(history.body.data.attempts.map((a: { status: string }) => a.status)).toEqual([
      'EXPIRED',
      'DELIVERED',
    ]);
    expect(history.body.data.events.some((e: { type: string }) => e.type === 'REASSIGNED')).toBe(
      true,
    );
    expect((await getJob('DEMO-NO-CANDIDATE')).status).toBe('MANUAL_QUEUE');
    await invariants();
  });
});
