import { Types, type Connection, type FilterQuery } from 'mongoose';
import { ApiError } from '../../http/api-error.js';
import type { Pagination } from '../../http/contracts.js';
import { systemClock, type Clock } from '../domain/lifecycle.js';
import { attemptDto } from '../history/dto.js';
import type { PersistenceModels, RiderRecord } from '../persistence/models.js';
import { runInTransaction } from '../persistence/transaction.js';
import type { CreateRiderInput, ListRidersInput } from './contracts.js';
import { riderDto } from './dto.js';

type Dependencies = { connection: Connection; models: PersistenceModels; clock?: Clock };
function isCodeCollision(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { code?: number; keyPattern?: Record<string, unknown> };
  return value.code === 11000 && Boolean(value.keyPattern?.code);
}
export function createRidersService({ connection, models, clock = systemClock }: Dependencies) {
  async function create(input: CreateRiderInput, actor: string) {
    try {
      return await runInTransaction(connection, async (session) => {
        const now = clock.now();
        const [rider] = await models.Rider.create(
          [{ ...input, createdBy: actor, updatedBy: actor, createdAt: now, updatedAt: now }],
          { session },
        );
        if (!rider) throw new Error('Rider creation returned no record');
        return { data: riderDto(rider) };
      });
    } catch (error) {
      // This is identity uniqueness, not job idempotency. Repeated rider codes
      // conflict; they must never overwrite availability or reserved workload.
      if (isCodeCollision(error))
        throw new ApiError(409, 'DUPLICATE_RIDER', 'Rider code already exists');
      throw error;
    }
  }
  async function list(input: ListRidersInput) {
    const filter: FilterQuery<RiderRecord> = {};
    if (input.code) filter.code = input.code;
    if (input.availability) filter.availability = input.availability;
    if (input.zone) filter.serviceZones = input.zone;
    return runInTransaction(connection, async (session) => {
      const total = await models.Rider.countDocuments(filter).session(session).maxTimeMS(5000);
      const riders = await models.Rider.find(filter)
        .sort({ code: 1, _id: 1 })
        .skip((input.page - 1) * input.pageSize)
        .limit(input.pageSize)
        .session(session)
        .maxTimeMS(5000)
        .lean();
      return {
        data: riders.map(riderDto),
        pagination: { page: input.page, pageSize: input.pageSize, total },
      };
    });
  }
  async function detail(id: string, input: Pagination) {
    return runInTransaction(connection, async (session) => {
      const rider = await models.Rider.findById(id).session(session).maxTimeMS(5000).lean();
      if (!rider) throw new ApiError(404, 'RIDER_NOT_FOUND', 'Rider not found');
      const filter = { riderId: new Types.ObjectId(id), active: true };
      const total = await models.Assignment.countDocuments(filter).session(session).maxTimeMS(5000);
      const assignments = await models.Assignment.find(filter)
        .sort({ assignedAt: 1, _id: 1 })
        .skip((input.page - 1) * input.pageSize)
        .limit(input.pageSize)
        .session(session)
        .maxTimeMS(5000)
        .lean();
      return {
        data: { ...riderDto(rider), activeAssignments: assignments.map(attemptDto) },
        pagination: { page: input.page, pageSize: input.pageSize, total },
      };
    });
  }
  return { create, list, detail };
}
export type RidersService = ReturnType<typeof createRidersService>;
