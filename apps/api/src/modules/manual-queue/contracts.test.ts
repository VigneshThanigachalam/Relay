import { describe, expect, it } from 'vitest';
import { listManualQueueSchema } from './contracts.js';

describe('manual queue filters', () => {
  it('uses shared pagination defaults and normalizes the optional service zone', () => {
    expect(listManualQueueSchema.parse({})).toEqual({ page: 1, pageSize: 20 });
    expect(listManualQueueSchema.parse({ zone: ' north ', page: '2', pageSize: '100' })).toEqual({
      zone: 'NORTH',
      page: 2,
      pageSize: 100,
    });
  });
  it.each([
    { page: '0' },
    { page: '10001' },
    { pageSize: '101' },
    { pageSize: '1.5' },
    { zone: 'UNKNOWN' },
    { zone: ['NORTH', 'SOUTH'] },
    { 'zone[$ne]': 'NORTH' },
    { status: 'ACCEPTED' },
    { orderReference: 'ORDER-1' },
  ])('rejects invalid/unknown filters %j', (input) => {
    expect(listManualQueueSchema.safeParse(input).success).toBe(false);
  });
});
