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

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
describe('public investigation and reassignment workflow', () => {
  it.each(['reject', 'expire'] as const)(
    'investigates a real %s entry, reassigns with a new key, preserves history and accepts the new ID',
    async (outcome) => {
      const riderId = await rider();
      const id = await readyJob();
      const first = (await assign(id, riderId)).body.data.assignment;
      if (outcome === 'reject') await reject(first.id);
      else {
        now = new Date(first.expiresAt);
        await resolution.expire(first.id);
      }
      const row = (await queue()).body.data[0];
      expect(row.id).toBe(id);
      expect(row.latestAttempt.id).toBe(first.id);
      expect(row.manualReason).toBe(outcome === 'reject' ? 'RIDER_REJECTED' : 'RESPONSE_TIMEOUT');
      const before = await request(app).get(`/api/v1/jobs/${row.id}/history`);
      expect(before.body.data.attempts).toHaveLength(1);
      expect(
        (await post(`/api/v1/jobs/${row.id}/recommendations`, {})).body.data.eligible[0].riderId,
      ).toBe(riderId);
      const next = await assign(row.id, riderId, 'new-manual-action');
      expect(next.status).toBe(201);
      expect((await queue()).body.pagination.total).toBe(0);
      const replay = await assign(row.id, riderId, 'new-manual-action');
      expect(replay.status).toBe(200);
      expect(replay.body.data.assignment.id).toBe(next.body.data.assignment.id);
      expect((await post(`/api/v1/assignments/${first.id}/accept`, {})).status).toBe(409);
      expect(
        (await post(`/api/v1/assignments/${next.body.data.assignment.id}/accept`, {})).status,
      ).toBe(200);
      const history = await request(app).get(`/api/v1/jobs/${id}/history`);
      expect(history.body.data.attempts.map((a: { status: string }) => a.status)).toEqual([
        outcome === 'reject' ? 'REJECTED' : 'EXPIRED',
        'ACCEPTED',
      ]);
      expect(
        history.body.data.events.filter((event: { type: string }) => event.type === 'REASSIGNED'),
      ).toHaveLength(1);
      const workload = await request(app).get(`/api/v1/riders/${riderId}`);
      expect(workload.body.data).toMatchObject({
        reservedUnits: 2,
        activeJobCount: 1,
        availableUnits: 3,
      });
    },
  );
  it('dispatches a no-candidate entry once a rider exists without fabricating an older assignment', async () => {
    const id = await readyJob();
    await post(`/api/v1/jobs/${id}/recommendations`, {});
    expect((await queue()).body.data[0].latestAttempt).toBeNull();
    const riderId = await rider();
    const next = await assign(id, riderId, 'first-real-assignment');
    expect(next.status).toBe(201);
    expect((await queue()).body.data).toEqual([]);
    expect(await models.Assignment.countDocuments({ jobId: id })).toBe(1);
    expect(await models.JobEvent.countDocuments({ jobId: id, type: 'REASSIGNED' })).toBe(0);
  });
  it('shows a rejected override command on the queue, then records a valid non-top reassignment reason', async () => {
    const firstRider = await rider('R-001');
    const secondRider = await rider('R-002');
    const id = await readyJob();
    const first = (await assign(id, firstRider)).body.data.assignment;
    await reject(first.id);
    const rejected = await assign(id, secondRider, 'manual-override');
    expect(rejected.status).toBe(409);
    expect((await queue()).body.data[0].latestAssignmentFailure.code).toBe(
      'OVERRIDE_REASON_REQUIRED',
    );
    const next = await assign(id, secondRider, 'manual-override', 'Customer requested this rider');
    expect(next.status).toBe(201);
    expect((await queue()).body.data).toEqual([]);
    const history = await request(app).get(`/api/v1/jobs/${id}/history`);
    expect(
      history.body.data.events.find((event: { type: string }) => event.type === 'MANUAL_OVERRIDE')
        .details,
    ).toMatchObject({
      recommendedRiderId: firstRider,
      chosenRiderId: secondRider,
      reason: 'Customer requested this rider',
    });
  });
  it('allows one of eight manual reassignment commands and retains seven visible conflicts without leaking capacity', async () => {
    const riderId = await rider();
    const id = await readyJob();
    const first = (await assign(id, riderId)).body.data.assignment;
    await reject(first.id);
    expect((await queue()).body.pagination.total).toBe(1);
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, i) => assign(id, riderId, `manual-${i}`)),
    );
    expect(responses.filter((res) => res.status === 201)).toHaveLength(1);
    expect(
      responses.filter(
        (res) => res.status === 409 && res.body.error.code === 'JOB_ALREADY_ASSIGNED',
      ),
    ).toHaveLength(7);
    expect((await queue()).body.data).toEqual([]);
    expect(await models.Assignment.countDocuments({ jobId: id })).toBe(2);
    expect(await models.Assignment.countDocuments({ jobId: id, active: true })).toBe(1);
    expect(await models.JobEvent.countDocuments({ jobId: id, type: 'ASSIGNMENT_FAILED' })).toBe(7);
    expect((await models.Rider.findById(riderId).orFail()).reservedUnits).toBe(2);
  });
  it('keeps total, membership and summaries on one snapshot when reassignment commits between queue reads', async () => {
    const riderId = await rider();
    const id = await readyJob();
    const first = (await assign(id, riderId)).body.data.assignment;
    await reject(first.id);
    const reached = barrier();
    const resume = barrier();
    const original = models.Job.collection.countDocuments.bind(models.Job.collection);
    const gate = vi
      .spyOn(models.Job.collection, 'countDocuments')
      .mockImplementationOnce(async (...args) => {
        const total = await original(...args); // The real first read establishes the snapshot.
        reached.release();
        await resume.promise;
        return total;
      });
    const reading = queue().then((res) => res);
    try {
      await reached.promise;
      expect((await assign(id, riderId, 'concurrent-reassignment')).status).toBe(201);
      resume.release();
      const snapshot = await reading;
      expect(snapshot.status).toBe(200);
      expect(snapshot.body.pagination.total).toBe(1);
      expect(snapshot.body.data[0]).toMatchObject({
        id,
        status: 'MANUAL_QUEUE',
        latestAttempt: { id: first.id, status: 'REJECTED' },
      });
      expect((await queue()).body).toMatchObject({ data: [], pagination: { total: 0 } });
    } finally {
      resume.release();
      gate.mockRestore();
      await reading;
    }
  });
  it('returns a safe dependency error when a summary query times out without modifying the queue', async () => {
    const job = await seedManualJob();
    vi.spyOn(models.JobEvent.collection, 'aggregate').mockImplementationOnce(() => {
      throw new mongoose.mongo.MongoServerError({
        message: 'private diagnostic fixture',
        code: 50,
      });
    });
    const res = await queue();
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(JSON.stringify(res.body)).not.toContain('private diagnostic');
    expect((await models.Job.findById(job.id).orFail()).status).toBe('MANUAL_QUEUE');
    expect(await models.JobEvent.countDocuments()).toBe(1);
  });
});
