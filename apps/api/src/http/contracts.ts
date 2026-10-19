import { z } from 'zod';
import { SERVICE_ZONES } from '../modules/domain/constants.js';

// Shared transport validation avoids each feature choosing different identifier,
// actor, zone or pagination rules. Business rules stay in their own services.
export const actorSchema = z.string().trim().min(1).max(80);
export const idempotencyKeySchema = z.string().trim().min(1).max(128).optional();
export const objectIdSchema = z
  .string()
  .regex(/^[a-f0-9]{24}$/i, 'Expected a 24-character ObjectId');
export const emptyObjectSchema = z.object({}).strict();
export const serviceZoneSchema = z.string().trim().toUpperCase().pipe(z.enum(SERVICE_ZONES));
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
export type Pagination = z.infer<typeof paginationSchema>;
