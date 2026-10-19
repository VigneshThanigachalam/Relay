import type { Types } from 'mongoose';
import type { AssignmentRecord, JobEventRecord } from '../persistence/models.js';

type Stored<T> = T & { _id: Types.ObjectId };

// Both job history and rider workload use the same safe public attempt shape.
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
