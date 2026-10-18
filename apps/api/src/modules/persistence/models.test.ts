import mongoose, { Types } from 'mongoose';
import { afterAll, describe, expect, it } from 'vitest';
import {
  assignmentFixture,
  eventFixture,
  jobFixture,
  riderFixture,
} from '../../../test/helpers/fixtures.js';
import { createPersistenceModels } from './models.js';

const connection = mongoose.createConnection();
const { Job, Rider, Assignment, JobEvent } = createPersistenceModels(connection);
afterAll(async () => {
  await connection.close();
});

describe('Mongoose document validation (without a database)', () => {
  it('normalizes identity and defaults a new job without assignment pointers', async () => {
    const job = new Job(jobFixture({ orderReference: '  relay-10 ' }));
    await expect(job.validate()).resolves.toBeUndefined();
    expect(job.orderReference).toBe('RELAY-10');
    expect(job.status).toBe('NEW');
    expect(job.priority).toBe('NORMAL');
    expect(job.version).toBe(0);
    expect(job.activeAssignmentId).toBeUndefined();
    expect(job.creationKey).toBeUndefined();
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid job load %s',
    async (loadUnits) => {
      await expect(new Job(jobFixture({ loadUnits })).validate()).rejects.toThrow();
    },
  );
  it('rejects unknown fields instead of silently losing client data', () => {
    expect(() => new Job({ ...jobFixture(), inventedField: true })).toThrow('strict mode');
  });
  it.each([
    { pickupZone: 'UNKNOWN' },
    { priority: 'EXTREME' },
    { status: 'IN_TRANSIT' },
    { requestHash: 'not-a-hash' },
  ])('rejects invalid job catalog values %j', async (change) => {
    await expect(new Job(jobFixture(change)).validate()).rejects.toThrow();
  });
  it('requires current pointers in active states and clears them in manual work', async () => {
    await expect(
      new Job(jobFixture({ status: 'AWAITING_CONFIRMATION' })).validate(),
    ).rejects.toThrow('pointers');
    await expect(
      new Job(
        jobFixture({
          status: 'MANUAL_QUEUE',
          manualReason: 'RESPONSE_TIMEOUT',
          assignedRiderId: new Types.ObjectId(),
        }),
      ).validate(),
    ).rejects.toThrow('pointers');
    await expect(
      new Job(jobFixture({ status: 'MANUAL_QUEUE', manualReason: 'RESPONSE_TIMEOUT' })).validate(),
    ).resolves.toBeUndefined();
  });
  it('requires a reason exactly when a job is in manual queue', async () => {
    await expect(new Job(jobFixture({ status: 'MANUAL_QUEUE' })).validate()).rejects.toThrow(
      'manual reason',
    );
    await expect(
      new Job(jobFixture({ manualReason: 'NO_ELIGIBLE_RIDER' })).validate(),
    ).rejects.toThrow('manual reason');
  });
  it('defaults a rider workload to zero', async () => {
    const rider = new Rider(riderFixture());
    await rider.validate();
    expect(rider.reservedUnits).toBe(0);
    expect(rider.activeJobCount).toBe(0);
  });
  it.each([
    { serviceZones: [] },
    { serviceZones: ['CENTRAL', 'CENTRAL'] },
    { serviceZones: ['UNKNOWN'] },
    { reservedUnits: 6, activeJobCount: 1 },
    { reservedUnits: 2, activeJobCount: 0 },
  ])('rejects invalid rider configuration %j', async (change) => {
    await expect(new Rider(riderFixture(change)).validate()).rejects.toThrow();
  });
  it('requires a structured snapshot on a new assignment', async () => {
    const attempt = new Assignment(assignmentFixture());
    await expect(attempt.validate()).resolves.toBeUndefined();
    expect(attempt.active).toBe(true);
    await expect(
      new Assignment(
        assignmentFixture(undefined, { recommendationSnapshot: { score: 100 } }),
      ).validate(),
    ).rejects.toThrow('snapshot');
  });
  it.each([
    { active: false },
    { expiresAt: new Date('2029-01-01') },
    { reservationReleasedAt: new Date('2030-01-01T10:00:00Z') },
    { status: 'EXPIRED', active: false, endReason: 'RESPONSE_TIMEOUT' },
    { status: 'ACCEPTED' },
    { respondedAt: new Date('2029-01-01') },
  ])('rejects an inconsistent attempt %j', async (change) => {
    await expect(new Assignment(assignmentFixture(undefined, change)).validate()).rejects.toThrow();
  });
  it('retains release evidence on a failed historical attempt', async () => {
    const attempt = new Assignment(
      assignmentFixture(undefined, {
        status: 'EXPIRED',
        active: false,
        endReason: 'RESPONSE_TIMEOUT',
        endedAt: new Date('2030-01-01T11:00:00Z'),
        reservationReleasedAt: new Date('2030-01-01T11:00:00Z'),
      }),
    );
    await expect(attempt.validate()).resolves.toBeUndefined();
  });
  it('validates audit details against their event type and records the actor', async () => {
    await expect(new JobEvent(eventFixture()).validate()).resolves.toBeUndefined();
    await expect(
      new JobEvent(eventFixture(undefined, { type: 'ASSIGNMENT_EXPIRED' })).validate(),
    ).rejects.toThrow('event type');
    await expect(
      new JobEvent(eventFixture(undefined, { actor: ' ' })).validate(),
    ).rejects.toThrow();
  });
});
