import mongoose, { Types, type Connection } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MongoMemoryReplSet } from 'mongodb-memory-server-core';
import { createApp } from '../../src/app.js';
import { createDashboardService } from '../../src/modules/dashboard/service.js';
import { JOB_STATUSES } from '../../src/modules/domain/constants.js';
import {
  createPersistenceModels,
  type PersistenceModels,
} from '../../src/modules/persistence/models.js';
import { initializePersistence } from '../../src/modules/persistence/initialize.js';
import { startTestReplicaSet } from '../helpers/mongo.js';
import { assignmentFixture, jobFixture } from '../helpers/fixtures.js';
let replica: MongoMemoryReplSet,
  connection: Connection,
  models: PersistenceModels,
  app: ReturnType<typeof createApp>;
const now = new Date('2030-01-01T12:00:00Z');
beforeAll(async () => {
  replica = await startTestReplicaSet();
  connection = await mongoose
    .createConnection(replica.getUri('relay_dashboard'), { autoIndex: false, autoCreate: false })
    .asPromise();
  models = createPersistenceModels(connection);
  await initializePersistence(connection);
  app = createApp({
    isReady: () => true,
    dashboard: createDashboardService({ connection, models, clock: { now: () => now } }),
  });
});
beforeEach(async () => {
  for (const model of Object.values(models)) await model.collection.deleteMany({});
});
afterAll(async () => {
  await connection?.close();
  await replica?.stop();
});
describe('dashboard snapshot', () => {
  it('returns true zero counts and empty attention on an empty database', async () => {
    const response = await request(app).get('/api/v1/dashboard');
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      total: 0,
      awaitingAssignment: 0,
      inProgress: 0,
      attention: [],
      attentionTotal: 0,
      asOf: now.toISOString(),
    });
    expect(Object.values(response.body.data.byStatus)).toEqual(JOB_STATUSES.map(() => 0));
  });
  it('counts every lifecycle state and identifies due confirmations, manual and overdue active jobs without writing', async () => {
    for (const status of JOB_STATUSES) {
      const active = ['AWAITING_CONFIRMATION', 'ACCEPTED', 'PICKED_UP'].includes(status);
      const attemptId = new Types.ObjectId(),
        riderId = new Types.ObjectId();
      const job = await models.Job.create(
        jobFixture({
          status,
          ...(active ? { activeAssignmentId: attemptId, assignedRiderId: riderId } : {}),
          ...(status === 'MANUAL_QUEUE' ? { manualReason: 'RIDER_REJECTED' } : {}),
          ...(status === 'DELIVERED' || status === 'NEW' ? { deadlineAt: now } : {}),
        }),
      );
      if (status === 'AWAITING_CONFIRMATION')
        await models.Assignment.create(
          assignmentFixture(job._id, { _id: attemptId, riderId, expiresAt: now }),
        );
    }
    const result = await request(app).get('/api/v1/dashboard');
    expect(result.status).toBe(200);
    expect(result.body.data).toMatchObject({
      total: 8,
      awaitingAssignment: 2,
      inProgress: 2,
      attentionTotal: 3,
    });
    expect(Object.values(result.body.data.byStatus)).toEqual(JOB_STATUSES.map(() => 1));
    expect(
      result.body.data.attention.map((j: { attentionReason: string }) => j.attentionReason).sort(),
    ).toEqual(['CONFIRMATION_OVERDUE', 'DEADLINE_OVERDUE', 'RIDER_REJECTED']);
    expect(await models.JobEvent.countDocuments()).toBe(0);
    expect((await models.Job.findOne({ status: 'AWAITING_CONFIRMATION' }))?.status).toBe(
      'AWAITING_CONFIRMATION',
    );
  });
  it('filters counts and attention by pickup OR destination and bounds attention to 20', async () => {
    for (let i = 0; i < 23; i++)
      await models.Job.create(
        jobFixture({
          status: 'MANUAL_QUEUE',
          manualReason: 'NO_ELIGIBLE_RIDER',
          pickupZone: 'EAST',
          deliveryZone: 'WEST',
        }),
      );
    await models.Job.create(jobFixture({ pickupZone: 'NORTH', deliveryZone: 'SOUTH' }));
    const east = await request(app).get('/api/v1/dashboard?zone=east');
    expect(east.status).toBe(200);
    expect(east.body.data.total).toBe(23);
    expect(east.body.data.attentionTotal).toBe(23);
    expect(east.body.data.attention).toHaveLength(20);
    expect((await request(app).get('/api/v1/dashboard?zone=WEST')).body.data.total).toBe(23);
    expect((await request(app).get('/api/v1/dashboard?zone=NORTH')).body.data.total).toBe(1);
  });
  it.each(['?zone=NOWHERE', '?status=NEW', '?zone=NORTH&zone=SOUTH', '?zone[$ne]=x'])(
    'rejects invalid query %s',
    async (query) => {
      expect((await request(app).get(`/api/v1/dashboard${query}`)).status).toBe(400);
    },
  );
  it('honors readiness', async () => {
    const unavailable = createApp({ dashboard: createDashboardService({ connection, models }) });
    expect((await request(unavailable).get('/api/v1/dashboard')).status).toBe(503);
  });
});
