import { describe, expect, it } from 'vitest';
import { EVENT_TYPES, type EventType } from './constants.js';
import { auditDetails, recommendationSnapshotSchema } from './audit-details.js';
import { assignmentFixture } from '../../../test/helpers/fixtures.js';

const id = '507f191e810c19729de860ea';
const details: Record<EventType, unknown> = {
  JOB_CREATED: {
    orderReference: 'RELAY-1',
    pickupZone: 'CENTRAL',
    deliveryZone: 'NORTH',
    loadUnits: 2,
    priority: 'HIGH',
  },
  JOB_READY: { from: 'NEW', to: 'READY_FOR_ASSIGNMENT' },
  RIDERS_RECOMMENDED: { snapshot: assignmentFixture().recommendationSnapshot },
  ASSIGNMENT_CREATED: { riderId: id, expiresAt: '2030-01-01T11:00:00.000Z' },
  ASSIGNMENT_ACCEPTED: { riderId: id },
  ASSIGNMENT_REJECTED: { reason: 'Rider cannot take this job', releasedUnits: 2 },
  ASSIGNMENT_EXPIRED: { reason: 'RESPONSE_TIMEOUT', releasedUnits: 2 },
  MANUAL_QUEUE_ENTERED: { reason: 'RESPONSE_TIMEOUT' },
  REASSIGNED: { previousAssignmentId: id, newAssignmentId: id, riderId: id },
  MANUAL_OVERRIDE: {
    reason: 'Pickup access known to rider',
    recommendedRiderId: id,
    chosenRiderId: id,
    scoringVersion: 'v1',
  },
  JOB_PICKED_UP: { from: 'ACCEPTED', to: 'PICKED_UP' },
  JOB_DELIVERED: { from: 'PICKED_UP', to: 'DELIVERED', releasedUnits: 2 },
  JOB_CANCELLED: { from: 'NEW', reason: 'Order cancelled by customer', releasedUnits: 0 },
  ASSIGNMENT_FAILED: { code: 'RIDER_INELIGIBLE', reason: 'Insufficient capacity', riderId: id },
};

describe('typed audit payload contracts', () => {
  it.each(EVENT_TYPES)('records the required explanation for %s', (type) => {
    expect(auditDetails[type].safeParse(details[type]).success).toBe(true);
    expect(auditDetails[type].safeParse({}).success).toBe(false);
  });
  it('rejects unknown fields instead of silently retaining unvalidated history', () => {
    expect(
      auditDetails.JOB_READY.safeParse({
        from: 'NEW',
        to: 'READY_FOR_ASSIGNMENT',
        secret: 'unexpected',
      }).success,
    ).toBe(false);
  });
  it('does not label a skipped lifecycle step as a pickup event', () => {
    expect(auditDetails.JOB_PICKED_UP.safeParse({ from: 'NEW', to: 'PICKED_UP' }).success).toBe(
      false,
    );
  });
  it('preserves a complete recommendation snapshot but rejects unusable scores', () => {
    const snapshot = assignmentFixture().recommendationSnapshot;
    expect(recommendationSnapshotSchema.safeParse(snapshot).success).toBe(true);
    snapshot.eligible[0]!.totalCost = Number.NaN;
    expect(recommendationSnapshotSchema.safeParse(snapshot).success).toBe(false);
  });
});
