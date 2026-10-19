import mongoose, { type Connection } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MongoMemoryReplSet } from 'mongodb-memory-server-core';
import { createApp } from '../../src/app.js';
import { createDispatchService } from '../../src/modules/dispatch/service.js';
import {
  createResolutionService,
  type ResolutionService,
} from '../../src/modules/dispatch/resolution.js';
import { createDeliveryService } from '../../src/modules/delivery/service.js';
import { createJobsService } from '../../src/modules/jobs/service.js';
import {
  createPersistenceModels,
  type PersistenceModels,
} from '../../src/modules/persistence/models.js';
import { initializePersistence } from '../../src/modules/persistence/initialize.js';
import { startTestReplicaSet } from '../helpers/mongo.js';
import { jobFixture, riderFixture } from '../helpers/fixtures.js';
let replica: MongoMemoryReplSet,
  connection: Connection,
  models: PersistenceModels,
  resolution: ResolutionService,
  app: ReturnType<typeof createApp>,
  now: Date;
const post = (path: string, body: object) =>
  request(app).post(path).set('X-Actor-Id', 'dispatcher:demo').send(body);
async function work(state = 'ACCEPTED') {
  const rider = await models.Rider.create(riderFixture());
  const job = await models.Job.create(jobFixture({ status: 'READY_FOR_ASSIGNMENT' }));
  const assigned = await request(app)
    .post(`/api/v1/jobs/${job.id}/assignments`)
    .set('X-Actor-Id', 'dispatcher:demo')
    .set('Idempotency-Key', 'create')
    .send({ riderId: rider.id, overrideReason: 'Operational choice' });
  expect(assigned.status).toBe(201);
  const attempt = assigned.body.data.assignment;
  if (state !== 'PENDING')
    expect((await post(`/api/v1/assignments/${attempt.id}/accept`, {})).status).toBe(200);
  if (state === 'PICKED_UP')
    expect((await post(`/api/v1/jobs/${job.id}/pickup`, { assignmentId: attempt.id })).status).toBe(
      200,
    );
  return { rider, job, attempt };
}
beforeAll(async () => {
  replica = await startTestReplicaSet();
  connection = await mongoose
    .createConnection(replica.getUri('relay_delivery_test'), {
      autoCreate: false,
      autoIndex: false,
    })
    .asPromise();
  models = createPersistenceModels(connection);
  await initializePersistence(connection);
  const deps = { connection, models, clock: { now: () => new Date(now) } };
  resolution = createResolutionService(deps);
  app = createApp({
    isReady: () => true,
    jobs: createJobsService(deps),
    dispatch: createDispatchService({ ...deps, responseThresholdMs: 5000 }),
    resolution,
    delivery: createDeliveryService(deps),
  });
});
beforeEach(async () => {
  vi.restoreAllMocks();
  now = new Date('2030-01-01T09:00:00Z');
  for (const model of Object.values(models)) await model.collection.deleteMany({});
});
afterAll(async () => {
  vi.restoreAllMocks();
  await connection?.close();
  await replica?.stop();
});
async function counters(id: string, units: number, count: number) {
  const rider = await models.Rider.findById(id).orFail();
  const active = await models.Assignment.find({ riderId: id, active: true });
  expect(rider.reservedUnits).toBe(units);
  expect(rider.activeJobCount).toBe(count);
  expect(active.reduce((sum, a) => sum + a.loadUnits, 0)).toBe(units);
  expect(active.length).toBe(count);
}
describe('delivery and cancellation', () => {
  it('accepts, picks up and delivers with chronological audit and one original-load release', async () => {
    const { job, rider, attempt } = await work();
    const picked = await post(`/api/v1/jobs/${job.id}/pickup`, { assignmentId: attempt.id });
    expect(picked.body.data.job.status).toBe('PICKED_UP');
    await counters(rider.id, 2, 1);
    const done = await post(`/api/v1/jobs/${job.id}/deliver`, { assignmentId: attempt.id });
    expect(done.status).toBe(200);
    expect(done.body.data.job).toMatchObject({
      status: 'DELIVERED',
      activeAssignmentId: null,
      assignedRiderId: null,
    });
    expect(done.body.data.assignment).toMatchObject({
      status: 'DELIVERED',
      active: false,
      reservationReleasedAt: now.toISOString(),
    });
    await counters(rider.id, 0, 0);
    expect(
      (await post(`/api/v1/jobs/${job.id}/deliver`, { assignmentId: attempt.id })).body.replayed,
    ).toBe(true);
    expect(
      (await post(`/api/v1/jobs/${job.id}/pickup`, { assignmentId: attempt.id })).body.replayed,
    ).toBe(true);
    const history = await request(app).get(`/api/v1/jobs/${job.id}/history`);
    expect(history.body.data.events.map((e: { type: string }) => e.type)).toEqual([
      'RIDERS_RECOMMENDED',
      'ASSIGNMENT_CREATED',
      'ASSIGNMENT_ACCEPTED',
      'JOB_PICKED_UP',
      'JOB_DELIVERED',
    ]);
    expect(history.body.data.events[4].details.releasedUnits).toBe(2);
  });
  it.each(['PENDING', 'ACCEPTED'])('cannot deliver from %s', async (state) => {
    const { job, rider, attempt } = await work(state);
    const res = await post(`/api/v1/jobs/${job.id}/deliver`, { assignmentId: attempt.id });
    expect(res.status).toBe(409);
    await counters(rider.id, 2, 1);
  });
  it.each(['NEW', 'READY_FOR_ASSIGNMENT', 'MANUAL_QUEUE'])(
    'cancels unassigned %s and replays matching reason',
    async (status) => {
      const job = await models.Job.create(
        jobFixture({
          status,
          ...(status === 'MANUAL_QUEUE' ? { manualReason: 'NO_ELIGIBLE_RIDER' } : {}),
        }),
      );
      const res = await post(`/api/v1/jobs/${job.id}/cancel`, {
        reason: ' Customer changed plans ',
      });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        job: { status: 'CANCELLED', manualReason: null },
        assignment: null,
      });
      expect(
        (await post(`/api/v1/jobs/${job.id}/cancel`, { reason: 'Customer changed plans' })).body
          .replayed,
      ).toBe(true);
      expect((await post(`/api/v1/jobs/${job.id}/cancel`, { reason: 'Different' })).status).toBe(
        409,
      );
      expect(await models.JobEvent.countDocuments()).toBe(1);
    },
  );
  it.each(['PENDING', 'ACCEPTED'])(
    'cancels %s, releases once and retains original attempt',
    async (state) => {
      const { job, rider, attempt } = await work(state);
      const res = await post(`/api/v1/jobs/${job.id}/cancel`, { reason: 'Customer cancelled' });
      expect(res.status).toBe(200);
      expect(res.body.data.assignment).toMatchObject({
        id: attempt.id,
        status: 'CANCELLED',
        active: false,
        endReason: 'Customer cancelled',
      });
      await counters(rider.id, 0, 0);
      expect((await post(`/api/v1/assignments/${attempt.id}/accept`, {})).status).toBe(409);
      expect(
        (await post(`/api/v1/jobs/${job.id}/pickup`, { assignmentId: attempt.id })).status,
      ).toBe(409);
      expect(
        (await post(`/api/v1/jobs/${job.id}/cancel`, { reason: 'Customer cancelled' })).body
          .replayed,
      ).toBe(true);
      expect(await models.JobEvent.countDocuments({ type: 'JOB_CANCELLED' })).toBe(1);
    },
  );
  it('forbids cancellation after pickup or delivery', async () => {
    const { job, rider, attempt } = await work('PICKED_UP');
    expect((await post(`/api/v1/jobs/${job.id}/cancel`, { reason: 'Too late' })).status).toBe(409);
    await counters(rider.id, 2, 1);
    await post(`/api/v1/jobs/${job.id}/deliver`, { assignmentId: attempt.id });
    expect((await post(`/api/v1/jobs/${job.id}/cancel`, { reason: 'Too late' })).status).toBe(409);
    await counters(rider.id, 0, 0);
  });
  it('rejects another job attempt without modifying either reservation', async () => {
    const first = await work();
    const second = await work();
    expect(
      (await post(`/api/v1/jobs/${first.job.id}/pickup`, { assignmentId: second.attempt.id }))
        .status,
    ).toBe(409);
    await counters(first.rider.id, 2, 1);
    await counters(second.rider.id, 2, 1);
  });
  it.each(['deliver', 'cancel'])('rolls back %s and its release if audit fails', async (action) => {
    const { job, rider, attempt } = await work(action === 'deliver' ? 'PICKED_UP' : 'ACCEPTED');
    vi.spyOn(models.JobEvent.collection, 'insertOne').mockRejectedValueOnce(
      new Error('audit failed'),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      (
        await post(
          `/api/v1/jobs/${job.id}/${action}`,
          action === 'cancel' ? { reason: 'Cancel' } : { assignmentId: attempt.id },
        )
      ).status,
    ).toBe(500);
    expect((await models.Job.findById(job.id).orFail()).status).toBe(
      action === 'deliver' ? 'PICKED_UP' : 'ACCEPTED',
    );
    await counters(rider.id, 2, 1);
  });
  it('aborts delivery on corrupt counters rather than clamping', async () => {
    const { job, rider, attempt } = await work('PICKED_UP');
    await models.Rider.collection.updateOne({ _id: rider._id }, { $set: { reservedUnits: 1 } });
    expect(
      (await post(`/api/v1/jobs/${job.id}/deliver`, { assignmentId: attempt.id })).body.error.code,
    ).toBe('WORKLOAD_CONFLICT');
    expect((await models.Assignment.findById(attempt.id).orFail()).status).toBe('PICKED_UP');
  });
  it.each(['deliver', 'cancel'])(
    'eight duplicate %s commands have one release/event',
    async (action) => {
      const { job, rider, attempt } = await work(action === 'deliver' ? 'PICKED_UP' : 'ACCEPTED');
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          post(
            `/api/v1/jobs/${job.id}/${action}`,
            action === 'cancel' ? { reason: 'Cancel' } : { assignmentId: attempt.id },
          ),
        ),
      );
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(results.filter((r) => !r.body.replayed)).toHaveLength(1);
      expect(
        await models.JobEvent.countDocuments({
          type: action === 'deliver' ? 'JOB_DELIVERED' : 'JOB_CANCELLED',
        }),
      ).toBe(1);
      await counters(rider.id, 0, 0);
    },
  );
  it('pickup versus cancellation has one legal winner', async () => {
    const { job, rider, attempt } = await work();
    const results = await Promise.all([
      post(`/api/v1/jobs/${job.id}/pickup`, { assignmentId: attempt.id }),
      post(`/api/v1/jobs/${job.id}/cancel`, { reason: 'Cancel' }),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(1);
    const picked = (await models.Job.findById(job.id).orFail()).status === 'PICKED_UP';
    await counters(rider.id, picked ? 2 : 0, picked ? 1 : 0);
  });
  it('cancellation versus expiry releases once even if expiry first enters manual', async () => {
    const { job, rider, attempt } = await work('PENDING');
    now = new Date(attempt.expiresAt);
    const results = await Promise.all([
      post(`/api/v1/jobs/${job.id}/cancel`, { reason: 'Cancel' }),
      resolution.expire(attempt.id),
    ]);
    expect(results[0].status).toBe(200);
    expect((await models.Job.findById(job.id).orFail()).status).toBe('CANCELLED');
    await counters(rider.id, 0, 0);
  });
  it('validates bodies/actor/IDs and missing jobs', async () => {
    const { job, attempt } = await work();
    expect((await post(`/api/v1/jobs/${job.id}/cancel`, { reason: ' ' })).status).toBe(400);
    expect((await post(`/api/v1/jobs/${job.id}/pickup`, { assignmentId: 'bad' })).status).toBe(400);
    expect(
      (await request(app).post(`/api/v1/jobs/${job.id}/pickup`).send({ assignmentId: attempt.id }))
        .status,
    ).toBe(400);
    expect(
      (await post('/api/v1/jobs/507f191e810c19729de860ea/cancel', { reason: 'Cancel' })).status,
    ).toBe(404);
  });
  it('retries a lost delivery commit reply without another release', async () => {
    const { job, rider, attempt } = await work('PICKED_UP');
    const original = connection.transaction.bind(connection);
    vi.spyOn(connection, 'transaction').mockImplementationOnce(async (fn, options) => {
      await original(fn, options);
      throw new mongoose.mongo.MongoServerError({
        message: 'lost reply',
        errorLabels: ['UnknownTransactionCommitResult'],
      });
    });
    expect(
      (await post(`/api/v1/jobs/${job.id}/deliver`, { assignmentId: attempt.id })).status,
    ).toBe(503);
    expect(
      (await post(`/api/v1/jobs/${job.id}/deliver`, { assignmentId: attempt.id })).body.replayed,
    ).toBe(true);
    await counters(rider.id, 0, 0);
  });
});
