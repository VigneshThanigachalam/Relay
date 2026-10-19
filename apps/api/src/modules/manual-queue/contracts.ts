import { paginationSchema, serviceZoneSchema } from '../../http/contracts.js';
import type { z } from 'zod';

export const listManualQueueSchema = paginationSchema
  .extend({ zone: serviceZoneSchema.optional() })
  .strict();
export type ListManualQueueInput = z.infer<typeof listManualQueueSchema>;
