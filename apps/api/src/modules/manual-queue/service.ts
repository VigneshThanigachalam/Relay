import type { Connection, FilterQuery, Types } from 'mongoose';
import { systemClock, type Clock } from '../domain/lifecycle.js';
import { attemptSummaryDto } from '../history/dto.js';
import { jobDto } from '../jobs/dto.js';
import type { JobEventRecord, JobRecord, PersistenceModels } from '../persistence/models.js';
import { runInTransaction } from '../persistence/transaction.js';
import type { ListManualQueueInput } from './contracts.js';

type Dependencies = { connection: Connection; models: PersistenceModels; clock?: Clock };
type QueueEvent = Pick<
  JobEventRecord,
  'jobId' | 'type' | 'sequence' | 'occurredAt' | 'actor' | 'details'
> & { _id: Types.ObjectId };
type EventGroup = { event: QueueEvent };
type AttemptGroup = { attempt: Parameters<typeof attemptSummaryDto>[0] };
export function createManualQueueService({
  connection,
  models,
  clock = systemClock,
}: Dependencies) {
  async function list(input: ListManualQueueInput) {
    const filter: FilterQuery<JobRecord> = { status: 'MANUAL_QUEUE' };
    if (input.zone) filter.$or = [{ pickupZone: input.zone }, { deliveryZone: input.zone }];
    return runInTransaction(connection, async (session) => {
      const total = await models.Job.countDocuments(filter).session(session).maxTimeMS(5000);
      const jobs = await models.Job.find(filter)
        .sort({ createdAt: 1, _id: 1 })
        .skip((input.page - 1) * input.pageSize)
        .limit(input.pageSize)
        .session(session)
        .maxTimeMS(5000)
        .lean();
      const ids = jobs.map((job) => job._id);
      // Batch by the bounded page, not two extra queries per row. Project before
      // grouping so large immutable scoring snapshots never inflate queue rows.
      const events = ids.length
        ? await models.JobEvent.aggregate<EventGroup>([
            {
              $match: {
                jobId: { $in: ids },
                type: { $in: ['MANUAL_QUEUE_ENTERED', 'ASSIGNMENT_FAILED'] },
              },
            },
            {
              $project: {
                _id: 1,
                jobId: 1,
                type: 1,
                sequence: 1,
                occurredAt: 1,
                actor: 1,
                details: 1,
              },
            },
            { $sort: { jobId: -1, sequence: -1 } },
            { $group: { _id: { jobId: '$jobId', type: '$type' }, event: { $first: '$$ROOT' } } },
          ])
            .session(session)
            .option({ maxTimeMS: 5000 })
        : [];
      const attempts = ids.length
        ? await models.Assignment.aggregate<AttemptGroup>([
            { $match: { jobId: { $in: ids } } },
            {
              $project: {
                _id: 1,
                jobId: 1,
                riderId: 1,
                status: 1,
                active: 1,
                loadUnits: 1,
                assignedAt: 1,
                expiresAt: 1,
                respondedAt: 1,
                endedAt: 1,
                reservationReleasedAt: 1,
                overrideReason: 1,
                endReason: 1,
                actor: 1,
              },
            },
            { $sort: { jobId: -1, assignedAt: -1, _id: -1 } },
            { $group: { _id: '$jobId', attempt: { $first: '$$ROOT' } } },
          ])
            .session(session)
            .option({ maxTimeMS: 5000 })
        : [];
      const entries = new Map(
        events
          .filter(({ event }) => event.type === 'MANUAL_QUEUE_ENTERED')
          .map(({ event }) => [event.jobId.toHexString(), event]),
      );
      const failures = new Map(
        events
          .filter(({ event }) => event.type === 'ASSIGNMENT_FAILED')
          .map(({ event }) => [event.jobId.toHexString(), event]),
      );
      const latest = new Map(attempts.map(({ attempt }) => [attempt.jobId.toHexString(), attempt]));
      const asOf = clock.now();
      return {
        data: jobs.map((job) => {
          const id = job._id.toHexString();
          const entry = entries.get(id);
          const failure = failures.get(id);
          const attempt = latest.get(id);
          // Do not reconstruct missing audit history from updatedAt: failed
          // commands and future edits are not evidence of a new queue entry.
          const historyIncomplete = !entry || entry.details?.reason !== job.manualReason;
          return {
            ...jobDto(job),
            manualEnteredAt: !historyIncomplete && entry ? entry.occurredAt.toISOString() : null,
            manualAgeMs:
              !historyIncomplete && entry
                ? Math.max(0, asOf.getTime() - entry.occurredAt.getTime())
                : null,
            manualEntryActor: !historyIncomplete && entry ? entry.actor : null,
            historyIncomplete,
            latestAttempt: attempt ? attemptSummaryDto(attempt) : null,
            latestAssignmentFailure: failure
              ? {
                  id: failure._id.toHexString(),
                  sequence: failure.sequence,
                  occurredAt: failure.occurredAt.toISOString(),
                  actor: failure.actor,
                  code: failure.details.code as string,
                  reason: failure.details.reason as string,
                  riderId: (failure.details.riderId as string | undefined) ?? null,
                }
              : null,
          };
        }),
        asOf: asOf.toISOString(),
        pagination: { page: input.page, pageSize: input.pageSize, total },
      };
    });
  }
  return { list };
}
export type ManualQueueService = ReturnType<typeof createManualQueueService>;
