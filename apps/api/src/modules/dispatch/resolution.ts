import type { Connection } from 'mongoose';
import { ApiError } from '../../http/api-error.js';
import {
  isAssignmentExpired,
  systemClock,
  transitionAssignment,
  transitionJob,
  type Clock,
} from '../domain/lifecycle.js';
import { appendJobEvent } from '../history/append-event.js';
import { attemptDto } from '../history/dto.js';
import { jobDto } from '../jobs/dto.js';
import type { PersistenceModels } from '../persistence/models.js';
import { runInTransaction } from '../persistence/transaction.js';
import { releaseRiderCapacity } from './release-reservation.js';

type Dependencies = { connection: Connection; models: PersistenceModels; clock?: Clock };
type Command =
  | { kind: 'accept'; actor: string }
  | { kind: 'reject'; actor: string; reason: string }
  | { kind: 'expire'; actor: string };
export function createResolutionService({ connection, models, clock = systemClock }: Dependencies) {
  async function resolve(id: string, command: Command) {
    return runInTransaction(connection, async (session) => {
      const attempt = await models.Assignment.findById(id).session(session).maxTimeMS(5000).lean();
      if (!attempt) throw new ApiError(404, 'ASSIGNMENT_NOT_FOUND', 'Assignment not found');
      const job = await models.Job.findById(attempt.jobId).session(session).maxTimeMS(5000).lean();
      if (!job) throw new ApiError(409, 'ASSIGNMENT_CONFLICT', 'Assignment job is missing');
      const current =
        job.activeAssignmentId?.equals(attempt._id) && job.assignedRiderId?.equals(attempt.riderId);
      const response = (replayed: boolean, expired: boolean) => ({
        data: { job: jobDto(job), assignment: attemptDto(attempt) },
        replayed,
        expired,
      });
      if (attempt.status !== 'PENDING') {
        if (command.kind === 'expire') return response(true, false);
        if (attempt.status === 'EXPIRED') return response(true, true);
        if (
          command.kind === 'accept' &&
          ['ACCEPTED', 'PICKED_UP', 'DELIVERED'].includes(attempt.status) &&
          (attempt.status === 'DELIVERED' || (current && job.status === attempt.status))
        )
          return response(true, false);
        if (
          command.kind === 'reject' &&
          attempt.status === 'REJECTED' &&
          attempt.endReason === command.reason
        )
          return response(true, false);
        throw new ApiError(
          409,
          'ASSIGNMENT_CONFLICT',
          'Assignment already has a different outcome',
        );
      }
      if (
        !current ||
        job.status !== 'AWAITING_CONFIRMATION' ||
        !attempt.active ||
        attempt.reservationReleasedAt ||
        attempt.endedAt ||
        attempt.respondedAt
      )
        throw new ApiError(
          409,
          'ASSIGNMENT_CONFLICT',
          'Pending attempt does not match current job work',
        );
      // Capture on each callback attempt. This is the server's decision time,
      // not a promise that commit happens before the wall-clock deadline.
      const now = clock.now();
      const due = isAssignmentExpired(attempt.expiresAt, now);
      if (command.kind === 'expire' && !due) return response(true, false);
      const action = due ? 'expire' : command.kind;
      // expire commands already returned above when early; this narrowing keeps
      // all three outcomes on the same guarded job/attempt transaction path.
      const accepted = action === 'accept';
      const reason =
        action === 'expire'
          ? 'RESPONSE_TIMEOUT'
          : command.kind === 'reject'
            ? command.reason
            : undefined;
      const manualReason = action === 'expire' ? 'RESPONSE_TIMEOUT' : 'RIDER_REJECTED';
      const updatedJob = await models.Job.findOneAndUpdate(
        {
          _id: job._id,
          status: 'AWAITING_CONFIRMATION',
          version: job.version,
          activeAssignmentId: attempt._id,
          assignedRiderId: attempt.riderId,
        },
        accepted
          ? {
              $set: { status: transitionJob(job.status, 'accept'), updatedAt: now },
              $inc: { version: 1 },
            }
          : {
              $set: { status: transitionJob(job.status, action), manualReason, updatedAt: now },
              $unset: { activeAssignmentId: '', assignedRiderId: '' },
              $inc: { version: 1 },
            },
        { new: true, session, runValidators: true, timestamps: false },
      ).maxTimeMS(5000);
      if (!updatedJob)
        throw new ApiError(409, 'ASSIGNMENT_CONFLICT', 'Job changed; refresh and retry');
      const updatedAttempt = await models.Assignment.findOneAndUpdate(
        {
          _id: attempt._id,
          status: 'PENDING',
          active: true,
          reservationReleasedAt: { $exists: false },
          endedAt: { $exists: false },
          respondedAt: { $exists: false },
          expiresAt: action === 'expire' ? { $lte: now } : { $gt: now },
        },
        {
          $set: {
            status: transitionAssignment(attempt.status, action),
            active: accepted,
            updatedAt: now,
            ...(action === 'expire' ? {} : { respondedAt: now }),
            ...(accepted ? {} : { endedAt: now, reservationReleasedAt: now, endReason: reason }),
          },
        },
        { new: true, session, runValidators: true, timestamps: false },
      ).maxTimeMS(5000);
      if (!updatedAttempt)
        throw new ApiError(409, 'ASSIGNMENT_CONFLICT', 'Assignment changed; refresh and retry');
      if (!accepted) await releaseRiderCapacity(models, session, attempt, now);
      const type = accepted
        ? 'ASSIGNMENT_ACCEPTED'
        : action === 'reject'
          ? 'ASSIGNMENT_REJECTED'
          : 'ASSIGNMENT_EXPIRED';
      await appendJobEvent(models, session, {
        jobId: job._id,
        assignmentId: attempt._id,
        actor: command.actor,
        occurredAt: now,
        type,
        details: accepted
          ? { riderId: attempt.riderId.toHexString() }
          : { reason, releasedUnits: attempt.loadUnits },
      });
      if (!accepted)
        await appendJobEvent(models, session, {
          jobId: job._id,
          assignmentId: attempt._id,
          actor: command.actor,
          occurredAt: now,
          type: 'MANUAL_QUEUE_ENTERED',
          details: { reason: manualReason },
        });
      return {
        data: { job: jobDto(updatedJob), assignment: attemptDto(updatedAttempt) },
        replayed: false,
        expired: action === 'expire',
      };
    });
  }
  async function respond(id: string, command: Exclude<Command, { kind: 'expire' }>) {
    const { expired, ...result } = await resolve(id, command);
    // Throw only AFTER commit: throwing inside the callback would roll back the
    // late-response expiry and leak the reservation until the next worker scan.
    if (expired)
      throw new ApiError(
        409,
        'ASSIGNMENT_EXPIRED',
        'Assignment expired; refresh the job before another dispatch attempt',
      );
    return result;
  }
  return {
    accept: (id: string, actor: string) => respond(id, { kind: 'accept', actor }),
    reject: (id: string, reason: string, actor: string) =>
      respond(id, { kind: 'reject', reason, actor }),
    expire: (id: string) => resolve(id, { kind: 'expire', actor: 'system:timeout-worker' }),
  };
}
export type ResolutionService = ReturnType<typeof createResolutionService>;
