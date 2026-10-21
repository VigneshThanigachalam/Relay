import { literalContains } from '../../http/search.js';
import {
  Types,
  type ClientSession,
  type Connection,
  type FilterQuery,
  type HydratedDocument,
} from 'mongoose';
import { ApiError } from '../../http/api-error.js';
import { systemClock, transitionJob, type Clock } from '../domain/lifecycle.js';
import { appendJobEvent } from '../history/append-event.js';
import type { JobRecord, PersistenceModels } from '../persistence/models.js';
import { runInTransaction } from '../persistence/transaction.js';
import {
  hashJobRequest,
  type CreateJobInput,
  type ListJobsInput,
  type Pagination,
} from './contracts.js';
import { jobDto } from './dto.js';
import { attemptDto, eventDto } from '../history/dto.js';

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

  async function detail(id: string) {
    const job = await models.Job.findById(id).maxTimeMS(5000).lean();
    if (!job) throw new ApiError(404, 'JOB_NOT_FOUND', 'Job not found');
    return { data: jobDto(job) };
  }

  async function list(input: ListJobsInput) {
    const filter: FilterQuery<JobRecord> = {};
    if (input.orderReference) filter.orderReference = input.orderReference;
    if (input.search) filter.$and = [{ orderReference: literalContains(input.search) }];
    if (input.status) filter.status = input.status;
    if (input.zone) filter.$or = [{ pickupZone: input.zone }, { deliveryZone: input.zone }];
    return runInTransaction(connection, async (session) => {
      // Data and total describe one database snapshot even if another dispatcher
      // creates work concurrently. Pagination still changes between requests.
      const total = await models.Job.countDocuments(filter).session(session).maxTimeMS(5000);
      const jobs = await models.Job.find(filter)
        .sort({ createdAt: 1, _id: 1 })
        .skip((input.page - 1) * input.pageSize)
        .limit(input.pageSize)
        .session(session)
        .maxTimeMS(5000)
        .lean();
      return {
        data: jobs.map(jobDto),
        pagination: { page: input.page, pageSize: input.pageSize, total },
      };
    });
  }

  async function ready(id: string, actor: string) {
    return runInTransaction(connection, async (session) => {
      const job = await models.Job.findById(id).session(session).maxTimeMS(5000);
      if (!job) throw new ApiError(404, 'JOB_NOT_FOUND', 'Job not found');
      if (job.status === 'READY_FOR_ASSIGNMENT') return { data: jobDto(job), replayed: true };
      const next = transitionJob(job.status, 'ready');
      const now = clock.now();
      // The transition table describes legality; this predicate protects the
      // actual stored state/version. A stale in-memory read is not a lock.
      const updated = await models.Job.findOneAndUpdate(
        { _id: job._id, status: 'NEW', version: job.version },
        { $set: { status: next, updatedAt: now }, $inc: { version: 1 } },
        { new: true, session, runValidators: true, timestamps: false },
      ).maxTimeMS(5000);
      if (!updated) throw new ApiError(409, 'STATE_CONFLICT', 'Job changed; refresh and retry');
      await appendJobEvent(models, session, {
        jobId: job._id,
        type: 'JOB_READY',
        actor,
        occurredAt: now,
        details: { from: job.status, to: next },
      });
      return { data: jobDto(updated), replayed: false };
    });
  }

  async function history(id: string, input: Pagination) {
    return runInTransaction(connection, async (session) => {
      const jobId = new Types.ObjectId(id);
      const job = await models.Job.findById(jobId)
        .select('_id')
        .session(session)
        .maxTimeMS(5000)
        .lean();
      if (!job) throw new ApiError(404, 'JOB_NOT_FOUND', 'Job not found');
      const skip = (input.page - 1) * input.pageSize;
      const total = await models.JobEvent.countDocuments({ jobId })
        .session(session)
        .maxTimeMS(5000);
      const events = await models.JobEvent.find({ jobId })
        .sort({ sequence: 1 })
        .skip(skip)
        .limit(input.pageSize)
        .session(session)
        .maxTimeMS(5000)
        .lean();
      const attemptsTotal = await models.Assignment.countDocuments({ jobId })
        .session(session)
        .maxTimeMS(5000);
      const attempts = await models.Assignment.find({ jobId })
        .sort({ assignedAt: 1, _id: 1 })
        .skip(skip)
        .limit(input.pageSize)
        .session(session)
        .maxTimeMS(5000)
        .lean();
      // Bound both arrays: retaining history must not turn this endpoint into an
      // unbounded response as failed assignment attempts accumulate later.
      return {
        data: { events: events.map(eventDto), attempts: attempts.map(attemptDto) },
        pagination: { page: input.page, pageSize: input.pageSize, total },
        attemptsPagination: { page: input.page, pageSize: input.pageSize, total: attemptsTotal },
      };
    });
  }

  return { create, detail, list, ready, history };
}
export type JobsService = ReturnType<typeof createJobsService>;
