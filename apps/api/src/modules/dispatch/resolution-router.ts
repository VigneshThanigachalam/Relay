import { Router } from 'express';
import { z } from 'zod';
import { actorSchema, emptyObjectSchema, objectIdSchema } from '../../http/contracts.js';
import type { ResolutionService } from './resolution.js';

export const rejectAssignmentSchema = z
  .object({ reason: z.string().trim().min(1).max(500) })
  .strict();
export function createResolutionRouter(resolution: ResolutionService) {
  const router = Router();
  for (const action of ['accept', 'reject'] as const)
    router.post(`/:assignmentId/${action}`, async (req, res) => {
      const id = objectIdSchema.parse(req.params.assignmentId);
      const headers = z
        .object({ 'x-actor-id': actorSchema })
        .parse({ 'x-actor-id': req.get('X-Actor-Id') });
      emptyObjectSchema.parse(req.query);
      if (action === 'accept') {
        emptyObjectSchema.parse(req.body);
        res.json(await resolution.accept(id, headers['x-actor-id']));
      } else {
        const input = rejectAssignmentSchema.parse(req.body);
        res.json(await resolution.reject(id, input.reason, headers['x-actor-id']));
      }
    });
  return router;
}
