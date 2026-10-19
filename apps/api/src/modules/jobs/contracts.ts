import { createHash } from 'node:crypto';
import { z } from 'zod';
import { JOB_STATUSES, PRIORITIES } from '../domain/constants.js';
import { normalizeReference } from '../domain/invariants.js';
import { paginationSchema, serviceZoneSchema } from '../../http/contracts.js';
export {
  actorSchema,
  idempotencyKeySchema,
  objectIdSchema as jobIdSchema,
  emptyObjectSchema as emptyBodySchema,
  paginationSchema,
} from '../../http/contracts.js';
export type { Pagination } from '../../http/contracts.js';

const reference = z.string().trim().min(1).max(80).transform(normalizeReference);
export const createJobSchema = z
  .object({
    orderReference: reference,
    pickupZone: serviceZoneSchema,
    deliveryZone: serviceZoneSchema,
    loadUnits: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    priority: z.enum(PRIORITIES).default('NORMAL'),
    deadlineAt: z.iso
      .datetime({ offset: true })
      .transform((value) => new Date(value).toISOString())
      .optional(),
  })
  .strict();
export type CreateJobInput = z.infer<typeof createJobSchema>;

export const listJobsSchema = paginationSchema
  .extend({
    orderReference: reference.optional(),
    status: z.enum(JOB_STATUSES).optional(),
    zone: serviceZoneSchema.optional(),
  })
  .strict();
export type ListJobsInput = z.infer<typeof listJobsSchema>;

export function hashJobRequest(input: CreateJobInput): string {
  // Construct a fixed field order after validation/normalization. Hashing raw JSON
  // would treat whitespace, key order, omitted defaults and time offsets as changes.
  const canonical = {
    orderReference: input.orderReference,
    pickupZone: input.pickupZone,
    deliveryZone: input.deliveryZone,
    loadUnits: input.loadUnits,
    priority: input.priority,
    deadlineAt: input.deadlineAt ?? null,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
