import { Types, type Connection } from 'mongoose';
import { ApiError } from '../../http/api-error.js';
import { systemClock, transitionJob, type Clock } from '../domain/lifecycle.js';
import { appendJobEvent } from '../history/append-event.js';
import { attemptDto } from '../history/dto.js';
import { jobDto } from '../jobs/dto.js';
import type { PersistenceModels } from '../persistence/models.js';
import { runInTransaction } from '../persistence/transaction.js';
import { rankRiders } from '../recommendations/engine.js';
import { hashAssignmentRequest, type AssignJobInput } from './contracts.js';

type Dependencies = {
  connection: Connection;
  models: PersistenceModels;
  // Supplied from validated process configuration; copied once per new attempt.
  responseThresholdMs: number;
  clock?: Clock;
};
function unknownCommit(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'hasErrorLabel' in error &&
    typeof error.hasErrorLabel === 'function' &&
    error.hasErrorLabel('UnknownTransactionCommitResult'),
  );
}
function collision(error: unknown): 'active' | 'command' | null {
  if (!error || typeof error !== 'object') return null;
  const value = error as { code?: number; keyPattern?: Record<string, unknown> };
  if (value.code !== 11000 || !value.keyPattern?.jobId) return null;
  if (value.keyPattern.requestKey) return 'command';
  return Object.keys(value.keyPattern).length === 1 ? 'active' : null;
}
function checkHash(stored: string, incoming: string) {
  if (stored !== incoming)
    throw new ApiError(
      409,
      'IDEMPOTENCY_CONFLICT',
      'Idempotency-Key was already used for a different assignment request',
    );
}

export function createDispatchService({
  connection,
  models,
  responseThresholdMs,
  clock = systemClock,
}: Dependencies) {
  async function recoverReplay(jobId: Types.ObjectId, key: string, hash: string) {
    // Recovery starts only after the failed/ambiguous transaction has ended.
    // Snapshot reads keep the returned original attempt and current job coherent.
    return runInTransaction(connection, async (session) => {
      const attempt = await models.Assignment.findOne({ jobId, requestKey: key })
        .session(session)
        .maxTimeMS(5000)
        .lean();
      if (!attempt) return null;
      checkHash(attempt.requestHash, hash);
      const job = await models.Job.findById(jobId).session(session).maxTimeMS(5000).lean();
      if (!job) throw new ApiError(404, 'JOB_NOT_FOUND', 'Job not found');
      return { data: { job: jobDto(job), assignment: attemptDto(attempt) }, replayed: true };
    });
  }

  async function recordFailure(
    jobId: Types.ObjectId,
    riderId: string,
    actor: string,
    error: ApiError,
  ) {
    try {
      // The state transaction already rolled back. Keep evidence of the rejected
      // command in a separate small transaction, without a fake reserved attempt.
      await runInTransaction(connection, async (session) => {
        await appendJobEvent(models, session, {
          jobId,
          type: 'ASSIGNMENT_FAILED',
          actor,
          occurredAt: clock.now(),
          details: { code: error.code, reason: error.message, riderId },
        });
      });
    } catch {
      throw new ApiError(
        503,
        'DEPENDENCY_UNAVAILABLE',
        'Assignment rejected but failure history could not be confirmed; refresh and retry',
      );
    }
  }

  async function assign(id: string, input: AssignJobInput, actor: string, key: string) {
    const jobId = new Types.ObjectId(id);
    const hash = hashAssignmentRequest(input);
    try {
      try {
        return await runInTransaction(connection, async (session) => {
          const job = await models.Job.findById(jobId).session(session).maxTimeMS(5000).lean();
          if (!job) throw new ApiError(404, 'JOB_NOT_FOUND', 'Job not found');
          // Check command identity before state/eligibility: a replay after rider
          // edits or a future timeout must never create another reservation.
          const existing = await models.Assignment.findOne({ jobId, requestKey: key })
            .session(session)
            .maxTimeMS(5000)
            .lean();
          if (existing) {
            checkHash(existing.requestHash, hash);
            return { data: { job: jobDto(job), assignment: attemptDto(existing) }, replayed: true };
          }
          if (['AWAITING_CONFIRMATION', 'ACCEPTED', 'PICKED_UP'].includes(job.status))
            throw new ApiError(409, 'JOB_ALREADY_ASSIGNED', 'Job already has active work');
          if (job.status !== 'READY_FOR_ASSIGNMENT' && job.status !== 'MANUAL_QUEUE')
            throw new ApiError(
              409,
              'INVALID_TRANSITION',
              `Cannot assign job in ${job.status} state`,
            );
          const active = await models.Assignment.exists({ jobId, active: true })
            .session(session)
            .maxTimeMS(5000);
          if (active)
            throw new ApiError(409, 'JOB_ALREADY_ASSIGNED', 'Job already has an active assignment');
          const riders = await models.Rider.find({}).session(session).maxTimeMS(5000).lean();
          const rider = riders.find((candidate) => candidate._id.toHexString() === input.riderId);
          if (!rider) throw new ApiError(404, 'RIDER_NOT_FOUND', 'Rider not found');
          const now = clock.now();
          const snapshot = rankRiders(
            job,
            riders.map((candidate) => ({ ...candidate, riderId: candidate._id.toHexString() })),
            now,
          );
          const chosen = snapshot.eligible.find((candidate) => candidate.riderId === input.riderId);
          if (!chosen) {
            const reasons = snapshot.excluded.find(
              (candidate) => candidate.riderId === input.riderId,
            )!.reasons;
            throw new ApiError(
              409,
              'RIDER_INELIGIBLE',
              `Chosen rider is not eligible: ${reasons.join(', ')}`,
              reasons.map((reason) => ({ path: 'riderId', message: reason })),
            );
          }
          const best = snapshot.eligible[0]!;
          const override = best.riderId !== input.riderId;
          if (override && !input.overrideReason)
            throw new ApiError(
              409,
              'OVERRIDE_REASON_REQUIRED',
              'Selecting a different eligible rider requires an operational reason',
            );
          const previous = await models.Assignment.findOne({ jobId })
            .sort({ assignedAt: -1, _id: -1 })
            .session(session)
            .maxTimeMS(5000)
            .lean();
          const assignmentId = new Types.ObjectId();
          const expiresAt = new Date(now.getTime() + responseThresholdMs);
          const updated = await models.Job.findOneAndUpdate(
            {
              _id: jobId,
              status: job.status,
              version: job.version,
              activeAssignmentId: { $exists: false },
              assignedRiderId: { $exists: false },
            },
            {
              $set: {
                status: transitionJob(job.status, 'assign'),
                activeAssignmentId: assignmentId,
                assignedRiderId: rider._id,
                updatedAt: now,
              },
              $unset: { manualReason: '' },
              $inc: { version: 1 },
            },
            { new: true, session, runValidators: true, timestamps: false },
          ).maxTimeMS(5000);
          if (!updated) throw new ApiError(409, 'STATE_CONFLICT', 'Job changed; refresh and retry');
          // The write itself must enforce eligibility, not just the earlier read.
          // $inc does not run full document validation. Valid read counters plus
          // this capacity bound preserve safe integer/nonnegative invariants.
          const reserved = await models.Rider.updateOne(
            {
              _id: rider._id,
              availability: 'AVAILABLE',
              serviceZones: { $all: [job.pickupZone, job.deliveryZone] },
              capacityUnits: rider.capacityUnits,
              reservedUnits: rider.reservedUnits,
              activeJobCount: rider.activeJobCount,
              $expr: { $gte: [{ $subtract: ['$capacityUnits', '$reservedUnits'] }, job.loadUnits] },
            },
            { $inc: { reservedUnits: job.loadUnits, activeJobCount: 1 }, $set: { updatedAt: now } },
            { session, runValidators: true, timestamps: false },
          ).maxTimeMS(5000);
          if (reserved.matchedCount !== 1)
            throw new ApiError(
              409,
              'RIDER_INELIGIBLE',
              'Rider availability or capacity changed; refresh and retry',
            );
          const [attempt] = await models.Assignment.create(
            [
              {
                _id: assignmentId,
                jobId,
                riderId: rider._id,
                loadUnits: job.loadUnits,
                assignedAt: now,
                expiresAt,
                requestKey: key,
                requestHash: hash,
                recommendationSnapshot: snapshot,
                ...(input.overrideReason ? { overrideReason: input.overrideReason } : {}),
                actor,
                createdAt: now,
                updatedAt: now,
              },
            ],
            { session },
          );
          if (!attempt) throw new Error('Assignment creation returned no record');
          await appendJobEvent(models, session, {
            jobId,
            assignmentId,
            type: 'RIDERS_RECOMMENDED',
            actor,
            occurredAt: now,
            details: { snapshot },
          });
          await appendJobEvent(models, session, {
            jobId,
            assignmentId,
            type: 'ASSIGNMENT_CREATED',
            actor,
            occurredAt: now,
            details: { riderId: input.riderId, expiresAt: expiresAt.toISOString() },
          });
          if (previous)
            await appendJobEvent(models, session, {
              jobId,
              assignmentId,
              type: 'REASSIGNED',
              actor,
              occurredAt: now,
              details: {
                previousAssignmentId: previous._id.toHexString(),
                newAssignmentId: assignmentId.toHexString(),
                riderId: input.riderId,
              },
            });
          if (override)
            await appendJobEvent(models, session, {
              jobId,
              assignmentId,
              type: 'MANUAL_OVERRIDE',
              actor,
              occurredAt: now,
              details: {
                reason: input.overrideReason!,
                recommendedRiderId: best.riderId,
                chosenRiderId: input.riderId,
                scoringVersion: 'v1',
              },
            });
          return {
            data: { job: jobDto(updated), assignment: attemptDto(attempt) },
            replayed: false,
          };
        });
      } catch (error) {
        const kind = collision(error);
        if (!kind && !unknownCommit(error)) throw error;
        const replay = await recoverReplay(jobId, key, hash);
        if (replay) return replay;
        if (kind === 'active')
          throw new ApiError(409, 'JOB_ALREADY_ASSIGNED', 'Job already has an active assignment');
        // An ambiguous success must not be labeled a failed assignment or retried
        // with a fresh key. Only a durable receipt can establish a safe replay.
        throw new ApiError(
          503,
          'DEPENDENCY_UNAVAILABLE',
          'Assignment outcome could not be confirmed; retry with the same key and payload',
        );
      }
    } catch (error) {
      if (error instanceof ApiError && (error.status === 409 || error.code === 'RIDER_NOT_FOUND'))
        await recordFailure(jobId, input.riderId, actor, error);
      throw error;
    }
  }
  return { assign };
}
export type DispatchService = ReturnType<typeof createDispatchService>;
