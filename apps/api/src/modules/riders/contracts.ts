import { z } from 'zod';
import { paginationSchema, serviceZoneSchema } from '../../http/contracts.js';
import { AVAILABILITY_STATUSES, SERVICE_ZONES } from '../domain/constants.js';
import { normalizeReference } from '../domain/invariants.js';

const code = z.string().trim().min(1).max(40).transform(normalizeReference);
const name = z.string().trim().min(1).max(100);
const capacity = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const availability = z.enum(AVAILABILITY_STATUSES);
const serviceZones = z
  .array(serviceZoneSchema)
  .min(1)
  .max(SERVICE_ZONES.length)
  .refine(
    (zones) => new Set(zones).size === zones.length,
    'Service zones must be unique after normalization',
  )
  .transform((zones) => [...zones].sort());

export const createRiderSchema = z
  .object({
    code,
    name,
    serviceZones,
    currentZone: serviceZoneSchema,
    availability: availability.default('AVAILABLE'),
    capacityUnits: capacity,
  })
  .strict();
export const updateRiderSchema = z
  .object({
    name: name.optional(),
    serviceZones: serviceZones.optional(),
    currentZone: serviceZoneSchema.optional(),
    availability: availability.optional(),
    capacityUnits: capacity.optional(),
  })
  .strict()
  .refine(
    (input) => Object.keys(input).length > 0,
    'Supply at least one rider configuration field',
  );
export const listRidersSchema = paginationSchema
  .extend({
    code: code.optional(),
    availability: availability.optional(),
    zone: serviceZoneSchema.optional(),
  })
  .strict();
export type CreateRiderInput = z.infer<typeof createRiderSchema>;
export type UpdateRiderInput = z.infer<typeof updateRiderSchema>;
export type ListRidersInput = z.infer<typeof listRidersSchema>;
