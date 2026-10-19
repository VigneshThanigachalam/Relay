import type { Connection } from 'mongoose';
import { ApiError } from '../../http/api-error.js';
import {
  systemClock,
  transitionJob,
  transitionAssignment,
  type Clock,
} from '../domain/lifecycle.js';
import { releaseRiderCapacity } from '../dispatch/release-reservation.js';
import { appendJobEvent } from '../history/append-event.js';
import { attemptDto } from '../history/dto.js';
import { jobDto } from '../jobs/dto.js';
import type { PersistenceModels } from '../persistence/models.js';
import { runInTransaction } from '../persistence/transaction.js';
type Dependencies = { connection: Connection; models: PersistenceModels; clock?: Clock };
const conflict = () =>
  new ApiError(409, 'ASSIGNMENT_CONFLICT', 'Assignment does not match current delivery work');
export function createDeliveryService({ connection, models, clock = systemClock }: Dependencies) {
  async function progress(
    id: string,
    assignmentId: string,
    action: 'pickup' | 'deliver',
    actor: string,
  ) {
    return runInTransaction(connection, async (session) => {
      const job = await models.Job.findById(id).session(session).maxTimeMS(5000).lean();
      if (!job) throw new ApiError(404, 'JOB_NOT_FOUND', 'Job not found');
      const attempt = await models.Assignment.findById(assignmentId)
        .session(session)
        .maxTimeMS(5000)
        .lean();
      if (!attempt || !attempt.jobId.equals(job._id)) throw conflict();
      const current =
        job.activeAssignmentId?.equals(attempt._id) && job.assignedRiderId?.equals(attempt.riderId);
      // Stored outcomes make lost-response retries harmless, even after delivery.
      if (
        job.status === 'DELIVERED' &&
        attempt.status === 'DELIVERED' &&
        !attempt.active &&
        attempt.reservationReleasedAt
      )
        return { data: { job: jobDto(job), assignment: attemptDto(attempt) }, replayed: true };
      if (
        action === 'pickup' &&
        current &&
        job.status === 'PICKED_UP' &&
        attempt.status === 'PICKED_UP'
      )
        return { data: { job: jobDto(job), assignment: attemptDto(attempt) }, replayed: true };
      const next = transitionJob(job.status, action);
      const expected = action === 'pickup' ? 'ACCEPTED' : 'PICKED_UP';
      if (
        !current ||
        attempt.status !== expected ||
        !attempt.active ||
        !attempt.respondedAt ||
        attempt.endedAt ||
        attempt.reservationReleasedAt
      )
        throw conflict();
      const now = clock.now();
      const terminal = action === 'deliver';
      const updatedJob = await models.Job.findOneAndUpdate(
        {
          _id: job._id,
          status: job.status,
          version: job.version,
          activeAssignmentId: attempt._id,
          assignedRiderId: attempt.riderId,
        },
        {
          $set: { status: next, updatedAt: now },
          $inc: { version: 1 },
          ...(terminal ? { $unset: { activeAssignmentId: '', assignedRiderId: '' } } : {}),
        },
        { new: true, session, runValidators: true, timestamps: false },
      ).maxTimeMS(5000);
      if (!updatedJob) throw conflict();
      const updatedAttempt = await models.Assignment.findOneAndUpdate(
        {
          _id: attempt._id,
          status: expected,
          active: true,
          reservationReleasedAt: { $exists: false },
          endedAt: { $exists: false },
          respondedAt: { $exists: true },
        },
        {
          $set: {
            status: transitionAssignment(attempt.status, action),
            updatedAt: now,
            ...(terminal ? { active: false, endedAt: now, reservationReleasedAt: now } : {}),
          },
        },
        { new: true, session, runValidators: true, timestamps: false },
      ).maxTimeMS(5000);
      if (!updatedAttempt) throw conflict();
      if (terminal) await releaseRiderCapacity(models, session, attempt, now);
      await appendJobEvent(models, session, {
        jobId: job._id,
        assignmentId: attempt._id,
        type: terminal ? 'JOB_DELIVERED' : 'JOB_PICKED_UP',
        actor,
        occurredAt: now,
        details: terminal
          ? { from: 'PICKED_UP', to: 'DELIVERED', releasedUnits: attempt.loadUnits }
          : { from: 'ACCEPTED', to: 'PICKED_UP' },
      });
      return {
        data: { job: jobDto(updatedJob), assignment: attemptDto(updatedAttempt) },
        replayed: false,
      };
    });
  }
  async function cancel(id: string, reason: string, actor: string) {
    return runInTransaction(connection, async (session) => {
      const job = await models.Job.findById(id).session(session).maxTimeMS(5000).lean();
      if (!job) throw new ApiError(404, 'JOB_NOT_FOUND', 'Job not found');
      if (job.status === 'CANCELLED') {
        const event = await models.JobEvent.findOne({ jobId: job._id, type: 'JOB_CANCELLED' })
          .sort({ sequence: -1 })
          .session(session)
          .maxTimeMS(5000)
          .lean();
        if (!event || event.details.reason !== reason)
          throw new ApiError(
            409,
            'CANCELLATION_CONFLICT',
            'Cancellation reason does not match stored outcome',
          );
        const attempt = event.assignmentId
          ? await models.Assignment.findById(event.assignmentId)
              .session(session)
              .maxTimeMS(5000)
              .lean()
          : null;
        return {
          data: { job: jobDto(job), assignment: attempt ? attemptDto(attempt) : null },
          replayed: true,
        };
      }
      const next = transitionJob(job.status, 'cancel');
      const attempt = job.activeAssignmentId
        ? await models.Assignment.findById(job.activeAssignmentId)
            .session(session)
            .maxTimeMS(5000)
            .lean()
        : null;
      const assigned = job.status === 'AWAITING_CONFIRMATION' || job.status === 'ACCEPTED';
      if (assigned) {
        if (
          !attempt ||
          !attempt.jobId.equals(job._id) ||
          !job.assignedRiderId?.equals(attempt.riderId) ||
          !attempt.active ||
          attempt.reservationReleasedAt ||
          attempt.endedAt ||
          attempt.status !== (job.status === 'ACCEPTED' ? 'ACCEPTED' : 'PENDING')
        )
          throw conflict();
      } else if (
        job.activeAssignmentId ||
        job.assignedRiderId ||
        (await models.Assignment.exists({ jobId: job._id, active: true })
          .session(session)
          .maxTimeMS(5000))
      )
        throw conflict();
      const now = clock.now();
      const updatedJob = await models.Job.findOneAndUpdate(
        {
          _id: job._id,
          status: job.status,
          version: job.version,
          ...(attempt
            ? { activeAssignmentId: attempt._id, assignedRiderId: attempt.riderId }
            : { activeAssignmentId: { $exists: false }, assignedRiderId: { $exists: false } }),
        },
        {
          $set: { status: next, updatedAt: now },
          $unset: { activeAssignmentId: '', assignedRiderId: '', manualReason: '' },
          $inc: { version: 1 },
        },
        { new: true, session, runValidators: true, timestamps: false },
      ).maxTimeMS(5000);
      if (!updatedJob) throw conflict();
      let cancelled = null;
      if (attempt) {
        cancelled = await models.Assignment.findOneAndUpdate(
          {
            _id: attempt._id,
            status: attempt.status,
            active: true,
            reservationReleasedAt: { $exists: false },
            endedAt: { $exists: false },
          },
          {
            $set: {
              status: transitionAssignment(attempt.status, 'cancel'),
              active: false,
              endedAt: now,
              reservationReleasedAt: now,
              endReason: reason,
              updatedAt: now,
            },
          },
          { new: true, session, runValidators: true, timestamps: false },
        ).maxTimeMS(5000);
        if (!cancelled) throw conflict();
        await releaseRiderCapacity(models, session, attempt, now);
      }
      await appendJobEvent(models, session, {
        jobId: job._id,
        ...(attempt ? { assignmentId: attempt._id } : {}),
        type: 'JOB_CANCELLED',
        actor,
        occurredAt: now,
        details: { from: job.status, reason, releasedUnits: attempt?.loadUnits ?? 0 },
      });
      return {
        data: { job: jobDto(updatedJob), assignment: cancelled ? attemptDto(cancelled) : null },
        replayed: false,
      };
    });
  }
  return {
    pickup: (id: string, assignmentId: string, actor: string) =>
      progress(id, assignmentId, 'pickup', actor),
    deliver: (id: string, assignmentId: string, actor: string) =>
      progress(id, assignmentId, 'deliver', actor),
    cancel,
  };
}
export type DeliveryService = ReturnType<typeof createDeliveryService>;
