import type { ClientSession, Connection, HydratedDocument } from 'mongoose';
import { ApiError } from '../../http/api-error.js';
import { systemClock, type Clock } from '../domain/lifecycle.js';
import { appendJobEvent } from '../history/append-event.js';
import type { JobRecord, PersistenceModels } from '../persistence/models.js';
import { runInTransaction } from '../persistence/transaction.js';
import { hashJobRequest, type CreateJobInput } from './contracts.js';
import { jobDto } from './dto.js';

type JobDocument = HydratedDocument<JobRecord>;
type Dependencies = { connection: Connection; models: PersistenceModels; clock?: Clock };

function isJobIdentityCollision(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { code?: number; keyPattern?: Record<string, unknown> };
  return e.code === 11000 && Boolean(e.keyPattern?.orderReference || e.keyPattern?.creationKey);
}
function hasUnknownCommit(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'hasErrorLabel' in error &&
    typeof error.hasErrorLabel === 'function' &&
    error.hasErrorLabel('UnknownTransactionCommitResult'),
  );
}

export function createJobsService({ connection, models, clock = systemClock }: Dependencies) {
  async function findExisting(
    input: CreateJobInput,
    requestHash: string,
    creationKey?: string,
    session?: ClientSession,
  ): Promise<JobDocument | null> {
    const find = (filter: Record<string, unknown>) => {
      const query = models.Job.findOne(filter).maxTimeMS(5000);
      return session ? query.session(session) : query.readConcern('majority');
    };
    // Key lookup takes precedence: reusing a key for another order must conflict
    // even if that different order reference already exists independently.
    const keyed = creationKey ? await find({ creationKey }) : null;
    if (keyed) {
      if (keyed.requestHash !== requestHash)
        throw new ApiError(
          409,
          'IDEMPOTENCY_CONFLICT',
          'Idempotency-Key was already used for a different job request',
        );
      return keyed;
    }
    const existing = await find({ orderReference: input.orderReference });
    if (!existing) return null;
    if (existing.requestHash !== requestHash)
      throw new ApiError(
        409,
        'DUPLICATE_JOB',
        'Order reference already exists with different delivery details',
      );
    // One creation key is captured on the original write. Do not silently accept
    // a new key without durably binding it: a later reuse could create another job.
    if (creationKey && existing.creationKey !== creationKey)
      throw new ApiError(
        409,
        'IDEMPOTENCY_CONFLICT',
        'Existing order has a different creation key; reuse the original key or omit it',
      );
    return existing;
  }

  async function create(input: CreateJobInput, actor: string, creationKey?: string) {
    const requestHash = hashJobRequest(input);
    try {
      return await runInTransaction(connection, async (session) => {
        const existing = await findExisting(input, requestHash, creationKey, session);
        if (existing) return { data: jobDto(existing), replayed: true };
        const now = clock.now();
        // Replays are checked first, so a once-valid deadline may now be past.
        // This check applies only to genuinely new jobs and each transaction retry.
        if (input.deadlineAt && new Date(input.deadlineAt).getTime() <= now.getTime())
          throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', [
            { path: 'deadlineAt', message: 'Deadline must be in the future for a new job' },
          ]);
        const [job] = await models.Job.create(
          [
            {
              ...input,
              requestHash,
              ...(creationKey ? { creationKey } : {}),
              createdAt: now,
              updatedAt: now,
            },
          ],
          { session },
        );
        if (!job) throw new Error('Job creation returned no record');
        await appendJobEvent(models, session, {
          jobId: job._id,
          type: 'JOB_CREATED',
          actor,
          occurredAt: now,
          details: {
            orderReference: job.orderReference,
            pickupZone: job.pickupZone,
            deliveryZone: job.deliveryZone,
            loadUnits: job.loadUnits,
            priority: job.priority,
          },
        });
        return { data: jobDto(job), replayed: false };
      });
    } catch (error) {
      if (!isJobIdentityCollision(error) && !hasUnknownCommit(error)) throw error;
      // A duplicate-key error aborts its transaction. Resolve the winning write
      // outside it; querying inside an already-aborted session is not recovery.
      const existing = await findExisting(input, requestHash, creationKey);
      if (existing) return { data: jobDto(existing), replayed: true };
      throw new ApiError(
        503,
        'DEPENDENCY_UNAVAILABLE',
        'Creation outcome could not be confirmed; retry the same request',
      );
    }
  }

  return { create };
}
export type JobsService = ReturnType<typeof createJobsService>;
