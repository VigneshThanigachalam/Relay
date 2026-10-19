import type { Types } from 'mongoose';
import { ApiError } from '../../http/api-error.js';
import { hasValidRiderCounters } from '../domain/invariants.js';
import type { RiderRecord } from '../persistence/models.js';

export function assertValidWorkload(rider: RiderRecord): void {
  if (!hasValidRiderCounters(rider.capacityUnits, rider.reservedUnits, rider.activeJobCount)) {
    // Do not clamp corrupt counters to zero or make a rider look available. A
    // reconciliation operation needs to inspect the underlying attempts later.
    throw new ApiError(
      409,
      'WORKLOAD_CONFLICT',
      'Stored rider workload is inconsistent; reconcile it before dispatch',
    );
  }
}
export function riderDto(rider: RiderRecord & { _id: Types.ObjectId }) {
  assertValidWorkload(rider);
  return {
    id: rider._id.toHexString(),
    code: rider.code,
    name: rider.name,
    serviceZones: [...rider.serviceZones],
    currentZone: rider.currentZone,
    availability: rider.availability,
    capacityUnits: rider.capacityUnits,
    reservedUnits: rider.reservedUnits,
    availableUnits: rider.capacityUnits - rider.reservedUnits,
    activeJobCount: rider.activeJobCount,
    createdAt: rider.createdAt.toISOString(),
    updatedAt: rider.updatedAt.toISOString(),
    createdBy: rider.createdBy ?? null,
    updatedBy: rider.updatedBy ?? null,
  };
}
