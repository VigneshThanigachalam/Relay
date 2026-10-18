import { describe, expect, it } from 'vitest';
import {
  actorSchema,
  createJobSchema,
  hashJobRequest,
  jobIdSchema,
  listJobsSchema,
  paginationSchema,
} from './contracts.js';

const valid = {
  orderReference: 'relay-1',
  pickupZone: 'CENTRAL',
  deliveryZone: 'NORTH',
  loadUnits: 2,
};

describe('job request contracts', () => {
  it('normalizes references/zones and applies the default priority', () => {
    expect(
      createJobSchema.parse({ ...valid, orderReference: ' relay-1 ', pickupZone: ' central ' }),
    ).toMatchObject({ orderReference: 'RELAY-1', pickupZone: 'CENTRAL', priority: 'NORMAL' });
  });
  it('permits same-zone pickup and delivery', () => {
    expect(createJobSchema.safeParse({ ...valid, deliveryZone: 'CENTRAL' }).success).toBe(true);
  });
  it.each([0, -1, 1.5, '2', null, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid load %s without coercion',
    (value) => {
      expect(createJobSchema.safeParse({ ...valid, loadUnits: value }).success).toBe(false);
    },
  );
  it.each([
    { orderReference: ' ' },
    { pickupZone: 'UNKNOWN' },
    { priority: 'EXTREME' },
    { status: 'DELIVERED' },
    { assignedRiderId: '507f191e810c19729de860ea' },
    { deadlineAt: 'tomorrow' },
    { deadlineAt: null },
  ])('rejects invalid input %j', (change) => {
    expect(createJobSchema.safeParse({ ...valid, ...change }).success).toBe(false);
  });
  it('hashes equivalent payloads identically despite field order, defaults and timezone offsets', () => {
    const a = createJobSchema.parse({ ...valid, deadlineAt: '2030-01-01T10:00:00Z' });
    const b = createJobSchema.parse({
      priority: 'NORMAL',
      loadUnits: 2,
      deliveryZone: ' north ',
      pickupZone: 'central',
      orderReference: ' RELAY-1 ',
      deadlineAt: '2030-01-01T15:30:00+05:30',
    });
    expect(hashJobRequest(a)).toBe(hashJobRequest(b));
  });
  it('changes the hash when an operational input changes', () => {
    expect(hashJobRequest(createJobSchema.parse(valid))).not.toBe(
      hashJobRequest(createJobSchema.parse({ ...valid, loadUnits: 3 })),
    );
  });
});

describe('query and actor contracts', () => {
  it('defaults bounded pagination and normalizes filters', () => {
    expect(listJobsSchema.parse({ zone: 'north', orderReference: ' relay-1 ' })).toEqual({
      page: 1,
      pageSize: 20,
      zone: 'NORTH',
      orderReference: 'RELAY-1',
    });
    expect(paginationSchema.parse({ page: '2', pageSize: '100' })).toEqual({
      page: 2,
      pageSize: 100,
    });
  });
  it.each([
    { page: '0' },
    { page: '1.5' },
    { page: '1e2' },
    { page: '10001' },
    { pageSize: '101' },
    { status: ['NEW', 'CANCELLED'] },
    { 'status[$ne]': 'NEW' },
    { zone: { $ne: 'NORTH' } },
    { extra: 'ignored?' },
  ])('rejects invalid/unexpected query %j', (value) => {
    expect(listJobsSchema.safeParse(value).success).toBe(false);
  });
  it('requires a meaningful actor and a strict ObjectId', () => {
    expect(actorSchema.safeParse(undefined).success).toBe(false);
    expect(actorSchema.safeParse(' ').success).toBe(false);
    expect(jobIdSchema.safeParse('not-an-id').success).toBe(false);
    expect(jobIdSchema.safeParse('507f191e810c19729de860ea').success).toBe(true);
  });
});
