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
import { createJobsService } from '../../src/modules/jobs/service.js';
import { createRidersService } from '../../src/modules/riders/service.js';
import {
  createPersistenceModels,
  type PersistenceModels,
} from '../../src/modules/persistence/models.js';
import { initializePersistence } from '../../src/modules/persistence/initialize.js';
import { startTestReplicaSet } from '../helpers/mongo.js';
import { jobFixture, riderFixture } from '../helpers/fixtures.js';
import { createTimeoutScanner } from '../../src/modules/worker/timeout-scanner.js';

let replica: MongoMemoryReplSet;
let connection: Connection;
let models: PersistenceModels;
let app: ReturnType<typeof createApp>;
let resolution: ResolutionService;
let now: Date;
const actor = 'rider:arun';
const accept = (id: string) =>
  request(app).post(`/api/v1/assignments/${id}/accept`).set('X-Actor-Id', actor).send({});
const reject = (id: string, reason = 'Cannot take this route') =>
  request(app).post(`/api/v1/assignments/${id}/reject`).set('X-Actor-Id', actor).send({ reason });
async function newWork(riderId?: string) {
  const rider = riderId
    ? await models.Rider.findById(riderId).orFail()
    : await models.Rider.create(riderFixture());
  const job = await models.Job.create(jobFixture({ status: 'READY_FOR_ASSIGNMENT' }));
  const res = await request(app)
    .post(`/api/v1/jobs/${job.id}/assignments`)
    .set('X-Actor-Id', 'dispatcher:demo')
    .set('Idempotency-Key', `assign-${job.id}`)
    .send({ riderId: rider.id, overrideReason: 'Operational test choice' });
  expect(res.status).toBe(201);
  const attempt = await models.Assignment.findById(res.body.data.assignment.id).orFail();
  return { job, rider, attempt };
}
async function workload(id: string, units: number, count: number) {
  const rider = await models.Rider.findById(id).orFail();
  const active = await models.Assignment.find({ riderId: id, active: true }).lean();
  expect(rider.reservedUnits).toBe(units);
  expect(rider.activeJobCount).toBe(count);
  expect(active.reduce((sum, attempt) => sum + attempt.loadUnits, 0)).toBe(units);
  expect(active).toHaveLength(count);
}
beforeAll(async () => {
  replica = await startTestReplicaSet();
  connection = await mongoose
    .createConnection(replica.getUri('relay_resolution_test'), {
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
    dispatch: createDispatchService({ ...deps, responseThresholdMs: 5000 }),
    resolution,
  });
});

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
describe('actual concurrent responses and timeout decisions', () => {
  it.each(['accept', 'reject'] as const)(
    'eight repeated %s requests commit one outcome and preserve counters',
    async (action) => {
      const { rider, attempt } = await newWork();
      const responses = await Promise.all(
        Array.from({ length: 8 }, () =>
          action === 'accept' ? accept(attempt.id) : reject(attempt.id),
        ),
      );
      expect(responses.every((r) => r.status === 200)).toBe(true);
      expect(responses.filter((r) => !r.body.replayed)).toHaveLength(1);
      expect(
        await models.JobEvent.countDocuments({
          type: action === 'accept' ? 'ASSIGNMENT_ACCEPTED' : 'ASSIGNMENT_REJECTED',
        }),
      ).toBe(1);
      expect(await models.JobEvent.countDocuments({ type: 'MANUAL_QUEUE_ENTERED' })).toBe(
        action === 'reject' ? 1 : 0,
      );
      await workload(rider.id, action === 'accept' ? 2 : 0, action === 'accept' ? 1 : 0);
    },
  );
  it('eight concurrent expiry calls release once and retain one expired attempt', async () => {
    const { rider, attempt } = await newWork();
    now = new Date(attempt.expiresAt);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => resolution.expire(attempt.id)),
    );
    expect(results.filter((r) => r.expired)).toHaveLength(1);
    expect(await models.JobEvent.countDocuments({ type: 'ASSIGNMENT_EXPIRED' })).toBe(1);
    expect(await models.JobEvent.countDocuments({ type: 'MANUAL_QUEUE_ENTERED' })).toBe(1);
    expect(await models.Assignment.countDocuments()).toBe(1);
    await workload(rider.id, 0, 0);
  });
  it('opposing timely accept/reject has one winner and no mixed state', async () => {
    const { job, rider, attempt } = await newWork();
    const responses = await Promise.all([accept(attempt.id), reject(attempt.id)]);
    expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 409)).toHaveLength(1);
    const stored = await models.Assignment.findById(attempt.id).orFail();
    const accepted = stored.status === 'ACCEPTED';
    expect((await models.Job.findById(job.id).orFail()).status).toBe(
      accepted ? 'ACCEPTED' : 'MANUAL_QUEUE',
    );
    expect(
      await models.JobEvent.countDocuments({
        type: { $in: ['ASSIGNMENT_ACCEPTED', 'ASSIGNMENT_REJECTED'] },
      }),
    ).toBe(1);
    await workload(rider.id, accepted ? 2 : 0, accepted ? 1 : 0);
  });
  it('confirmation versus expiry at equality always yields one expiry, no acceptance and one release', async () => {
    const { rider, attempt } = await newWork();
    now = new Date(attempt.expiresAt);
    const [response] = await Promise.all([accept(attempt.id), resolution.expire(attempt.id)]);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('ASSIGNMENT_EXPIRED');
    expect(await models.JobEvent.countDocuments({ type: 'ASSIGNMENT_ACCEPTED' })).toBe(0);
    expect(await models.JobEvent.countDocuments({ type: 'ASSIGNMENT_EXPIRED' })).toBe(1);
    await workload(rider.id, 0, 0);
  });
  it.each(['accept', 'expire'] as const)(
    'a pre-deadline acceptance and due expiry race preserves the winning %s decision',
    async (winner) => {
      const { rider, attempt } = await newWork();
      now = new Date(attempt.expiresAt.getTime() - 1);
      const reached = barrier();
      const resume = barrier();
      const expiryReached = barrier();
      const expiryResume = barrier();
      const original = models.Job.collection.findOneAndUpdate.bind(models.Job.collection);
      const gate = vi
        .spyOn(models.Job.collection, 'findOneAndUpdate')
        .mockImplementationOnce(async (...args) => {
          // Pause before MongoDB's first write, after the callback captured its time.
          reached.release();
          await resume.promise;
          return original(...args);
        })
        .mockImplementationOnce(async (...args) => {
          expiryReached.release();
          await expiryResume.promise;
          return original(...args);
        });
      const response = accept(attempt.id).then((res) => res);
      let expiration: ReturnType<ResolutionService['expire']> | undefined;
      try {
        await reached.promise;
        now = new Date(attempt.expiresAt);
        expiration = resolution.expire(attempt.id);
        await expiryReached.promise;
        if (winner === 'expire') {
          expiryResume.release();
          expect((await expiration).expired).toBe(true);
          resume.release();
          expect((await response).status).toBe(409);
        } else {
          resume.release();
          expect((await response).status).toBe(200);
          expiryResume.release();
          expect((await expiration).expired).toBe(false);
        }
        expect(
          await models.JobEvent.countDocuments({
            type: winner === 'accept' ? 'ASSIGNMENT_ACCEPTED' : 'ASSIGNMENT_EXPIRED',
          }),
        ).toBe(1);
        expect(
          await models.JobEvent.countDocuments({
            type: winner === 'accept' ? 'ASSIGNMENT_EXPIRED' : 'ASSIGNMENT_ACCEPTED',
          }),
        ).toBe(0);
        await workload(rider.id, winner === 'accept' ? 2 : 0, winner === 'accept' ? 1 : 0);
      } finally {
        resume.release();
        expiryResume.release();
        gate.mockRestore();
        await response;
        await expiration;
      }
    },
  );
  it('retries a pre-deadline decision with a fresh time after an unrelated job write conflicts', async () => {
    const { job, rider, attempt } = await newWork();
    now = new Date(attempt.expiresAt.getTime() - 1);
    const reached = barrier();
    const resume = barrier();
    const original = models.Job.collection.findOneAndUpdate.bind(models.Job.collection);
    const gate = vi
      .spyOn(models.Job.collection, 'findOneAndUpdate')
      .mockImplementationOnce(async (...args) => {
        reached.release();
        await resume.promise;
        return original(...args);
      });
    const response = accept(attempt.id).then((res) => res);
    try {
      await reached.promise;
      // Controlled unrelated write forces a real transaction retry. It does not
      // implement a new business action or manufacture a confirmation event.
      await models.Job.updateOne({ _id: job._id }, { $set: { updatedAt: now } });
      now = new Date(attempt.expiresAt);
      resume.release();
      expect((await response).status).toBe(409);
      expect((await models.Assignment.findById(attempt.id).orFail()).status).toBe('EXPIRED');
      await workload(rider.id, 0, 0);
    } finally {
      resume.release();
      gate.mockRestore();
      await response;
    }
  });
});

describe('persisted deadline scans and restart recovery', () => {
  const scanner = (batchSize = 100, onAttemptError = (_id: string) => {}) =>
    createTimeoutScanner({
      models,
      resolution,
      clock: { now: () => new Date(now) },
      batchSize,
      onAttemptError,
    });
  it('finds work created by an earlier service instance and expires it after simulated downtime', async () => {
    const { rider, attempt } = await newWork();
    now = new Date(attempt.expiresAt.getTime() + 3600_000);
    const restartedResolution = createResolutionService({
      connection,
      models,
      clock: { now: () => new Date(now) },
    });
    const restartedScanner = createTimeoutScanner({
      models,
      resolution: restartedResolution,
      clock: { now: () => new Date(now) },
    });
    expect(await restartedScanner.scan()).toEqual({ examined: 1, expired: 1, failed: 0 });
    expect(await restartedScanner.scan()).toEqual({ examined: 0, expired: 0, failed: 0 });
    await workload(rider.id, 0, 0);
  });
  it('bounds each ordered batch, leaves future work alone and drains later scans', async () => {
    const first = await newWork();
    now = new Date(now.getTime() + 1000);
    const second = await newWork();
    now = new Date(now.getTime() + 1000);
    const third = await newWork();
    now = new Date(second.attempt.expiresAt);
    const scan = scanner(1);
    expect(await scan.scan()).toEqual({ examined: 1, expired: 1, failed: 0 });
    expect((await models.Assignment.findById(first.attempt.id).orFail()).status).toBe('EXPIRED');
    expect((await models.Assignment.findById(second.attempt.id).orFail()).status).toBe('PENDING');
    expect(await scan.scan()).toEqual({ examined: 1, expired: 1, failed: 0 });
    expect(await scan.scan()).toEqual({ examined: 0, expired: 0, failed: 0 });
    expect((await models.Assignment.findById(third.attempt.id).orFail()).status).toBe('PENDING');
  });
  it('continues after one failed attempt and retries it on a later scan', async () => {
    const first = await newWork();
    const second = await newWork();
    now = new Date(second.attempt.expiresAt);
    const original = models.JobEvent.collection.insertOne.bind(models.JobEvent.collection);
    vi.spyOn(models.JobEvent.collection, 'insertOne')
      .mockRejectedValueOnce(new Error('temporary audit error'))
      .mockImplementation((...args) => original(...args));
    const onAttemptError = vi.fn();
    const scan = scanner(100, onAttemptError);
    expect(await scan.scan()).toEqual({ examined: 2, expired: 1, failed: 1 });
    expect(onAttemptError).toHaveBeenCalledTimes(1);
    expect(await scan.scan()).toEqual({ examined: 1, expired: 1, failed: 0 });
    await workload(first.rider.id, 0, 0);
    await workload(second.rider.id, 0, 0);
  });
  it('allows duplicate scanner instances without duplicate expiry/release events', async () => {
    const { rider, attempt } = await newWork();
    now = new Date(attempt.expiresAt);
    const results = await Promise.all([scanner().scan(), scanner().scan()]);
    expect(results.reduce((sum, r) => sum + r.expired, 0)).toBe(1);
    expect(results.every((r) => r.failed === 0)).toBe(true);
    expect(await models.JobEvent.countDocuments({ type: 'ASSIGNMENT_EXPIRED' })).toBe(1);
    await workload(rider.id, 0, 0);
  });
  it('ignores accepted work and obeys a stop signal before starting another transaction', async () => {
    const first = await newWork();
    const second = await newWork(first.rider.id);
    await accept(first.attempt.id);
    now = new Date(second.attempt.expiresAt);
    expect(await scanner().scan(() => true)).toEqual({ examined: 0, expired: 0, failed: 0 });
    expect(await scanner().scan()).toEqual({ examined: 1, expired: 1, failed: 0 });
    expect((await models.Assignment.findById(first.attempt.id).orFail()).status).toBe('ACCEPTED');
    await workload(first.rider.id, 2, 1);
  });
  it('propagates shortlist query failure so the worker can report and retry', async () => {
    vi.spyOn(models.Assignment.collection, 'find').mockImplementationOnce(() => {
      throw new Error('shortlist query unavailable');
    });
    await expect(scanner().scan()).rejects.toThrow('shortlist query unavailable');
  });
  it.each([0, 101, 1.5])('rejects invalid batch size %s', (batchSize) => {
    expect(() => scanner(batchSize)).toThrow(RangeError);
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

describe('rider responses through HTTP', () => {
  it('accepts current work, retains reservation and records responsible actor/time', async () => {
    const { job, rider, attempt } = await newWork();
    now = new Date(now.getTime() + 1000);
    const res = await accept(attempt.id);
    expect(res.status).toBe(200);
    expect(res.body.replayed).toBe(false);
    expect(res.body.data.job).toMatchObject({
      status: 'ACCEPTED',
      version: 2,
      activeAssignmentId: attempt.id,
      assignedRiderId: rider.id,
    });
    expect(res.body.data.assignment).toMatchObject({
      status: 'ACCEPTED',
      active: true,
      respondedAt: now.toISOString(),
      endedAt: null,
      reservationReleasedAt: null,
    });
    const event = await models.JobEvent.findOne({ type: 'ASSIGNMENT_ACCEPTED' }).orFail();
    expect(event).toMatchObject({
      actor,
      occurredAt: now,
      assignmentId: attempt._id,
      details: { riderId: rider.id },
    });
    expect(await models.JobEvent.countDocuments({ type: 'MANUAL_QUEUE_ENTERED' })).toBe(0);
    expect(
      (await request(app).get(`/api/v1/jobs/${job.id}/history`)).body.data.attempts[0].status,
    ).toBe('ACCEPTED');
    await workload(rider.id, 2, 1);
  });
  it('allows an already-assigned rider to accept while offline', async () => {
    const { rider, attempt } = await newWork();
    await request(app)
      .patch(`/api/v1/riders/${rider.id}`)
      .set('X-Actor-Id', 'dispatcher:demo')
      .send({ availability: 'UNAVAILABLE' });
    expect((await accept(attempt.id)).status).toBe(200);
    await workload(rider.id, 2, 1);
  });
  it('rejects with a trimmed reason, releases original load, clears pointers and retains outcome/history', async () => {
    const { job, rider, attempt } = await newWork();
    const res = await reject(attempt.id, '  Cannot take this route  ');
    expect(res.status).toBe(200);
    expect(res.body.data.job).toMatchObject({
      status: 'MANUAL_QUEUE',
      manualReason: 'RIDER_REJECTED',
      activeAssignmentId: null,
      assignedRiderId: null,
      version: 2,
    });
    expect(res.body.data.assignment).toMatchObject({
      status: 'REJECTED',
      active: false,
      endReason: 'Cannot take this route',
      respondedAt: now.toISOString(),
      endedAt: now.toISOString(),
      reservationReleasedAt: now.toISOString(),
    });
    const history = await request(app).get(`/api/v1/jobs/${job.id}/history`);
    expect(history.body.data.events.map((e: { type: string }) => e.type)).toEqual([
      'RIDERS_RECOMMENDED',
      'ASSIGNMENT_CREATED',
      'ASSIGNMENT_REJECTED',
      'MANUAL_QUEUE_ENTERED',
    ]);
    expect(history.body.data.events[2]).toMatchObject({
      actor,
      details: { reason: 'Cannot take this route', releasedUnits: 2 },
    });
    expect(history.body.data.attempts).toHaveLength(1);
    await workload(rider.id, 0, 0);
  });
  it('replays matching rejection but rejects changed reason/opposing acceptance without another release', async () => {
    const { rider, attempt } = await newWork();
    expect((await reject(attempt.id)).status).toBe(200);
    const again = await reject(attempt.id);
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect((await reject(attempt.id, 'Different reason')).status).toBe(409);
    expect((await accept(attempt.id)).status).toBe(409);
    expect(await models.JobEvent.countDocuments()).toBe(4);
    await workload(rider.id, 0, 0);
  });
  it('replays acceptance but rejects subsequent rejection and ignores later expiry', async () => {
    const { rider, attempt } = await newWork();
    await accept(attempt.id);
    now = new Date(attempt.expiresAt.getTime() + 1000);
    const replay = await accept(attempt.id);
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect((await reject(attempt.id)).status).toBe(409);
    expect((await resolution.expire(attempt.id)).expired).toBe(false);
    expect(await models.JobEvent.countDocuments()).toBe(3);
    await workload(rider.id, 2, 1);
  });
  it('releases only this attempt while preserving another active reservation', async () => {
    const first = await newWork();
    const second = await newWork(first.rider.id);
    await accept(second.attempt.id);
    await reject(first.attempt.id);
    await workload(first.rider.id, 2, 1);
    expect((await models.Assignment.findById(second.attempt.id).orFail()).status).toBe('ACCEPTED');
  });
});

describe('deadline boundaries and retained attempts', () => {
  it('does not expire one millisecond early; equality expires and releases once', async () => {
    const { job, rider, attempt } = await newWork();
    now = new Date(attempt.expiresAt.getTime() - 1);
    expect((await resolution.expire(attempt.id)).expired).toBe(false);
    now = new Date(attempt.expiresAt);
    const result = await resolution.expire(attempt.id);
    expect(result.expired).toBe(true);
    expect(result.data.job).toMatchObject({
      status: 'MANUAL_QUEUE',
      manualReason: 'RESPONSE_TIMEOUT',
      activeAssignmentId: null,
      assignedRiderId: null,
    });
    expect(result.data.assignment).toMatchObject({
      status: 'EXPIRED',
      active: false,
      respondedAt: null,
      endedAt: now.toISOString(),
      reservationReleasedAt: now.toISOString(),
    });
    expect((await resolution.expire(attempt.id)).expired).toBe(false);
    const event = await models.JobEvent.findOne({
      jobId: job.id,
      type: 'ASSIGNMENT_EXPIRED',
    }).orFail();
    expect(event.actor).toBe('system:timeout-worker');
    expect(event.details).toEqual({ reason: 'RESPONSE_TIMEOUT', releasedUnits: 2 });
    await workload(rider.id, 0, 0);
  });
  it('accepts one millisecond before expiry without releasing', async () => {
    const { rider, attempt } = await newWork();
    now = new Date(attempt.expiresAt.getTime() - 1);
    expect((await accept(attempt.id)).status).toBe(200);
    await workload(rider.id, 2, 1);
  });
  it.each(['accept', 'reject'] as const)(
    'late %s commits expiry before returning 409 and repeated calls do not release twice',
    async (action) => {
      const { rider, attempt } = await newWork();
      now = new Date(attempt.expiresAt);
      const send = () => (action === 'accept' ? accept(attempt.id) : reject(attempt.id));
      const res = await send();
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ASSIGNMENT_EXPIRED');
      expect((await send()).status).toBe(409);
      expect(await models.JobEvent.countDocuments({ type: 'ASSIGNMENT_EXPIRED' })).toBe(1);
      expect(await models.JobEvent.countDocuments({ type: 'MANUAL_QUEUE_ENTERED' })).toBe(1);
      expect((await models.JobEvent.findOne({ type: 'ASSIGNMENT_EXPIRED' }).orFail()).actor).toBe(
        actor,
      );
      await workload(rider.id, 0, 0);
    },
  );
  it.each(['reject', 'expire'] as const)(
    'can reassign after real %s while old ID cannot accept or affect the new reservation',
    async (action) => {
      const first = await newWork();
      if (action === 'reject') await reject(first.attempt.id);
      else {
        now = new Date(first.attempt.expiresAt);
        await resolution.expire(first.attempt.id);
      }
      const next = await request(app)
        .post(`/api/v1/jobs/${first.job.id}/assignments`)
        .set('X-Actor-Id', 'dispatcher:demo')
        .set('Idempotency-Key', 'new-attempt')
        .send({ riderId: first.rider.id });
      expect(next.status).toBe(201);
      expect((await accept(first.attempt.id)).status).toBe(409);
      if (action === 'reject') expect((await reject(first.attempt.id)).body.replayed).toBe(true);
      expect((await resolution.expire(first.attempt.id)).expired).toBe(false);
      expect(
        (await models.Job.findById(first.job.id).orFail()).activeAssignmentId?.toHexString(),
      ).toBe(next.body.data.assignment.id);
      expect(await models.Assignment.countDocuments({ jobId: first.job.id })).toBe(2);
      expect(await models.JobEvent.countDocuments({ type: 'REASSIGNED' })).toBe(1);
      await workload(first.rider.id, 2, 1);
      expect((await accept(next.body.data.assignment.id)).status).toBe(200);
    },
  );
});

describe('resolution rollback and validation', () => {
  it.each(['accept', 'reject', 'expire'] as const)(
    'rolls back %s and any release if audit storage fails',
    async (action) => {
      const { job, rider, attempt } = await newWork();
      if (action === 'expire') now = new Date(attempt.expiresAt);
      vi.spyOn(models.JobEvent.collection, 'insertOne').mockRejectedValueOnce(
        new Error('audit failed'),
      );
      vi.spyOn(console, 'error').mockImplementation(() => {});
      if (action === 'expire')
        await expect(resolution.expire(attempt.id)).rejects.toThrow('audit failed');
      else
        expect((await (action === 'accept' ? accept(attempt.id) : reject(attempt.id))).status).toBe(
          500,
        );
      expect((await models.Job.findById(job.id).orFail()).status).toBe('AWAITING_CONFIRMATION');
      const stored = await models.Assignment.findById(attempt.id).orFail();
      expect(stored.status).toBe('PENDING');
      expect(stored.reservationReleasedAt).toBeUndefined();
      expect(await models.JobEvent.countDocuments()).toBe(2);
      await workload(rider.id, 2, 1);
    },
  );
  it('rolls back both outcome and capacity if the manual-entry event fails after outcome audit', async () => {
    const { job, rider, attempt } = await newWork();
    const original = models.JobEvent.collection.insertOne.bind(models.JobEvent.collection);
    vi.spyOn(models.JobEvent.collection, 'insertOne')
      .mockImplementationOnce((...args) => original(...args))
      .mockRejectedValueOnce(new Error('manual audit failed'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await reject(attempt.id)).status).toBe(500);
    expect((await models.Job.findById(job.id).orFail()).status).toBe('AWAITING_CONFIRMATION');
    expect(await models.JobEvent.countDocuments()).toBe(2);
    await workload(rider.id, 2, 1);
  });
  it.each([
    { reservedUnits: 1, activeJobCount: 1 },
    { reservedUnits: 3, activeJobCount: 1 },
    { reservedUnits: 2, activeJobCount: 2 },
    { reservedUnits: 0, activeJobCount: 0 },
  ])('aborts inconsistent release %j without clamping', async (counters) => {
    const { job, rider, attempt } = await newWork();
    await models.Rider.collection.updateOne({ _id: rider._id }, { $set: counters });
    const res = await reject(attempt.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('WORKLOAD_CONFLICT');
    expect((await models.Job.findById(job.id).orFail()).status).toBe('AWAITING_CONFIRMATION');
    expect(
      (await models.Assignment.findById(attempt.id).orFail()).reservationReleasedAt,
    ).toBeUndefined();
    expect(await models.JobEvent.countDocuments()).toBe(2);
    expect(await models.Rider.findById(rider.id).orFail()).toMatchObject(counters);
  });
  it('aborts missing-rider release without losing the pending reservation record', async () => {
    const { job, rider, attempt } = await newWork();
    await models.Rider.collection.deleteOne({ _id: rider._id });
    const res = await reject(attempt.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('WORKLOAD_CONFLICT');
    expect((await models.Job.findById(job.id).orFail()).status).toBe('AWAITING_CONFIRMATION');
    expect((await models.Assignment.findById(attempt.id).orFail()).status).toBe('PENDING');
  });
  it('rejects stale/mismatched pending pointers without consuming another job outcome', async () => {
    const { job, rider, attempt } = await newWork();
    await models.Job.updateOne(
      { _id: job._id },
      { $set: { activeAssignmentId: new mongoose.Types.ObjectId() } },
    );
    expect((await accept(attempt.id)).status).toBe(409);
    expect((await reject(attempt.id)).status).toBe(409);
    now = new Date(attempt.expiresAt);
    await expect(resolution.expire(attempt.id)).rejects.toMatchObject({
      code: 'ASSIGNMENT_CONFLICT',
    });
    expect(await models.JobEvent.countDocuments()).toBe(2);
    await workload(rider.id, 2, 1);
  });
  it('rejects malformed/missing IDs, missing actors, invalid bodies and query parameters', async () => {
    const { attempt } = await newWork();
    expect((await accept('invalid')).status).toBe(400);
    const missing = await accept('507f191e810c19729de860ea');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('ASSIGNMENT_NOT_FOUND');
    expect(
      (await request(app).post(`/api/v1/assignments/${attempt.id}/accept`).send({})).status,
    ).toBe(400);
    for (const body of [
      {},
      { reason: '' },
      { reason: ' ' },
      { reason: 'x'.repeat(501) },
      { reason: 'No', status: 'EXPIRED' },
    ]) {
      expect(
        (
          await request(app)
            .post(`/api/v1/assignments/${attempt.id}/reject`)
            .set('X-Actor-Id', actor)
            .send(body)
        ).status,
      ).toBe(400);
    }
    expect(
      (
        await request(app)
          .post(`/api/v1/assignments/${attempt.id}/accept?unknown=1`)
          .set('X-Actor-Id', actor)
          .send({})
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post(`/api/v1/assignments/${attempt.id}/accept`)
          .set('X-Actor-Id', actor)
          .send({ status: 'ACCEPTED' })
      ).status,
    ).toBe(400);
    expect(await models.JobEvent.countDocuments()).toBe(2);
  });
  it('returns 503 before invoking response services when unready', async () => {
    const spy = vi.spyOn(resolution, 'accept');
    const unready = createApp({ isReady: () => false, resolution });
    expect(
      (
        await request(unready)
          .post('/api/v1/assignments/507f191e810c19729de860ea/accept')
          .set('X-Actor-Id', actor)
          .send({})
      ).status,
    ).toBe(503);
    expect(spy).not.toHaveBeenCalled();
  });
  it.each(['accept', 'reject'] as const)(
    'a lost committed %s reply returns 503; same decision retry reads stored outcome without another event',
    async (action) => {
      const { rider, attempt } = await newWork();
      const original = connection.transaction.bind(connection);
      vi.spyOn(connection, 'transaction').mockImplementationOnce(async (work, options) => {
        await original(work, options);
        throw new mongoose.mongo.MongoServerError({
          message: 'lost resolution reply',
          errorLabels: ['UnknownTransactionCommitResult'],
        });
      });
      const send = () => (action === 'accept' ? accept(attempt.id) : reject(attempt.id));
      expect((await send()).status).toBe(503);
      const retry = await send();
      expect(retry.status).toBe(200);
      expect(retry.body.replayed).toBe(true);
      expect(await models.JobEvent.countDocuments()).toBe(action === 'accept' ? 3 : 4);
      await workload(rider.id, action === 'accept' ? 2 : 0, action === 'accept' ? 1 : 0);
    },
  );
});
