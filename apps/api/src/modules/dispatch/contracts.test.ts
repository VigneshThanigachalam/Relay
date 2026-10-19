import { describe, expect, it } from 'vitest';
import { assignmentHeadersSchema, assignJobSchema, hashAssignmentRequest } from './contracts.js';

const riderId = '507f191e810c19729de860ea';
describe('assignment command contracts', () => {
  it('normalizes ObjectId spelling and operational reason before hashing', () => {
    const input = assignJobSchema.parse({
      riderId: riderId.toUpperCase(),
      overrideReason: '  Route familiarity  ',
    });
    expect(input).toEqual({ riderId, overrideReason: 'Route familiarity' });
    expect(hashAssignmentRequest(input)).toBe(
      hashAssignmentRequest(
        assignJobSchema.parse({ overrideReason: 'Route familiarity', riderId }),
      ),
    );
  });
  it('hashes missing reason consistently and binds both accepted fields', () => {
    const hash = hashAssignmentRequest(assignJobSchema.parse({ riderId }));
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toBe(hashAssignmentRequest({ riderId, overrideReason: 'Reason' }));
    expect(hash).not.toBe(hashAssignmentRequest({ riderId: '507f191e810c19729de860eb' }));
  });
  it.each([
    {},
    { riderId: 'bad' },
    { riderId: 1 },
    { riderId, overrideReason: '' },
    { riderId, overrideReason: ' ' },
    { riderId, overrideReason: 'x'.repeat(501) },
    { riderId, overrideReason: null },
    { riderId, loadUnits: 0 },
    { riderId, status: 'ACCEPTED' },
    { riderId, recommendationSnapshot: {} },
  ])('rejects invalid/server-owned payload %j', (input) => {
    expect(assignJobSchema.safeParse(input).success).toBe(false);
  });
  it('requires actor and durable key and trims both', () => {
    expect(
      assignmentHeadersSchema.parse({
        'x-actor-id': ' dispatcher:demo ',
        'idempotency-key': ' command-1 ',
      }),
    ).toEqual({ 'x-actor-id': 'dispatcher:demo', 'idempotency-key': 'command-1' });
    for (const input of [
      { 'x-actor-id': 'demo' },
      { 'idempotency-key': 'key' },
      { 'x-actor-id': 'demo', 'idempotency-key': ' ' },
      { 'x-actor-id': 'demo', 'idempotency-key': 'x'.repeat(129) },
    ])
      expect(assignmentHeadersSchema.safeParse(input).success).toBe(false);
  });
});
