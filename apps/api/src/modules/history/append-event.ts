import type { ClientSession, Types } from 'mongoose';
import type { EventType } from '../domain/constants.js';
import type { PersistenceModels } from '../persistence/models.js';
import { ApiError } from '../../http/api-error.js';

type NewEvent = {
  jobId: Types.ObjectId;
  type: EventType;
  actor: string;
  occurredAt: Date;
  assignmentId?: Types.ObjectId;
  details: Record<string, unknown>;
};

export async function appendJobEvent(
  models: PersistenceModels,
  session: ClientSession,
  input: NewEvent,
): Promise<void> {
  if (!session.inTransaction()) throw new Error('Audit appends require an active transaction');
  // Allocate the sequence on the job, not with countDocuments()+1: two concurrent
  // actions would otherwise pick the same number. A failed append rolls this back.
  const job = await models.Job.findOneAndUpdate(
    { _id: input.jobId },
    { $inc: { eventSequence: 1 } },
    { new: true, session, timestamps: false, runValidators: true },
  )
    .select('eventSequence')
    .maxTimeMS(5000);
  if (!job) throw new ApiError(404, 'JOB_NOT_FOUND', 'Job not found');
  await models.JobEvent.create([{ ...input, sequence: job.eventSequence }], { session });
}
