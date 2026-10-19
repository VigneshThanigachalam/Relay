import type { Clock } from '../domain/lifecycle.js';
import { systemClock } from '../domain/lifecycle.js';
import type { PersistenceModels } from '../persistence/models.js';
import type { ResolutionService } from '../dispatch/resolution.js';

type Dependencies = {
  models: PersistenceModels;
  resolution: Pick<ResolutionService, 'expire'>;
  clock?: Clock;
  batchSize?: number;
  onAttemptError?: (id: string) => void;
};
export function createTimeoutScanner({
  models,
  resolution,
  clock = systemClock,
  batchSize = 100,
  onAttemptError = (assignmentId) => console.error('Assignment expiry failed', { assignmentId }),
}: Dependencies) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100)
    throw new RangeError('Timeout batch size must be 1–100');
  async function scan(shouldStop: () => boolean = () => false) {
    // This is a bounded shortlist, never authority to expire. Each outcome
    // transaction rechecks PENDING, deadline and matching current job pointers.
    const due = await models.Assignment.find({
      status: 'PENDING',
      active: true,
      expiresAt: { $lte: clock.now() },
    })
      .sort({ expiresAt: 1, _id: 1 })
      .limit(batchSize)
      .select('_id')
      .maxTimeMS(5000)
      .lean();
    const result = { examined: 0, expired: 0, failed: 0 };
    for (const attempt of due) {
      if (shouldStop()) break;
      result.examined++;
      try {
        if ((await resolution.expire(attempt._id.toHexString())).expired) result.expired++;
      } catch {
        result.failed++;
        // Do not let one inconsistent attempt prevent the rest of this batch.
        // Log identity only; arbitrary DB errors can contain sensitive URIs.
        onAttemptError(attempt._id.toHexString());
      }
    }
    return result;
  }
  return { scan };
}
