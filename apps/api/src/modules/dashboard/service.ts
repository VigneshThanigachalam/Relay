import type { Connection, FilterQuery } from 'mongoose';
import { JOB_STATUSES, type JobStatus, type ServiceZone } from '../domain/constants.js';
import { systemClock, type Clock } from '../domain/lifecycle.js';
import { jobDto } from '../jobs/dto.js';
import type { JobRecord, PersistenceModels } from '../persistence/models.js';
import { runInTransaction } from '../persistence/transaction.js';

type Dependencies = { connection: Connection; models: PersistenceModels; clock?: Clock };
export function createDashboardService({ connection, models, clock = systemClock }: Dependencies) {
  async function read(zone?: ServiceZone) {
    return runInTransaction(connection, async (session) => {
      const now = clock.now();
      const filter: FilterQuery<JobRecord> = zone
        ? { $or: [{ pickupZone: zone }, { deliveryZone: zone }] }
        : {};
      const grouped = await models.Job.aggregate<{ _id: JobStatus; count: number }>([
        { $match: filter },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ])
        .session(session)
        .option({ maxTimeMS: 5000 });
      const byStatus = Object.fromEntries(JOB_STATUSES.map((status) => [status, 0])) as Record<
        JobStatus,
        number
      >;
      for (const row of grouped) byStatus[row._id] = row.count;
      // Read all cards and the bounded attention queue in one snapshot. A timeout
      // may be due before the worker commits: show it as due, never as expired.
      const [result] = await models.Job.aggregate<{
        total: { count: number }[];
        jobs: (JobRecord & { _id: import('mongoose').Types.ObjectId; attentionReason: string })[];
      }>([
        { $match: { $and: [filter, { status: { $nin: ['DELIVERED', 'CANCELLED'] } }] } },
        {
          $lookup: {
            from: 'assignments',
            localField: 'activeAssignmentId',
            foreignField: '_id',
            pipeline: [
              { $match: { status: 'PENDING', active: true, expiresAt: { $lte: now } } },
              { $project: { _id: 1 } },
            ],
            as: 'dueAttempt',
          },
        },
        {
          $set: {
            attentionReason: {
              $switch: {
                branches: [
                  { case: { $eq: ['$status', 'MANUAL_QUEUE'] }, then: '$manualReason' },
                  {
                    case: {
                      $and: [
                        { $ne: [{ $ifNull: ['$deadlineAt', null] }, null] },
                        { $lte: ['$deadlineAt', now] },
                      ],
                    },
                    then: 'DEADLINE_OVERDUE',
                  },
                  {
                    case: {
                      $and: [
                        { $eq: ['$status', 'AWAITING_CONFIRMATION'] },
                        { $gt: [{ $size: '$dueAttempt' }, 0] },
                      ],
                    },
                    then: 'CONFIRMATION_OVERDUE',
                  },
                ],
                default: null,
              },
            },
          },
        },
        { $match: { attentionReason: { $ne: null } } },
        {
          $facet: {
            total: [{ $count: 'count' }],
            jobs: [
              { $sort: { createdAt: 1, _id: 1 } },
              { $limit: 20 },
              { $project: { dueAttempt: 0 } },
            ],
          },
        },
      ])
        .session(session)
        .option({ maxTimeMS: 5000 });
      const attentionTotal = result?.total[0]?.count ?? 0;
      const jobs = result?.jobs ?? [];
      return {
        data: {
          byStatus,
          total: Object.values(byStatus).reduce((sum, value) => sum + value, 0),
          awaitingAssignment: byStatus.NEW + byStatus.READY_FOR_ASSIGNMENT,
          inProgress: byStatus.ACCEPTED + byStatus.PICKED_UP,
          attention: jobs.map((job) => ({ ...jobDto(job), attentionReason: job.attentionReason })),
          attentionTotal,
          asOf: now.toISOString(),
        },
      };
    });
  }
  return { read };
}
export type DashboardService = ReturnType<typeof createDashboardService>;
