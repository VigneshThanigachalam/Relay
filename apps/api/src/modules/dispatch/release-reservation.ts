import type { ClientSession, Types } from 'mongoose';
import { ApiError } from '../../http/api-error.js';
import { hasValidRiderCounters } from '../domain/invariants.js';
import type { PersistenceModels } from '../persistence/models.js';

// Call only after winning the attempt's guarded terminal transition, in the same
// transaction. A release marker alone, written separately, would not be enough.
export async function releaseRiderCapacity(
  models: PersistenceModels,
  session: ClientSession,
  reservation: { riderId: Types.ObjectId; loadUnits: number },
  now: Date,
) {
  if (!session.inTransaction()) throw new Error('Capacity release requires a transaction');
  const rider = await models.Rider.findById(reservation.riderId)
    .session(session)
    .maxTimeMS(5000)
    .lean();
  const conflict = () =>
    new ApiError(
      409,
      'WORKLOAD_CONFLICT',
      'Reserved rider workload is inconsistent; release aborted',
    );
  if (
    !rider ||
    !hasValidRiderCounters(rider.capacityUnits, rider.reservedUnits, rider.activeJobCount) ||
    rider.reservedUnits < reservation.loadUnits ||
    rider.activeJobCount < 1 ||
    !hasValidRiderCounters(
      rider.capacityUnits,
      rider.reservedUnits - reservation.loadUnits,
      rider.activeJobCount - 1,
    )
  )
    throw conflict();
  const updated = await models.Rider.updateOne(
    {
      _id: rider._id,
      capacityUnits: rider.capacityUnits,
      reservedUnits: rider.reservedUnits,
      activeJobCount: rider.activeJobCount,
    },
    {
      $inc: { reservedUnits: -reservation.loadUnits, activeJobCount: -1 },
      $set: { updatedAt: now },
    },
    { session, runValidators: true, timestamps: false },
  ).maxTimeMS(5000);
  if (updated.matchedCount !== 1) throw conflict();
}
