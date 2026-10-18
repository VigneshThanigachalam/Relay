import { Types } from 'mongoose';

export function jobFixture(overrides: Record<string, unknown> = {}) {
  return {
    orderReference: `RELAY-${new Types.ObjectId()}`,
    requestHash: 'a'.repeat(64),
    pickupZone: 'CENTRAL',
    deliveryZone: 'NORTH',
    loadUnits: 2,
    ...overrides,
  };
}
export function riderFixture(overrides: Record<string, unknown> = {}) {
  return {
    code: `R-${new Types.ObjectId()}`,
    name: 'Arun',
    serviceZones: ['CENTRAL', 'NORTH'],
    currentZone: 'CENTRAL',
    capacityUnits: 5,
    ...overrides,
  };
}
export function assignmentFixture(
  jobId = new Types.ObjectId(),
  overrides: Record<string, unknown> = {},
) {
  const riderId = new Types.ObjectId();
  return {
    jobId,
    riderId,
    loadUnits: 2,
    assignedAt: new Date('2030-01-01T09:00:00Z'),
    expiresAt: new Date('2030-01-01T11:00:00Z'),
    requestKey: `command-${new Types.ObjectId()}`,
    requestHash: 'b'.repeat(64),
    actor: 'dispatcher:test',
    recommendationSnapshot: {
      scoringVersion: 'v1',
      generatedAt: '2030-01-01T09:00:00.000Z',
      eligible: [
        {
          riderId: riderId.toHexString(),
          rank: 1,
          totalCost: 40,
          estimatedMinutes: 20,
          availableUnits: 5,
          activeJobCount: 0,
          breakdown: { travelCost: 40, workloadCost: 0, deadlineCost: 0 },
          reasons: ['Supports both zones'],
          estimatedByFallback: false,
        },
      ],
      excluded: [],
    },
    ...overrides,
  };
}
export function eventFixture(
  jobId = new Types.ObjectId(),
  overrides: Record<string, unknown> = {},
) {
  return {
    jobId,
    sequence: 1,
    type: 'JOB_CREATED',
    occurredAt: new Date('2030-01-01T09:00:00Z'),
    actor: 'dispatcher:test',
    details: {
      orderReference: 'RELAY-TEST',
      pickupZone: 'CENTRAL',
      deliveryZone: 'NORTH',
      loadUnits: 2,
      priority: 'NORMAL',
    },
    ...overrides,
  };
}
