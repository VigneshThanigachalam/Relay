import type { Types } from 'mongoose';
import type { AssignmentRecord, JobEventRecord, JobRecord } from '../persistence/models.js';

type Stored<T> = T & { _id: Types.ObjectId };
export function jobDto(job: Stored<JobRecord>) {
  // Keep the API contract explicit. Returning a Mongoose document would leak
  // request hashes/keys and couple frontend consumers to persistence internals.
  return {
    id: job._id.toHexString(),
    orderReference: job.orderReference,
    pickupZone: job.pickupZone,
    deliveryZone: job.deliveryZone,
    loadUnits: job.loadUnits,
    priority: job.priority,
    deadlineAt: job.deadlineAt?.toISOString() ?? null,
    status: job.status,
    activeAssignmentId: job.activeAssignmentId?.toHexString() ?? null,
    assignedRiderId: job.assignedRiderId?.toHexString() ?? null,
    manualReason: job.manualReason ?? null,
    version: job.version,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}
export function eventDto(event: Stored<JobEventRecord>) {
  return {
    id: event._id.toHexString(),
    jobId: event.jobId.toHexString(),
    sequence: event.sequence,
    type: event.type,
    occurredAt: event.occurredAt.toISOString(),
    actor: event.actor,
    assignmentId: event.assignmentId?.toHexString() ?? null,
    details: event.details,
  };
}
export function attemptDto(attempt: Stored<AssignmentRecord>) {
  return {
    id: attempt._id.toHexString(),
    jobId: attempt.jobId.toHexString(),
    riderId: attempt.riderId.toHexString(),
    status: attempt.status,
    active: attempt.active,
    loadUnits: attempt.loadUnits,
    assignedAt: attempt.assignedAt.toISOString(),
    expiresAt: attempt.expiresAt.toISOString(),
    respondedAt: attempt.respondedAt?.toISOString() ?? null,
    endedAt: attempt.endedAt?.toISOString() ?? null,
    reservationReleasedAt: attempt.reservationReleasedAt?.toISOString() ?? null,
    overrideReason: attempt.overrideReason ?? null,
    endReason: attempt.endReason ?? null,
    actor: attempt.actor,
    recommendationSnapshot: attempt.recommendationSnapshot,
  };
}
