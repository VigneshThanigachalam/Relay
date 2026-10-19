import type { Connection } from 'mongoose';
import { ApiError } from '../../http/api-error.js';
import {
  InvalidTransitionError,
  systemClock,
  transitionJob,
  type Clock,
} from '../domain/lifecycle.js';
import { appendJobEvent } from '../history/append-event.js';
import type { PersistenceModels } from '../persistence/models.js';
import { runInTransaction } from '../persistence/transaction.js';
import { rankRiders } from './engine.js';

type Dependencies = { connection: Connection; models: PersistenceModels; clock?: Clock };
export function createRecommendationsService({
  connection,
  models,
  clock = systemClock,
}: Dependencies) {
  async function recommend(id: string, actor: string) {
    return runInTransaction(connection, async (session) => {
      const job = await models.Job.findById(id).session(session).maxTimeMS(5000).lean();
      if (!job) throw new ApiError(404, 'JOB_NOT_FOUND', 'Job not found');
      if (job.status !== 'READY_FOR_ASSIGNMENT' && job.status !== 'MANUAL_QUEUE') {
        throw new InvalidTransitionError('job', job.status, 'recommend riders for');
      }
      // A complete fleet snapshot makes exclusions explainable. This intentionally
      // favors clarity for a small operation; large fleets need bounded shortlists.
      const riders = await models.Rider.find({}).session(session).maxTimeMS(5000).lean();
      const now = clock.now();
      const snapshot = rankRiders(
        job,
        riders.map((rider) => ({ ...rider, riderId: rider._id.toHexString() })),
        now,
      );
      const entersManual = snapshot.eligible.length === 0 && job.status === 'READY_FOR_ASSIGNMENT';
      const status = entersManual ? transitionJob(job.status, 'no_candidates') : job.status;
      if (entersManual) {
        const updated = await models.Job.findOneAndUpdate(
          {
            _id: job._id,
            status: job.status,
            version: job.version,
            activeAssignmentId: { $exists: false },
            assignedRiderId: { $exists: false },
          },
          {
            $set: { status, manualReason: 'NO_ELIGIBLE_RIDER', updatedAt: now },
            $inc: { version: 1 },
          },
          { new: true, session, timestamps: false, runValidators: true },
        ).maxTimeMS(5000);
        if (!updated) throw new ApiError(409, 'STATE_CONFLICT', 'Job changed; refresh and retry');
      }
      // Appending writes the same job's sequence counter, so concurrent job
      // transitions force a transaction retry and a fresh legality check. Rider
      // reads are advice only: this transaction never reserves or locks riders.
      await appendJobEvent(models, session, {
        jobId: job._id,
        type: 'RIDERS_RECOMMENDED',
        actor,
        occurredAt: now,
        details: { snapshot },
      });
      if (entersManual) {
        await appendJobEvent(models, session, {
          jobId: job._id,
          type: 'MANUAL_QUEUE_ENTERED',
          actor,
          occurredAt: now,
          details: { reason: 'NO_ELIGIBLE_RIDER' },
        });
      }
      return { data: { ...snapshot, jobStatus: status } };
    });
  }
  return { recommend };
}
export type RecommendationsService = ReturnType<typeof createRecommendationsService>;
