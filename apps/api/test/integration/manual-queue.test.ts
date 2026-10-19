import mongoose, { type Connection } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MongoMemoryReplSet } from 'mongodb-memory-server-core';
import { createApp } from '../../src/app.js';
import { createJobsService } from '../../src/modules/jobs/service.js';
import { createRidersService } from '../../src/modules/riders/service.js';
import { createRecommendationsService } from '../../src/modules/recommendations/service.js';
import { createDispatchService } from '../../src/modules/dispatch/service.js';
import {
  createResolutionService,
  type ResolutionService,
} from '../../src/modules/dispatch/resolution.js';
import { createManualQueueService } from '../../src/modules/manual-queue/service.js';
import { createTimeoutScanner } from '../../src/modules/worker/timeout-scanner.js';
import {
  createPersistenceModels,
  type PersistenceModels,
} from '../../src/modules/persistence/models.js';
import { initializePersistence } from '../../src/modules/persistence/initialize.js';
import { runInTransaction } from '../../src/modules/persistence/transaction.js';
import { appendJobEvent } from '../../src/modules/history/append-event.js';
import { startTestReplicaSet } from '../helpers/mongo.js';
import { jobFixture } from '../helpers/fixtures.js';

let replica: MongoMemoryReplSet;
let connection: Connection;
let models: PersistenceModels;
let app: ReturnType<typeof createApp>;
let resolution: ResolutionService;
let now: Date;
const actor = 'dispatcher:meena';
const post = (path: string, body: object, key?: string) => {
  const req = request(app).post(path).set('X-Actor-Id', actor);
  if (key) req.set('Idempotency-Key', key);
  return req.send(body);
};
async function readyJob(reference = 'QUEUE-001', changes: Record<string, unknown> = {}) {
  const created = await post('/api/v1/jobs', {
    orderReference: reference,
    pickupZone: 'CENTRAL',
    deliveryZone: 'NORTH',
    loadUnits: 2,
    ...changes,
  });
  expect(created.status).toBe(201);
  const id = created.body.data.id as string;
  expect((await post(`/api/v1/jobs/${id}/ready`, {})).status).toBe(200);
  return id;
}
async function rider(code = 'R-001', changes: Record<string, unknown> = {}) {
  const created = await post('/api/v1/riders', {
    code,
    name: 'Arun',
    serviceZones: ['CENTRAL', 'NORTH'],
    currentZone: 'CENTRAL',
    capacityUnits: 5,
    ...changes,
  });
  expect(created.status).toBe(201);
  return created.body.data.id as string;
}
async function assign(jobId: string, riderId: string, key = 'attempt-1', overrideReason?: string) {
  return post(
    `/api/v1/jobs/${jobId}/assignments`,
    { riderId, ...(overrideReason ? { overrideReason } : {}) },
    key,
  );
}
const reject = (id: string, reason = 'Route blocked') =>
  request(app)
    .post(`/api/v1/assignments/${id}/reject`)
    .set('X-Actor-Id', 'rider:arun')
    .send({ reason });
const queue = (query = '') => request(app).get(`/api/v1/manual-queue${query}`);

beforeAll(async () => {
  replica = await startTestReplicaSet();
  connection = await mongoose
    .createConnection(replica.getUri('relay_manual_queue_test'), {
      autoCreate: false,
      autoIndex: false,
    })
    .asPromise();
  models = createPersistenceModels(connection);
  await initializePersistence(connection);
  const deps = { connection, models, clock: { now: () => new Date(now) } };
  resolution = createResolutionService(deps);
  app = createApp({
    isReady: () => connection.readyState === 1,
    jobs: createJobsService(deps),
    riders: createRidersService(deps),
    recommendations: createRecommendationsService(deps),
    dispatch: createDispatchService({ ...deps, responseThresholdMs: 5000 }),
    resolution,
    manualQueue: createManualQueueService(deps),
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

// Read-model fixtures only: actual manual-entry/reassignment workflows below use
// public APIs and real expiry transactions rather than fabricated terminal work.
async function seedManualJob(changes: Record<string, unknown> = {}, occurredAt = now) {
  return runInTransaction(connection, async (session) => {
    const [job] = await models.Job.create(
      [
        jobFixture({
          status: 'MANUAL_QUEUE',
          manualReason: 'NO_ELIGIBLE_RIDER',
          createdAt: now,
          updatedAt: now,
          ...changes,
        }),
      ],
      { session },
    );
    if (!job) throw new Error('Fixture creation failed');
    await appendJobEvent(models, session, {
      jobId: job._id,
      type: 'MANUAL_QUEUE_ENTERED',
      actor,
      occurredAt,
      details: { reason: job.manualReason! },
    });
    return job;
  });
}

describe('manual queue investigation', () => {
  it('returns an empty bounded queue with an explicit observation time', async () => {
    const res = await queue();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: [],
      asOf: now.toISOString(),
      pagination: { page: 1, pageSize: 20, total: 0 },
    });
  });
  it('shows public no-candidate entry with audit-based age, actor and no fake attempt', async () => {
    const id = await readyJob();
    now = new Date(now.getTime() + 1000);
    expect((await post(`/api/v1/jobs/${id}/recommendations`, {})).body.data.jobStatus).toBe(
      'MANUAL_QUEUE',
    );
    const enteredAt = new Date(now);
    now = new Date(now.getTime() + 5000);
    const res = await queue();
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      id,
      status: 'MANUAL_QUEUE',
      manualReason: 'NO_ELIGIBLE_RIDER',
      activeAssignmentId: null,
      assignedRiderId: null,
      manualEnteredAt: enteredAt.toISOString(),
      manualAgeMs: 5000,
      manualEntryActor: actor,
      historyIncomplete: false,
      latestAttempt: null,
      latestAssignmentFailure: null,
    });
    expect(res.body.asOf).toBe(now.toISOString());
  });
  it('summarizes a real rejection without copying large recommendation snapshots or private receipt fields', async () => {
    const riderId = await rider();
    const id = await readyJob();
    const attempt = (await assign(id, riderId)).body.data.assignment;
    expect((await reject(attempt.id)).status).toBe(200);
    now = new Date(now.getTime() + 1000);
    const res = await queue();
    expect(res.body.data[0]).toMatchObject({
      id,
      manualReason: 'RIDER_REJECTED',
      manualAgeMs: 1000,
      manualEntryActor: 'rider:arun',
      latestAttempt: {
        id: attempt.id,
        riderId,
        status: 'REJECTED',
        active: false,
        loadUnits: 2,
        endReason: 'Route blocked',
        reservationReleasedAt: attempt.assignedAt,
      },
    });
    expect(JSON.stringify(res.body)).not.toMatch(
      /requestHash|requestKey|creationKey|recommendationSnapshot|scoringVersion|__v/,
    );
    const history = await request(app).get(`/api/v1/jobs/${id}/history`);
    expect(history.body.data.attempts[0].recommendationSnapshot).toBeDefined();
  });
  it('summarizes a scanned timeout with retained expired attempt and worker attribution', async () => {
    const riderId = await rider();
    const id = await readyJob();
    const assigned = await assign(id, riderId);
    now = new Date(assigned.body.data.assignment.expiresAt);
    const scanner = createTimeoutScanner({ models, resolution, clock: { now: () => now } });
    expect((await scanner.scan()).expired).toBe(1);
    const res = await queue();
    expect(res.body.data[0]).toMatchObject({
      id,
      manualReason: 'RESPONSE_TIMEOUT',
      manualEntryActor: 'system:timeout-worker',
      manualAgeMs: 0,
      latestAttempt: {
        id: assigned.body.data.assignment.id,
        status: 'EXPIRED',
        active: false,
        respondedAt: null,
        endReason: 'RESPONSE_TIMEOUT',
      },
    });
  });
  it('keeps entry age stable through reevaluation and failed assignment attempts while showing the latest failure', async () => {
    const id = await readyJob();
    await post(`/api/v1/jobs/${id}/recommendations`, {});
    const enteredAt = new Date(now);
    const riderId = await rider('R-OFFLINE', { availability: 'UNAVAILABLE' });
    now = new Date(now.getTime() + 1000);
    await post(`/api/v1/jobs/${id}/recommendations`, {});
    const first = await assign(id, riderId, 'failed-1');
    expect(first.status).toBe(409);
    now = new Date(now.getTime() + 1000);
    expect((await assign(id, riderId, 'failed-2')).status).toBe(409);
    const before = await models.JobEvent.countDocuments();
    const res = await queue();
    await queue();
    expect(res.body.data[0]).toMatchObject({
      manualEnteredAt: enteredAt.toISOString(),
      manualAgeMs: 2000,
      latestAttempt: null,
      latestAssignmentFailure: {
        code: 'RIDER_INELIGIBLE',
        riderId,
        actor,
        occurredAt: now.toISOString(),
        sequence: 7,
      },
    });
    expect(res.body.data[0].latestAssignmentFailure.reason).toContain('UNAVAILABLE');
    const history = await request(app).get(`/api/v1/jobs/${id}/history`);
    expect(history.body.data.events.map((event: { type: string }) => event.type)).toEqual([
      'JOB_CREATED',
      'JOB_READY',
      'RIDERS_RECOMMENDED',
      'MANUAL_QUEUE_ENTERED',
      'RIDERS_RECOMMENDED',
      'ASSIGNMENT_FAILED',
      'ASSIGNMENT_FAILED',
    ]);
    expect(await models.JobEvent.countDocuments()).toBe(before);
  });
  it('resets waiting time only on a new manual entry and picks the latest attempt across repeated dispatch cycles', async () => {
    const riderId = await rider();
    const id = await readyJob();
    const first = (await assign(id, riderId, 'first')).body.data.assignment;
    await reject(first.id);
    const initial = (await queue()).body.data[0];
    now = new Date(now.getTime() + 1000);
    const second = (await assign(id, riderId, 'second')).body.data.assignment;
    expect((await queue()).body.data).toEqual([]);
    now = new Date(second.expiresAt);
    await resolution.expire(second.id);
    const enteredAt = new Date(now);
    now = new Date(now.getTime() + 2000);
    const current = (await queue()).body.data[0];
    expect(current.manualEnteredAt).not.toBe(initial.manualEnteredAt);
    expect(current).toMatchObject({
      manualReason: 'RESPONSE_TIMEOUT',
      manualEnteredAt: enteredAt.toISOString(),
      manualAgeMs: 2000,
      latestAttempt: { id: second.id, status: 'EXPIRED' },
    });
    const history = await request(app).get(`/api/v1/jobs/${id}/history`);
    expect(history.body.data.attempts.map((a: { status: string }) => a.status)).toEqual([
      'REJECTED',
      'EXPIRED',
    ]);
  });
});

describe('queue bounds, filters and incomplete evidence', () => {
  it('filters either zone and excludes all other job states', async () => {
    const north = await seedManualJob({ orderReference: 'Q-NORTH' });
    const south = await seedManualJob({
      orderReference: 'Q-SOUTH',
      pickupZone: 'SOUTH',
      deliveryZone: 'WEST',
    });
    await models.Job.create(jobFixture({ status: 'READY_FOR_ASSIGNMENT' }));
    const res = await queue('?zone=north');
    expect(res.body.data.map((j: { id: string }) => j.id)).toEqual([north.id]);
    expect((await queue('?zone=WEST')).body.data[0].id).toBe(south.id);
    expect((await queue('?zone=EAST')).body).toMatchObject({ data: [], pagination: { total: 0 } });
    expect((await queue()).body.pagination.total).toBe(2);
  });
  it('orders oldest received first with ID ties and bounds both rows and summaries', async () => {
    const jobs = [];
    for (const orderReference of ['Q-3', 'Q-1', 'Q-2'])
      jobs.push(await seedManualJob({ orderReference }));
    const ordered = [...jobs].sort((a, b) => a.id.localeCompare(b.id));
    const first = await queue('?pageSize=2');
    const second = await queue('?pageSize=2&page=2');
    expect(first.body.data.map((j: { id: string }) => j.id)).toEqual(
      ordered.slice(0, 2).map((j) => j.id),
    );
    expect(second.body.data.map((j: { id: string }) => j.id)).toEqual([ordered[2]!.id]);
    expect(first.body.pagination).toEqual({ page: 1, pageSize: 2, total: 3 });
    expect((await queue('?page=3&pageSize=2')).body).toMatchObject({
      data: [],
      pagination: { total: 3 },
    });
  });
  it('does not claim manual-entry order when a newer received job entered manual earlier', async () => {
    const older = await seedManualJob({ createdAt: new Date(now.getTime() - 60000) }, now);
    const newer = await seedManualJob({}, new Date(now.getTime() - 30000));
    const res = await queue();
    expect(res.body.data.map((j: { id: string }) => j.id)).toEqual([older.id, newer.id]);
    expect(res.body.data.map((j: { manualAgeMs: number }) => j.manualAgeMs)).toEqual([0, 30000]);
  });
  it('marks missing entry evidence without inventing a timestamp from job.updatedAt', async () => {
    const job = await models.Job.create(
      jobFixture({ status: 'MANUAL_QUEUE', manualReason: 'NO_ELIGIBLE_RIDER' }),
    );
    const res = await queue();
    expect(res.body.data[0]).toMatchObject({
      id: job.id,
      historyIncomplete: true,
      manualEnteredAt: null,
      manualAgeMs: null,
      manualEntryActor: null,
    });
  });
  it('marks mismatched manual reason evidence and leaves stored records untouched', async () => {
    const job = await seedManualJob();
    await models.Job.collection.updateOne(
      { _id: job._id },
      { $set: { manualReason: 'RESPONSE_TIMEOUT' } },
    );
    const res = await queue();
    expect(res.body.data[0]).toMatchObject({
      historyIncomplete: true,
      manualReason: 'RESPONSE_TIMEOUT',
      manualEnteredAt: null,
      manualAgeMs: null,
    });
    expect(await models.JobEvent.countDocuments()).toBe(1);
  });
  it('floors waiting duration at zero if the observation clock precedes its stored event', async () => {
    await seedManualJob({}, new Date(now.getTime() + 1000));
    expect((await queue()).body.data[0].manualAgeMs).toBe(0);
  });
  it.each([
    'page=0',
    'pageSize=101',
    'zone=UNKNOWN',
    'zone=NORTH&zone=SOUTH',
    'zone[$ne]=NORTH',
    'status=NEW',
  ])('rejects invalid query %s', async (query) => {
    const res = await queue('?' + query);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
  });
  it('returns 503 without calling the queue service when persistence is unavailable', async () => {
    const manualQueue = createManualQueueService({ connection, models });
    const spy = vi.spyOn(manualQueue, 'list');
    const unready = createApp({ isReady: () => false, manualQueue });
    expect((await request(unready).get('/api/v1/manual-queue')).status).toBe(503);
    expect(spy).not.toHaveBeenCalled();
  });
});
