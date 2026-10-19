import type { Types } from 'mongoose';
import type { JobRecord } from '../persistence/models.js';

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
