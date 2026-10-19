import { createHash } from 'node:crypto';
import { z } from 'zod';
import { actorSchema, objectIdSchema } from '../../http/contracts.js';

export const assignmentHeadersSchema = z.object({
  'x-actor-id': actorSchema,
  'idempotency-key': z.string().trim().min(1).max(128),
});
export const assignJobSchema = z
  .object({
    riderId: objectIdSchema.transform((id) => id.toLowerCase()),
    overrideReason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
export type AssignJobInput = z.infer<typeof assignJobSchema>;

export function hashAssignmentRequest(input: AssignJobInput): string {
  // Keys are scoped to a job. Actor changes do not change the command; the first
  // successful attempt retains its original actor and immutable load snapshot.
  return createHash('sha256')
    .update(
      JSON.stringify({ riderId: input.riderId, overrideReason: input.overrideReason ?? null }),
    )
    .digest('hex');
}
