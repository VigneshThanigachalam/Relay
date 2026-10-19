import mongoose, { type Connection } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MongoMemoryReplSet } from 'mongodb-memory-server-core';
import { createApp } from '../../src/app.js';
import { createRidersService } from '../../src/modules/riders/service.js';
import {
  createPersistenceModels,
  type PersistenceModels,
} from '../../src/modules/persistence/models.js';
import { initializePersistence } from '../../src/modules/persistence/initialize.js';
import { runInTransaction } from '../../src/modules/persistence/transaction.js';
import { startTestReplicaSet } from '../helpers/mongo.js';
import { assignmentFixture, jobFixture } from '../helpers/fixtures.js';

let replica: MongoMemoryReplSet;
let connection: Connection;
let models: PersistenceModels;
let app: ReturnType<typeof createApp>;
let now: Date;
const payload = (change: Record<string, unknown> = {}) => ({
  code: 'R-001',
  name: 'Arun',
  serviceZones: ['CENTRAL', 'NORTH'],
  currentZone: 'CENTRAL',
  capacityUnits: 5,
  ...change,
});
const create = (body: Record<string, unknown> = payload()) =>
  request(app).post('/api/v1/riders').set('X-Actor-Id', 'dispatcher:arun').send(body);

beforeAll(async () => {
  replica = await startTestReplicaSet();
  connection = await mongoose
    .createConnection(replica.getUri('relay_riders_http_test'), {
      autoCreate: false,
      autoIndex: false,
    })
    .asPromise();
  models = createPersistenceModels(connection);
  await initializePersistence(connection);
  app = createApp({
    isReady: () => connection.readyState === 1,
    riders: createRidersService({ connection, models, clock: { now: () => new Date(now) } }),
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

// Explicit test fixture setup, not an implementation of the future dispatch API.
// Each active attempt gets a matching job pointer and contributes one load unit.
async function seedActiveWork(riderId: string) {
  await runInTransaction(connection, async (session) => {
    for (const status of ['PENDING', 'ACCEPTED', 'PICKED_UP'] as const) {
      const jobId = new mongoose.Types.ObjectId();
      const assignmentId = new mongoose.Types.ObjectId();
      await models.Job.create(
        [
          jobFixture({
            _id: jobId,
            status: status === 'PENDING' ? 'AWAITING_CONFIRMATION' : status,
            assignedRiderId: riderId,
            activeAssignmentId: assignmentId,
            loadUnits: 1,
          }),
        ],
        { session },
      );
      const fixture = assignmentFixture(jobId, {
        _id: assignmentId,
        riderId: new mongoose.Types.ObjectId(riderId),
        status,
        loadUnits: 1,
        ...(status !== 'PENDING' ? { respondedAt: new Date('2030-01-01T09:01:00Z') } : {}),
      });
      fixture.recommendationSnapshot.eligible[0]!.riderId = riderId;
      await models.Assignment.create([fixture], { session });
    }
    await models.Rider.updateOne(
      { _id: riderId },
      { $set: { reservedUnits: 3, activeJobCount: 3 } },
      { session },
    );
  });
}

describe('real rider creation and reads', () => {
  it('creates normalized rider identity with zero workload and actor provenance', async () => {
    const res = await create(
      payload({ code: ' r-001 ', name: ' Arun ', serviceZones: ['north', ' central '] }),
    );
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      code: 'R-001',
      name: 'Arun',
      serviceZones: ['CENTRAL', 'NORTH'],
      availability: 'AVAILABLE',
      capacityUnits: 5,
      reservedUnits: 0,
      availableUnits: 5,
      activeJobCount: 0,
      createdBy: 'dispatcher:arun',
      updatedBy: 'dispatcher:arun',
      createdAt: now.toISOString(),
    });
    expect(res.body.data).not.toHaveProperty('_id');
    expect(res.body.data).not.toHaveProperty('__v');
    expect(await models.Rider.countDocuments()).toBe(1);
    // Rider configuration does not fabricate an unrelated job history event.
    expect(await models.JobEvent.countDocuments()).toBe(0);
  });
  it('rejects duplicate normalized codes without overwriting the original', async () => {
    const first = await create();
    const duplicate = await create(
      payload({ code: ' r-001 ', name: 'Another rider', capacityUnits: 99 }),
    );
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('DUPLICATE_RIDER');
    const stored = await models.Rider.findById(first.body.data.id).orFail();
    expect(stored.name).toBe('Arun');
    expect(stored.capacityUnits).toBe(5);
    expect(await models.Rider.countDocuments()).toBe(1);
  });
  it('allows exactly one of eight concurrent duplicate creates', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => create()));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(
      results.filter((r) => r.status === 409 && r.body.error.code === 'DUPLICATE_RIDER'),
    ).toHaveLength(7);
    expect(await models.Rider.countDocuments()).toBe(1);
  });
  it('requires actor attribution for rider creation', async () => {
    const res = await request(app).post('/api/v1/riders').send(payload());
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'x-actor-id' })]),
    );
    expect(await models.Rider.countDocuments()).toBe(0);
  });
  it.each([
    { code: ' ' },
    { capacityUnits: '5' },
    { capacityUnits: 0 },
    { capacityUnits: 1.5 },
    { serviceZones: [] },
    { serviceZones: ['NORTH', 'north'] },
    { currentZone: 'UNKNOWN' },
    { reservedUnits: 2 },
    { activeJobCount: 1 },
    { createdBy: 'forged' },
  ])('rejects invalid create payload %j', async (change) => {
    const res = await create(payload(change));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
    expect(await models.Rider.countDocuments()).toBe(0);
  });
  it('returns an empty list with default bounds', async () => {
    const res = await request(app).get('/api/v1/riders');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [], pagination: { page: 1, pageSize: 20, total: 0 } });
  });
  it('filters by service coverage and availability, not by current location', async () => {
    await create(payload({ code: 'R-003', currentZone: 'WEST' }));
    await create(payload({ code: 'R-001', availability: 'UNAVAILABLE' }));
    await create(payload({ code: 'R-002', serviceZones: ['SOUTH'], currentZone: 'NORTH' }));
    const covered = await request(app).get('/api/v1/riders?zone=north');
    expect(covered.body.data.map((r: { code: string }) => r.code)).toEqual(['R-001', 'R-003']);
    expect(covered.body.pagination.total).toBe(2);
    const available = await request(app).get('/api/v1/riders?zone=NORTH&availability=AVAILABLE');
    expect(available.body.data.map((r: { code: string }) => r.code)).toEqual(['R-003']);
    expect((await request(app).get('/api/v1/riders?zone=WEST')).body.data).toEqual([]);
  });
  it('paginates in code order and searches exact normalized code', async () => {
    for (const code of ['R-003', 'R-001', 'R-002']) await create(payload({ code }));
    const first = await request(app).get('/api/v1/riders?page=1&pageSize=2');
    const second = await request(app).get('/api/v1/riders?page=2&pageSize=2');
    expect(first.body.data.map((r: { code: string }) => r.code)).toEqual(['R-001', 'R-002']);
    expect(second.body.data.map((r: { code: string }) => r.code)).toEqual(['R-003']);
    expect(second.body.pagination).toEqual({ page: 2, pageSize: 2, total: 3 });
    expect(
      (await request(app).get('/api/v1/riders').query({ code: ' r-002 ' })).body.data,
    ).toHaveLength(1);
    expect((await request(app).get('/api/v1/riders').query({ code: 'R-.*' })).body.data).toEqual(
      [],
    );
    expect((await request(app).get('/api/v1/riders?page=3&pageSize=2')).body.data).toEqual([]);
  });
  it('returns detail and bounded active pending/accepted/picked-up attempts', async () => {
    const id = (await create()).body.data.id;
    await seedActiveWork(id);
    // An expired fixture remains stored but is not part of the active workload.
    await models.Assignment.create(
      assignmentFixture(undefined, {
        riderId: new mongoose.Types.ObjectId(id),
        status: 'EXPIRED',
        active: false,
        endedAt: new Date('2030-01-01T11:00:00Z'),
        reservationReleasedAt: new Date('2030-01-01T11:00:00Z'),
        endReason: 'RESPONSE_TIMEOUT',
      }),
    );
    const first = await request(app).get(`/api/v1/riders/${id}?pageSize=2`);
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({
      reservedUnits: 3,
      availableUnits: 2,
      activeJobCount: 3,
    });
    expect(first.body.data.activeAssignments.map((a: { status: string }) => a.status)).toEqual([
      'PENDING',
      'ACCEPTED',
    ]);
    expect(first.body.pagination).toEqual({ page: 1, pageSize: 2, total: 3 });
    const second = await request(app).get(`/api/v1/riders/${id}?page=2&pageSize=2`);
    expect(second.body.data.activeAssignments.map((a: { status: string }) => a.status)).toEqual([
      'PICKED_UP',
    ]);
    expect(JSON.stringify(first.body)).not.toMatch(/requestHash|requestKey|creationKey|__v/);
  });
  it('returns empty active work for a new rider', async () => {
    const id = (await create()).body.data.id;
    const res = await request(app).get(`/api/v1/riders/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.activeAssignments).toEqual([]);
    expect(res.body.pagination.total).toBe(0);
  });
  it.each([
    'page=0',
    'pageSize=101',
    'availability=BUSY',
    'availability=AVAILABLE&availability=UNAVAILABLE',
    'zone[$ne]=NORTH',
    'unknown=1',
  ])('rejects invalid list query %s', async (query) => {
    expect((await request(app).get(`/api/v1/riders?${query}`)).status).toBe(400);
  });
  it('distinguishes malformed IDs, absent riders and invalid detail pagination', async () => {
    expect((await request(app).get('/api/v1/riders/not-an-id')).status).toBe(400);
    const absent = await request(app).get('/api/v1/riders/507f191e810c19729de860ea');
    expect(absent.status).toBe(404);
    expect(absent.body.error.code).toBe('RIDER_NOT_FOUND');
    const id = (await create()).body.data.id;
    expect((await request(app).get(`/api/v1/riders/${id}?pageSize=101`)).status).toBe(400);
  });
  it('returns 503 without invoking riders when persistence is unavailable', async () => {
    const riders = createRidersService({ connection, models });
    const spy = vi.spyOn(riders, 'list');
    const unavailable = createApp({ isReady: () => false, riders });
    const res = await request(unavailable).get('/api/v1/riders');
    expect(res.status).toBe(503);
    expect(spy).not.toHaveBeenCalled();
  });
});
