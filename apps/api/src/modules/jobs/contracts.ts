import { createHash } from 'node:crypto';
import { z } from 'zod';
import { JOB_STATUSES, PRIORITIES, SERVICE_ZONES } from '../domain/constants.js';
import { normalizeReference } from '../domain/invariants.js';

const reference = z.string().trim().min(1).max(80).transform(normalizeReference);
const zone = z.string().trim().toUpperCase().pipe(z.enum(SERVICE_ZONES));
export const actorSchema = z.string().trim().min(1).max(80);
export const idempotencyKeySchema = z.string().trim().min(1).max(128).optional();
export const jobIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Expected a 24-character ObjectId');
export const emptyBodySchema = z.object({}).strict();

export const createJobSchema = z
  .object({
    orderReference: reference,
    pickupZone: zone,
    deliveryZone: zone,
    loadUnits: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    priority: z.enum(PRIORITIES).default('NORMAL'),
    deadlineAt: z.iso
      .datetime({ offset: true })
      .transform((value) => new Date(value).toISOString())
      .optional(),
  })
  .strict();
export type CreateJobInput = z.infer<typeof createJobSchema>;

const pageValue = z
  .string()
  .regex(/^[1-9]\d*$/, 'Expected a positive integer')
  .transform(Number);
export const paginationSchema = z
  .object({
    page: pageValue.pipe(z.number().max(10000)).default(1),
    pageSize: pageValue.pipe(z.number().max(100)).default(20),
  })
  .strict();
export const listJobsSchema = paginationSchema
  .extend({
    orderReference: reference.optional(),
    status: z.enum(JOB_STATUSES).optional(),
    zone: zone.optional(),
  })
  .strict();
export type Pagination = z.infer<typeof paginationSchema>;
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
