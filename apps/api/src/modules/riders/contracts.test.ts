import { describe, expect, it } from 'vitest';
import { createRiderSchema, listRidersSchema, updateRiderSchema } from './contracts.js';

const valid = {
  code: 'r-001',
  name: 'Arun',
  serviceZones: ['CENTRAL', 'NORTH'],
  currentZone: 'CENTRAL',
  capacityUnits: 5,
};
describe('rider transport contracts', () => {
  it('normalizes identity/zones and defaults availability', () => {
    expect(
      createRiderSchema.parse({
        ...valid,
        code: ' r-001 ',
        name: ' Arun ',
        serviceZones: [' north ', 'central'],
      }),
    ).toMatchObject({
      code: 'R-001',
      name: 'Arun',
      serviceZones: ['CENTRAL', 'NORTH'],
      availability: 'AVAILABLE',
    });
  });
  it('permits a known current location outside supported service zones', () => {
    expect(createRiderSchema.safeParse({ ...valid, currentZone: 'WEST' }).success).toBe(true);
  });
  it.each([0, -1, 1.5, '5', null, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid capacity %s',
    (capacityUnits) => {
      expect(createRiderSchema.safeParse({ ...valid, capacityUnits }).success).toBe(false);
    },
  );
  it.each([
    { code: ' ' },
    { name: ' ' },
    { serviceZones: [] },
    { serviceZones: ['NORTH', ' north '] },
    { serviceZones: ['UNKNOWN'] },
    { currentZone: 'UNKNOWN' },
    { availability: 'BUSY' },
    { reservedUnits: 1 },
    { activeJobCount: 1 },
    { createdBy: 'forged' },
  ])('rejects invalid/owned create fields %j', (change) => {
    expect(createRiderSchema.safeParse({ ...valid, ...change }).success).toBe(false);
  });
  it.each([
    { availability: 'UNAVAILABLE' },
    { capacityUnits: 3 },
    { name: 'Meena' },
    { serviceZones: ['NORTH'] },
    { currentZone: 'WEST' },
  ])('accepts a partial configuration update %j', (change) => {
    expect(updateRiderSchema.safeParse(change).success).toBe(true);
  });
  it.each([
    {},
    { code: 'RENAME' },
    { reservedUnits: 0 },
    { activeJobCount: 0 },
    { availableUnits: 99 },
    { updatedBy: 'forged' },
    { capacityUnits: '5' },
    { serviceZones: null },
  ])('rejects empty or server-owned updates %j', (change) => {
    expect(updateRiderSchema.safeParse(change).success).toBe(false);
  });
  it('normalizes exact list filters and reuses shared pagination bounds', () => {
    expect(
      listRidersSchema.parse({ code: ' r-1 ', zone: 'north', availability: 'UNAVAILABLE' }),
    ).toEqual({ code: 'R-1', zone: 'NORTH', availability: 'UNAVAILABLE', page: 1, pageSize: 20 });
  });
  it.each([
    { page: '0' },
    { pageSize: '101' },
    { zone: { $ne: 'NORTH' } },
    { availability: ['AVAILABLE', 'UNAVAILABLE'] },
    { 'code[$ne]': 'R-1' },
    { unknown: 'ignored' },
  ])('rejects invalid/operator-shaped query %j', (query) => {
    expect(listRidersSchema.safeParse(query).success).toBe(false);
  });
});
