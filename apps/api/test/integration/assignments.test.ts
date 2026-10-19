import mongoose, { type Connection } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MongoMemoryReplSet } from 'mongodb-memory-server-core';
import { createApp } from '../../src/app.js';
import { createDispatchService } from '../../src/modules/dispatch/service.js';
import { createJobsService } from '../../src/modules/jobs/service.js';
import { createRidersService } from '../../src/modules/riders/service.js';
import { createRecommendationsService } from '../../src/modules/recommendations/service.js';
import {
  createPersistenceModels,
  type PersistenceModels,
} from '../../src/modules/persistence/models.js';
import { initializePersistence } from '../../src/modules/persistence/initialize.js';
import { runInTransaction } from '../../src/modules/persistence/transaction.js';
import { startTestReplicaSet } from '../helpers/mongo.js';
import { assignmentFixture, jobFixture, riderFixture } from '../helpers/fixtures.js';

let replica: MongoMemoryReplSet;
let connection: Connection;
let models: PersistenceModels;
let app: ReturnType<typeof createApp>;
let now: Date;
const actor = 'dispatcher:meena';
function buildApp(responseThresholdMs = 5000) {
  const dependencies = { connection, models, clock: { now: () => new Date(now) } };
  return createApp({
    isReady: () => connection.readyState === 1,
    jobs: createJobsService(dependencies),
    riders: createRidersService(dependencies),
    recommendations: createRecommendationsService(dependencies),
    dispatch: createDispatchService({ ...dependencies, responseThresholdMs }),
  });
}
const assign = (jobId: string, riderId: string, key = 'command-1', overrideReason?: string) =>
  request(app)
    .post(`/api/v1/jobs/${jobId}/assignments`)
    .set('X-Actor-Id', actor)
    .set('Idempotency-Key', key)
    .send({ riderId, ...(overrideReason === undefined ? {} : { overrideReason }) });
async function seed(change: Record<string, unknown> = {}) {
  const job = await models.Job.create(jobFixture({ status: 'READY_FOR_ASSIGNMENT' }));
  const rider = await models.Rider.create(riderFixture(change));
  return { job, rider };
}
async function assertWorkload(riderId: string) {
  const rider = await models.Rider.findById(riderId).orFail();
  const active = await models.Assignment.find({ riderId, active: true }).lean();
  expect(rider.reservedUnits).toBe(active.reduce((sum, a) => sum + a.loadUnits, 0));
  expect(rider.activeJobCount).toBe(active.length);
  expect(rider.reservedUnits).toBeLessThanOrEqual(rider.capacityUnits);
}
beforeAll(async () => {
  replica = await startTestReplicaSet();
  connection = await mongoose
    .createConnection(replica.getUri('relay_assignment_http_test'), {
      autoCreate: false,
      autoIndex: false,
    })
    .asPromise();
  models = createPersistenceModels(connection);
  await initializePersistence(connection);
});
beforeEach(async () => {
  vi.restoreAllMocks();
  now = new Date('2030-01-01T09:00:00Z');
  for (const model of Object.values(models)) await model.collection.deleteMany({});
  app = buildApp();
});
afterAll(async () => {
  vi.restoreAllMocks();
  if (connection) await connection.close();
  if (replica) await replica.stop();
});

describe('atomic assignment HTTP workflow', () => {
  it('creates/marks ready/assigns through public APIs with one reservation, snapshot and matching history', async () => {
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
    const job = await request(app)
      .post('/api/v1/jobs')
      .set('X-Actor-Id', actor)
      .send({
        orderReference: 'ASSIGN-001',
        pickupZone: 'CENTRAL',
        deliveryZone: 'NORTH',
        loadUnits: 2,
        priority: 'HIGH',
      });
    expect(job.status).toBe(201);
    expect(
      (
        await request(app)
          .post(`/api/v1/jobs/${job.body.data.id}/ready`)
          .set('X-Actor-Id', actor)
          .send({})
      ).status,
    ).toBe(200);
    const res = await assign(job.body.data.id, rider.body.data.id);
    expect(res.status).toBe(201);
    expect(res.body.replayed).toBe(false);
    expect(res.body.data.job).toMatchObject({
      status: 'AWAITING_CONFIRMATION',
      assignedRiderId: rider.body.data.id,
      activeAssignmentId: res.body.data.assignment.id,
      version: 2,
      manualReason: null,
    });
    expect(res.body.data.assignment).toMatchObject({
      jobId: job.body.data.id,
      riderId: rider.body.data.id,
      status: 'PENDING',
      active: true,
      loadUnits: 2,
      actor,
      assignedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 5000).toISOString(),
      reservationReleasedAt: null,
      recommendationSnapshot: {
        scoringVersion: 'v1',
        eligible: [{ riderId: rider.body.data.id, rank: 1, totalCost: 40, availableUnits: 5 }],
      },
    });
    const history = await request(app).get(`/api/v1/jobs/${job.body.data.id}/history`);
    expect(history.body.data.events.map((e: { type: string }) => e.type)).toEqual([
      'JOB_CREATED',
      'JOB_READY',
      'RIDERS_RECOMMENDED',
      'ASSIGNMENT_CREATED',
    ]);
    expect(history.body.data.attempts).toEqual([res.body.data.assignment]);
    expect(history.body.data.events[2].details.snapshot).toEqual(
      res.body.data.assignment.recommendationSnapshot,
    );
    expect(history.body.data.events[3]).toMatchObject({
      sequence: 4,
      actor,
      assignmentId: res.body.data.assignment.id,
    });
    const detail = await request(app).get(`/api/v1/riders/${rider.body.data.id}`);
    expect(detail.body.data).toMatchObject({
      reservedUnits: 2,
      availableUnits: 3,
      activeJobCount: 1,
    });
    expect(detail.body.data.activeAssignments).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toMatch(/requestHash|requestKey|creationKey|__v/);
    await assertWorkload(rider.body.data.id);
  });
  it('allows exact remaining capacity and same-zone pickup/delivery', async () => {
    const { job, rider } = await seed({ capacityUnits: 2 });
    await models.Job.updateOne({ _id: job._id }, { $set: { deliveryZone: 'CENTRAL' } });
    expect((await assign(job.id, rider.id)).status).toBe(201);
    expect((await models.Rider.findById(rider.id).orFail()).reservedUnits).toBe(2);
    await assertWorkload(rider.id);
  });
  it('copies the two-hour default and leaves stored expiry unchanged after configuration changes', async () => {
    const { job, rider } = await seed();
    app = buildApp(7200000);
    const first = await assign(job.id, rider.id);
    expect(first.body.data.assignment.expiresAt).toBe(
      new Date(now.getTime() + 7200000).toISOString(),
    );
    app = buildApp(1000);
    const replay = await assign(job.id, rider.id);
    expect(replay.status).toBe(200);
    expect(replay.body.data.assignment.expiresAt).toBe(first.body.data.assignment.expiresAt);
    const nextJob = await models.Job.create(jobFixture({ status: 'READY_FOR_ASSIGNMENT' }));
    const next = await assign(nextJob.id, rider.id, 'new-command');
    expect(next.status).toBe(201);
    expect(next.body.data.assignment.expiresAt).toBe(new Date(now.getTime() + 1000).toISOString());
    await assertWorkload(rider.id);
  });
  it('assigns a no-candidate manual job once a rider is available and clears its manual reason', async () => {
    const { job, rider } = await seed({ availability: 'UNAVAILABLE' });
    const rec = await request(app)
      .post(`/api/v1/jobs/${job.id}/recommendations`)
      .set('X-Actor-Id', actor)
      .send({});
    expect(rec.body.data.jobStatus).toBe('MANUAL_QUEUE');
    await request(app)
      .patch(`/api/v1/riders/${rider.id}`)
      .set('X-Actor-Id', actor)
      .send({ availability: 'AVAILABLE' });
    const res = await assign(job.id, rider.id);
    expect(res.status).toBe(201);
    expect(res.body.data.job).toMatchObject({
      status: 'AWAITING_CONFIRMATION',
      manualReason: null,
      version: 2,
    });
    expect(await models.JobEvent.countDocuments({ type: 'REASSIGNED' })).toBe(0);
    await assertWorkload(rider.id);
  });
  it('retains a terminal attempt fixture when a new manual assignment records reassignment', async () => {
    const { job, rider } = await seed();
    const previous = await models.Assignment.create(
      assignmentFixture(job._id, {
        riderId: rider._id,
        status: 'EXPIRED',
        active: false,
        assignedAt: new Date('2029-12-31T22:00:00Z'),
        expiresAt: new Date('2029-12-31T23:00:00Z'),
        endedAt: new Date('2029-12-31T23:00:00Z'),
        reservationReleasedAt: new Date('2029-12-31T23:00:00Z'),
        endReason: 'RESPONSE_TIMEOUT',
      }),
    );
    await models.Job.updateOne(
      { _id: job._id },
      { $set: { status: 'MANUAL_QUEUE', manualReason: 'RESPONSE_TIMEOUT' } },
    );
    const before = previous.toObject();
    const res = await assign(job.id, rider.id);
    expect(res.status).toBe(201);
    expect(await models.Assignment.countDocuments({ jobId: job.id })).toBe(2);
    expect((await models.Assignment.findById(previous.id).orFail()).toObject()).toEqual(before);
    const event = await models.JobEvent.findOne({ type: 'REASSIGNED' }).orFail();
    expect(event.details).toEqual({
      previousAssignmentId: previous.id,
      newAssignmentId: res.body.data.assignment.id,
      riderId: rider.id,
    });
    await assertWorkload(rider.id);
  });
});

describe('eligibility, overrides and rejected command history', () => {
  it.each([
    [{ availability: 'UNAVAILABLE' }, 'UNAVAILABLE'],
    [{ capacityUnits: 1 }, 'INSUFFICIENT_CAPACITY'],
    [{ serviceZones: ['NORTH'] }, 'UNSUPPORTED_PICKUP_ZONE'],
    [{ serviceZones: ['CENTRAL'] }, 'UNSUPPORTED_DELIVERY_ZONE'],
  ])('rejects ineligible %j and audits failure without a reservation', async (change, reason) => {
    const { job, rider } = await seed(change);
    const res = await assign(job.id, rider.id, 'ineligible', 'Cannot bypass eligibility');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('RIDER_INELIGIBLE');
    expect(res.body.error.details).toContainEqual({ path: 'riderId', message: reason });
    expect(await models.Assignment.countDocuments()).toBe(0);
    const stored = await models.Job.findById(job.id).orFail();
    expect(stored.status).toBe('READY_FOR_ASSIGNMENT');
    expect(stored.version).toBe(0);
    const event = await models.JobEvent.findOne({ jobId: job.id }).orFail();
    expect(event).toMatchObject({ type: 'ASSIGNMENT_FAILED', actor, sequence: 1 });
    expect(event.details).toMatchObject({ code: 'RIDER_INELIGIBLE', riderId: rider.id });
    await assertWorkload(rider.id);
  });
  it('rejects corrupt counters rather than clamping or adding to them', async () => {
    const { job, rider } = await seed();
    await models.Rider.collection.updateOne(
      { _id: rider._id },
      { $set: { reservedUnits: 6, activeJobCount: 1 } },
    );
    const res = await assign(job.id, rider.id);
    expect(res.status).toBe(409);
    expect(res.body.error.details).toContainEqual({
      path: 'riderId',
      message: 'INVALID_WORKLOAD_COUNTERS',
    });
    expect((await models.Rider.findById(rider.id).orFail()).reservedUnits).toBe(6);
    expect(await models.Assignment.countDocuments()).toBe(0);
  });
  it('requires a non-top override reason, permits correction with the same rejected key and records actor/reason', async () => {
    const { job, rider: top } = await seed({ code: 'R-001' });
    const other = await models.Rider.create(riderFixture({ code: 'R-002' }));
    const rejected = await assign(job.id, other.id);
    expect(rejected.status).toBe(409);
    expect(rejected.body.error.code).toBe('OVERRIDE_REASON_REQUIRED');
    expect(await models.Assignment.countDocuments()).toBe(0);
    const res = await assign(job.id, other.id, 'command-1', '  Knows this customer  ');
    expect(res.status).toBe(201);
    expect(res.body.data.assignment.overrideReason).toBe('Knows this customer');
    const event = await models.JobEvent.findOne({ type: 'MANUAL_OVERRIDE' }).orFail();
    expect(event.actor).toBe(actor);
    expect(event.details).toEqual({
      reason: 'Knows this customer',
      recommendedRiderId: top.id,
      chosenRiderId: other.id,
      scoringVersion: 'v1',
    });
    expect(await models.JobEvent.countDocuments({ type: 'ASSIGNMENT_FAILED' })).toBe(1);
    await assertWorkload(top.id);
    await assertWorkload(other.id);
  });
  it('retains an optional reason for the top rider without claiming a manual override', async () => {
    const { job, rider } = await seed();
    const res = await assign(job.id, rider.id, 'command-1', 'Customer requested Arun');
    expect(res.status).toBe(201);
    expect(res.body.data.assignment.overrideReason).toBe('Customer requested Arun');
    expect(await models.JobEvent.countDocuments({ type: 'MANUAL_OVERRIDE' })).toBe(0);
  });
  it('recomputes ranking instead of trusting a previously viewed recommendation', async () => {
    const { job, rider: oldTop } = await seed({ code: 'R-001' });
    const newTop = await models.Rider.create(riderFixture({ code: 'R-002', currentZone: 'WEST' }));
    const rec = await request(app)
      .post(`/api/v1/jobs/${job.id}/recommendations`)
      .set('X-Actor-Id', actor)
      .send({});
    expect(rec.body.data.eligible[0].riderId).toBe(oldTop.id);
    await models.Rider.updateOne({ _id: oldTop._id }, { $set: { currentZone: 'NORTH' } });
    const stale = await assign(job.id, oldTop.id);
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('OVERRIDE_REASON_REQUIRED');
    const fresh = await assign(job.id, newTop.id);
    expect(fresh.status).toBe(201);
    expect(fresh.body.data.assignment.recommendationSnapshot.eligible[0].riderId).toBe(newTop.id);
  });
  it('records a missing rider failure for an existing job', async () => {
    const job = await models.Job.create(jobFixture({ status: 'READY_FOR_ASSIGNMENT' }));
    const res = await assign(job.id, '507f191e810c19729de860ea');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('RIDER_NOT_FOUND');
    expect(await models.JobEvent.countDocuments({ type: 'ASSIGNMENT_FAILED' })).toBe(1);
  });
});

describe('durable assignment replay', () => {
  it('replays the exact canonical request despite rider going offline or the clock passing expiry', async () => {
    const { job, rider } = await seed();
    const first = await assign(job.id, rider.id, 'command-1', ' Operational note ');
    expect(first.status).toBe(201);
    await request(app)
      .patch(`/api/v1/riders/${rider.id}`)
      .set('X-Actor-Id', actor)
      .send({ availability: 'UNAVAILABLE' });
    now = new Date(now.getTime() + 24 * 60 * 60_000);
    const replay = await assign(
      job.id.toUpperCase(),
      rider.id.toUpperCase(),
      'command-1',
      'Operational note',
    );
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.data.assignment).toEqual(first.body.data.assignment);
    expect(await models.JobEvent.countDocuments()).toBe(2);
    expect(await models.Assignment.countDocuments()).toBe(1);
    // Clock passage alone does not implement the Phase 7 timeout worker.
    expect(replay.body.data.job.status).toBe('AWAITING_CONFIRMATION');
    await assertWorkload(rider.id);
  });
  it('rejects changed payload on a successful key without altering its receipt', async () => {
    const { job, rider } = await seed();
    const first = await assign(job.id, rider.id);
    const res = await assign(job.id, rider.id, 'command-1', 'Changed payload');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(
      (await models.Assignment.findById(first.body.data.assignment.id).orFail()).overrideReason,
    ).toBeUndefined();
    expect(await models.Assignment.countDocuments()).toBe(1);
    expect(await models.JobEvent.countDocuments({ type: 'ASSIGNMENT_FAILED' })).toBe(1);
    await assertWorkload(rider.id);
  });
  it('scopes a key to a job and reserves once for each independent command', async () => {
    const { job, rider } = await seed();
    const other = await models.Job.create(jobFixture({ status: 'READY_FOR_ASSIGNMENT' }));
    expect((await assign(job.id, rider.id)).status).toBe(201);
    expect((await assign(other.id, rider.id)).status).toBe(201);
    expect((await models.Rider.findById(rider.id).orFail()).reservedUnits).toBe(4);
    await assertWorkload(rider.id);
  });
  it('recovers an actual committed assignment after a simulated lost commit reply', async () => {
    const { job, rider } = await seed();
    const original = connection.transaction.bind(connection);
    vi.spyOn(connection, 'transaction').mockImplementationOnce(async (work, options) => {
      await original(work, options);
      throw new mongoose.mongo.MongoServerError({
        message: 'lost successful assignment reply',
        errorLabels: ['UnknownTransactionCommitResult'],
      });
    });
    const res = await assign(job.id, rider.id);
    expect(res.status).toBe(200);
    expect(res.body.replayed).toBe(true);
    expect(await models.Assignment.countDocuments()).toBe(1);
    expect(await models.JobEvent.countDocuments({ type: 'ASSIGNMENT_FAILED' })).toBe(0);
    await assertWorkload(rider.id);
  });
  it('reports 503 without inventing failure history when an unknown outcome has no durable receipt', async () => {
    const { job, rider } = await seed();
    vi.spyOn(connection, 'transaction').mockRejectedValueOnce(
      new mongoose.mongo.MongoServerError({
        message: 'unknown outcome fixture',
        errorLabels: ['UnknownTransactionCommitResult'],
      }),
    );
    const res = await assign(job.id, rider.id);
    expect(res.status).toBe(503);
    expect(await models.Assignment.countDocuments()).toBe(0);
    expect(await models.JobEvent.countDocuments()).toBe(0);
    expect((await assign(job.id, rider.id)).status).toBe(201);
    await assertWorkload(rider.id);
  });
});

describe('invalid states, validation and rollback', () => {
  it.each(['NEW', 'AWAITING_CONFIRMATION', 'ACCEPTED', 'PICKED_UP', 'DELIVERED', 'CANCELLED'])(
    'rejects new commands in %s and records their failure',
    async (status) => {
      const { job, rider } = await seed();
      const active = ['AWAITING_CONFIRMATION', 'ACCEPTED', 'PICKED_UP'].includes(status);
      await models.Job.updateOne(
        { _id: job._id },
        {
          $set: {
            status,
            ...(active
              ? { assignedRiderId: rider._id, activeAssignmentId: new mongoose.Types.ObjectId() }
              : {}),
          },
        },
      );
      const res = await assign(job.id, rider.id);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe(active ? 'JOB_ALREADY_ASSIGNED' : 'INVALID_TRANSITION');
      expect(await models.JobEvent.countDocuments({ type: 'ASSIGNMENT_FAILED' })).toBe(1);
      expect(await models.Assignment.countDocuments()).toBe(0);
      expect((await models.Job.findById(job.id).orFail()).status).toBe(status);
    },
  );
  it('rejects malformed input/missing key/actor and missing jobs without false job history', async () => {
    const { job, rider } = await seed();
    const path = `/api/v1/jobs/${job.id}/assignments`;
    expect(
      (await request(app).post(path).set('X-Actor-Id', actor).send({ riderId: rider.id })).status,
    ).toBe(400);
    expect(
      (await request(app).post(path).set('Idempotency-Key', 'key').send({ riderId: rider.id }))
        .status,
    ).toBe(400);
    const invalid = await request(app)
      .post(path + '?unknown=1')
      .set('X-Actor-Id', actor)
      .set('Idempotency-Key', 'key')
      .send({ riderId: rider.id });
    expect(invalid.status).toBe(400);
    expect(invalid.body.requestId).toBe(invalid.headers['x-request-id']);
    expect((await assign('bad', rider.id)).status).toBe(400);
    const missing = await assign('507f191e810c19729de860ea', rider.id);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('JOB_NOT_FOUND');
    expect(await models.JobEvent.countDocuments()).toBe(0);
  });
  it('returns 503 before calling dispatch when readiness is false', async () => {
    const dispatch = createDispatchService({ connection, models, responseThresholdMs: 5000 });
    const spy = vi.spyOn(dispatch, 'assign');
    const unready = createApp({ isReady: () => false, dispatch });
    const res = await request(unready)
      .post('/api/v1/jobs/507f191e810c19729de860ea/assignments')
      .set('X-Actor-Id', actor)
      .set('Idempotency-Key', 'key')
      .send({ riderId: '507f191e810c19729de860eb' });
    expect(res.status).toBe(503);
    expect(spy).not.toHaveBeenCalled();
  });
  it('rolls back job, reservation, attempt and first audit event if the second insert fails', async () => {
    const { job, rider } = await seed();
    const original = models.JobEvent.collection.insertOne.bind(models.JobEvent.collection);
    vi.spyOn(models.JobEvent.collection, 'insertOne')
      .mockImplementationOnce((...args) => original(...args))
      .mockRejectedValueOnce(new Error('audit insert failed'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await assign(job.id, rider.id)).status).toBe(500);
    const stored = await models.Job.findById(job.id).orFail();
    expect(stored).toMatchObject({ status: 'READY_FOR_ASSIGNMENT', version: 0, eventSequence: 0 });
    expect(stored.activeAssignmentId).toBeUndefined();
    expect(await models.Assignment.countDocuments()).toBe(0);
    expect(await models.JobEvent.countDocuments()).toBe(0);
    await assertWorkload(rider.id);
  });
  it('returns 503 if failure audit cannot be confirmed, rather than claiming recorded rejection', async () => {
    const { job, rider } = await seed({ availability: 'UNAVAILABLE' });
    vi.spyOn(models.JobEvent.collection, 'insertOne').mockRejectedValueOnce(
      new Error('failure audit unavailable'),
    );
    const res = await assign(job.id, rider.id);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(await models.JobEvent.countDocuments()).toBe(0);
    expect(await models.Assignment.countDocuments()).toBe(0);
    await assertWorkload(rider.id);
  });
});
